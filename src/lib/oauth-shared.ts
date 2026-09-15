// The OAuth vocabulary shared by the authorization server (lib/oauth), the client registry
// (lib/oauth-clients), the session resolver and the /mcp route: the error type, scopes, lifetimes,
// PKCE, the resource identifier and the two discovery documents.
//
// Why an authorization server lives in this app at all: ChatGPT — and any client that follows the
// MCP authorization specification — cannot be handed a static Bearer. It discovers an authorization
// server from the 401 that /mcp answers, sends the person through a browser sign-in and a consent
// page, and exchanges the authorization code it is handed back for an access token that it then
// presents on /mcp. The simplest correct home for that server is next to the resource it protects:
// same accounts, same database, same immediate revocation as sessions and publish tokens.
import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { forwardedProto, type HeaderBag } from "@/lib/http";
import { readOnlyMcpTools } from "@/lib/mcp-tools";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "@/lib/publish-token";
import { policy } from "@/lib/settings";

export { OAUTH_ACCESS_TOKEN_PREFIX };
export const OAUTH_REFRESH_TOKEN_PREFIX = "ahr_";

/** How long the consent page may sit open before the request has to be started again. */
export const CONSENT_TTL_MS = 10 * 60 * 1000;
/** An authorization code is single-use and redeemed within seconds in practice. */
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
/** Short on purpose: a leaked access token is worth an hour. The refresh token keeps the client going. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Sliding: every refresh issues a new refresh token good for another window … */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** … under a ceiling fixed at consent, exactly like browser sessions: without it a stolen refresh
 *  token renews itself forever. */
export const GRANT_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** How long after a rotation a replay of the retired refresh token, from the same client, is
 *  read as a parallel refresh rather than as theft (OAuth 2.1 §4.3.1 leaves the response to the
 *  server; a short window is the usual answer). */
export const ROTATION_GRACE_MS = 30 * 1000;

export const SCOPE_READ = "artifacts:read";
export const SCOPE_WRITE = "artifacts:write";
/** Everything a personal token can do, split at the one line that matters: reading versus changing. */
export const SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

/** An OAuth-shaped failure: `code` is the RFC 6749 error code the client keys on, the message is
 *  the `error_description`. The status is what the endpoint answers with (401 for invalid_client). */
export class OauthError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, description: string, statusCode = 400) {
    super(description);
    this.name = "OauthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseScopeList(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * Requested → granted. Only the scopes this server defines are granted; anything else a client
 * asks for (`openid`, `email`, a scope of some other product) is ignored rather than refused —
 * OAuth lets the server narrow the request, and the client learns what it actually got from the
 * `scope` in the token response. A request that names none of ours gets the full default set: an
 * MCP client has no domain knowledge to pick from, and the consent page shows exactly what is granted.
 */
export function grantedScopes(requested: string | null | undefined): string[] {
  const known = parseScopeList(requested ?? "").filter((s) => SCOPES.includes(s));
  return known.length > 0 ? [...new Set(known)] : [...SCOPES];
}

/** The scope a tool call needs, or null for names this server does not gate (the MCP server itself
 *  refuses unknown tools). The same list the server publishes as `readOnlyHint` (lib/mcp-tools). */
export function requiredScopeForTool(name: string): string | null {
  if (!name.startsWith("artifact_site_")) return null;
  return readOnlyMcpTools.has(name) ? SCOPE_READ : SCOPE_WRITE;
}

// --- PKCE (RFC 7636), S256 only — the one method OAuth 2.1 and the MCP spec allow ---------------

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_RE.test(challenge);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return VERIFIER_RE.test(verifier) && safeEqual(pkceChallenge(verifier), challenge);
}

// --- issuer and resource ---------------------------------------------------------------------

// A hostname, optionally with a port — nothing else (the header is attacker-supplied on an exposed app port).
const HOST_RE = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;

/**
 * The one rule behind both issuer helpers: ARTIFACT_PUBLIC_URL when set (always, behind a proxy);
 * otherwise the Host the request carried, with the scheme the proxy recorded. The two helpers MUST
 * agree — the consent page stores the resource a token is bound to, and every route compares
 * against it — so neither may add a fallback the other lacks.
 */
