import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteMcpServer } from "@/lib/mcp/server";
import { isAdmin } from "@/lib/auth";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { sha256hex } from "@/lib/crypto";
import { rateLimit } from "@/lib/config";
import { clientKey, withRateLimitChecked, checkRateLimit } from "@/lib/ratelimit";
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
    const authorization = request.headers.get("authorization");
    const identity = new Request(request.url, { headers: authorization ? { authorization } : {} });
    if (!authorization?.startsWith("Bearer ") || (!isAdmin(identity) && !await resolveSession(identity))) {
      return Response.json({ error: "A valid personal or operator Bearer token is required" }, { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } });
    }
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) { try { for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > MCP_BODY_BYTES) { void reader.cancel().catch(() => {}); return Response.json({ error: "MCP request exceeds 2 MiB; use file chunks" }, { status: 413 }); }
      chunks.push(value);
    } } finally { reader.releaseLock(); } }
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // Byte transfer gets its own budget; metadata/mutations retain the ordinary operation budget.
    const transfer = parsedBody?.method === "tools/call" && (parsedBody?.params?.name === "artifact_site_upload_write" || (parsedBody?.params?.name === "artifact_site_export" && typeof parsedBody?.params?.arguments?.path === "string"));
    const scale = transfer ? 12 : 1;
    checkRateLimit(request, Date.now(), `mcp-${transfer ? "transfer" : "operation"}:${sha256hex(authorization)}`, rateLimit.burst * scale, rateLimit.perMin * scale);
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
