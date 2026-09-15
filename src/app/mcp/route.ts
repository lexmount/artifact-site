import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteMcpServer } from "@/lib/mcp/server";
import { isAdmin } from "@/lib/auth";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { sha256hex } from "@/lib/crypto";
import { rateLimit } from "@/lib/config";
import { clientKey, withRateLimitChecked, checkRateLimit } from "@/lib/ratelimit";
import { bearerChallenge, issuerFor, requiredScopeForTool, SCOPES } from "@/lib/oauth-shared";
import { errorResponse } from "@/app/api/_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MCP_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    if (request.headers.has("origin") && !isSameOrigin(request)) return Response.json({ error: "Cross-site request rejected" }, { status: 403 });
    checkRateLimit(request, Date.now(), `mcp-admission:${clientKey(request)}`, rateLimit.burst * 12, rateLimit.perMin * 12);
    // MCP never rides browser cookies. A credential is validated on EVERY request, including
    // discovery and continuation, so revocation and user isolation need no shared MCP session.
    // Three bearers are accepted, each by its own path: the operator token, an `ahp_` personal
    // token, and an `aho_` OAuth access token issued by this server's own authorization server.
    const authorization = request.headers.get("authorization");
    const identityHeaders: Record<string, string> = {};
    for (const name of ["authorization", "host", "x-forwarded-proto"]) { const value = request.headers.get(name); if (value) identityHeaders[name] = value; }
    // A GET on purpose, whatever this request is: resolveSession refuses a read-only OAuth grant on
    // any other method (that is how it gates writes), and this lookup only asks WHO is calling —
    // the per-tool scope gate below decides what they may do. Forwarding request.method here would
    // 403 every initialize / tools/list from a read-only connection.
    const identity = new Request(request.url, { method: "GET", headers: identityHeaders });
    const presented = Boolean(authorization?.startsWith("Bearer "));
    const admin = presented && isAdmin(identity);
    const session = presented && !admin ? await resolveSession(identity) : null;
    if (!admin && !session) {
      // The challenge is how an OAuth-capable client (ChatGPT, Claude, …) finds its way in:
      // resource_metadata → the discovery documents → sign-in and consent → a token (lib/oauth).
      return Response.json(
        presented
          ? { error: "The Bearer token is invalid, expired or revoked", code: "invalid_token" }
          : { error: "A Bearer token is required: an OAuth access token, a personal token or the operator token", code: "unauthorized" },
        { status: 401, headers: { "www-authenticate": bearerChallenge(issuerFor(request), presented ? { error: "invalid_token" } : {}), "cache-control": "no-store" } },
      );
    }
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) { try { for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > MCP_BODY_BYTES) { void reader.cancel().catch(() => {}); return Response.json({ error: "MCP request exceeds 2 MiB; use file chunks" }, { status: 413 }); }
      chunks.push(value);
    } } finally { reader.releaseLock(); } }
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // An OAuth grant that covers reading only is refused before the tool runs, naming the scope it
    // lacks the way the client expects (RFC 6750 §3.1), so it can ask the person for more instead of retrying.
    if (session?.scopes && parsedBody?.method === "tools/call") {
      const needed = requiredScopeForTool(String(parsedBody?.params?.name ?? ""));
      if (needed && !session.scopes.includes(needed)) {
        return Response.json(
          { error: `This connection was authorized for reading only; authorize it again with ${needed} to use this tool`, code: "insufficient_scope", scope: needed },
          { status: 403, headers: { "www-authenticate": bearerChallenge(issuerFor(request), { error: "insufficient_scope", scope: SCOPES.join(" ") }), "cache-control": "no-store" } },
        );
      }
    }
    // Byte transfer gets its own budget; metadata/mutations retain the ordinary operation budget.
    const transfer = parsedBody?.method === "tools/call" && (parsedBody?.params?.name === "artifact_site_upload_write" || (parsedBody?.params?.name === "artifact_site_export" && typeof parsedBody?.params?.arguments?.path === "string"));
    const scale = transfer ? 12 : 1;
    checkRateLimit(request, Date.now(), `mcp-${transfer ? "transfer" : "operation"}:${sha256hex(authorization ?? "")}`, rateLimit.burst * scale, rateLimit.perMin * scale);
    const server = createRemoteMcpServer(request);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const response = await withRateLimitChecked(() => transport.handleRequest(request, { parsedBody }));
      response.headers.set("cache-control", "no-store");
      return response;
    } finally { await server.close(); }
  } catch (error) { return errorResponse(error); }
}
// Stateless request/response transport: no long-lived SSE session to open or terminate.
export function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
export const DELETE = GET;