function issuerFromParts(host: string | null | undefined, proto: string): string | null {
  if (config.publicUrl) return config.publicUrl;
  if (!host || !HOST_RE.test(host)) return null;
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

/**
 * The authorization server's identity, and the origin every token is bound to, for a route
 * handler. Without ARTIFACT_PUBLIC_URL the address this request arrived on, so a local checkout
 * can be exercised without configuration. Next itself sets `x-forwarded-proto` on every request
 * it serves, so the scheme here matches what the consent page sees (issuerFromHeaders).
 */
export function issuerFor(request: Request): string {
  const url = new URL(request.url);
  return issuerFromParts(request.headers.get("host"), forwardedProto(request.headers) || url.protocol.slice(0, -1)) ?? url.origin;
}

/**
 * The same answer for a server component, which has headers but no Request. Null only when
 * ARTIFACT_PUBLIC_URL is unset AND the request carries no usable Host — the page then says so
 * instead of guessing a scheme that /mcp would not agree with.
 */
export function issuerFromHeaders(bag: HeaderBag): string | null {
  return issuerFromParts(bag.get("host"), forwardedProto(bag) || "http");
}

/** The canonical resource identifier of the MCP server (RFC 8707 / RFC 9728): the endpoint itself. */
export function canonicalResource(issuer: string): string {
  return `${issuer}/mcp`;
}

/**
 * The `resource` a client asks a token for, reduced to the one value this server issues tokens
 * for — or null when it names something else. Both the endpoint and its origin are accepted (the
 * spec allows either; ChatGPT sends the origin); a fragment, another host or another path is not.
 * Absent means "this server", which is the only thing a token from here can ever be used with.
 */
export function normalizeResource(raw: string | null | undefined, issuer: string): string | null {
  if (!raw) return canonicalResource(issuer);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.search || url.username || url.password) return null;
  const candidate = url.href.replace(/\/+$/, "");
  return candidate === issuer || candidate === canonicalResource(issuer) ? canonicalResource(issuer) : null;
}

export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

// --- discovery documents ---------------------------------------------------------------------

/** RFC 9728 — served at /.well-known/oauth-protected-resource (and /mcp under it). */
export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: canonicalResource(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SCOPES],
    resource_name: "artifact-site",
    resource_documentation: `${issuer}/for-agents`,
  };
}

/**
 * RFC 8414 — served at /.well-known/oauth-authorization-server. The `openid` variant is the same
 * document at /.well-known/openid-configuration for clients that only try OpenID discovery; the
 * three extra fields are what that document format requires, and this server issues no ID tokens.
 */
export function authorizationServerMetadata(issuer: string, variant: "oauth" | "openid" = "oauth"): Record<string, unknown> {
  const methods = ["none", "client_secret_post", "client_secret_basic"];
  const doc: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    ...(policy.oauth.dcrEnabled ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/for-agents`,
  };
  if (variant === "openid") {
    Object.assign(doc, {
      jwks_uri: `${issuer}/oauth/jwks`,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  return doc;
}

/**
 * The discovery documents are public and read by clients that may run in a browser (the MCP SDK
 * sends its protocol-version header, which forces a preflight), so they carry permissive CORS.
 * Nothing here is secret or personalised, and the documents never vary by caller.
 */
export const DISCOVERY_CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function discoveryResponse(document: Record<string, unknown>): Response {
  return Response.json(document, { headers: { ...DISCOVERY_CORS_HEADERS, "cache-control": "public, max-age=300" } });
}

export function discoveryPreflight(): Response {
  return new Response(null, { status: 204, headers: DISCOVERY_CORS_HEADERS });
}

/**
 * The `WWW-Authenticate` value /mcp answers with. `resource_metadata` is how a client finds the
 * authorization server (RFC 9728 §5.1); `scope` tells it what to ask for, so the consent page can
 * show the full set instead of a step-up dance later.
 */
export function bearerChallenge(issuer: string, opts: { error?: "invalid_token" | "insufficient_scope"; description?: string; scope?: string } = {}): string {
  const quote = (value: string) => `"${value.replace(/["\\]/g, "").replace(/[\r\n]/g, " ")}"`;
  const parts = [`realm=${quote("artifact-site")}`];
  if (opts.error) parts.push(`error=${quote(opts.error)}`);
  if (opts.description) parts.push(`error_description=${quote(opts.description)}`);
  parts.push(`resource_metadata=${quote(resourceMetadataUrl(issuer))}`);
  parts.push(`scope=${quote(opts.scope ?? SCOPES.join(" "))}`);
  return `Bearer ${parts.join(", ")}`;
}
