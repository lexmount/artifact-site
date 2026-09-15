// Thin publish-layer auth gate (K5) — PUBLISH_API_TOKEN unset ⇒ open (dev/tests);
// set ⇒ every mutation route requires a Bearer token (timing-safe compare) or 401.
import { config } from "@/lib/config";
import { policy as policySettings } from "@/lib/settings";
import { safeEqual } from "@/lib/crypto";
import { oauthAccessTokenFromRequest, publishTokenFromRequest } from "@/lib/publish-token";
import type { Session } from "@/lib/types";

export class AuthError extends Error {
  readonly statusCode = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

/** Per-site edit gate failure — the caller lacks this site's edit token. 403 (identified, not allowed). */
export class EditForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = "You do not have edit access to this site (an editable link is required)") {
    super(message);
    this.name = "EditForbiddenError";
  }
}

/**
 * An OAuth access token (lib/oauth) whose grant does not cover this request — a read-only
 * connection trying to publish. 403 in the OAuth vocabulary (`insufficient_scope`, RFC 6750 §3.1),
 * so the client can ask the person for the missing scope instead of retrying.
 */
export class InsufficientScopeError extends Error {
  readonly statusCode = 403;
  readonly code = "insufficient_scope";
  readonly scope: string;
  constructor(scope: string) {
    super(`This connection was authorized for reading only; authorize it again with ${scope} to make changes`);
    this.name = "InsufficientScopeError";
    this.scope = scope;
  }
}

function authEnabled(): boolean {
  return Boolean(config.publishApiToken);
}

/** Call at the top of every mutation route. Throws AuthError (statusCode 401) on failure. */
function assertAuthorized(request: Request): void {
  if (!authEnabled()) return;
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !safeEqual(token, config.publishApiToken)) throw new AuthError();
}

/** The edit token a request carries: `x-edit-token` header (preferred) or `?t=` query. "" if none. */
export function editTokenFromRequest(request: Request): string {
  const header = request.headers.get("x-edit-token");
  if (header) return header.trim();
  try {
    return new URL(request.url).searchParams.get("t")?.trim() ?? "";
  } catch {
    return "";
  }
}

/** True if the global PUBLISH_API_TOKEN is set and the request's Bearer matches it (admin override). */
export function isAdmin(request: Request): boolean {
  if (!authEnabled()) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return Boolean(bearer) && safeEqual(bearer, config.publishApiToken);
}

/** Admin-only gate (destructive ops like the orphan reconciler). Requires PUBLISH_API_TOKEN to be
 *  set AND a matching Bearer — an open (no-token) deploy has no admin, so this always throws there. */
export function assertAdmin(request: Request): void {
  if (!isAdmin(request)) throw new AuthError("Admin token required (set PUBLISH_API_TOKEN and send it as a Bearer token)");
}

/**
 * Creation gate. Anonymous creation is the product's hero flow, so `open` is the normal setting —
 * the site it produces is unowned and read-only until its creator signs in and claims it. `login`
 * and `token` exist for deployments that need to close that door; see config.createPolicy for why
 * the default is fail-closed rather than open.
 */
export async function assertCanCreate(request: Request): Promise<void> {
  const policy = policySettings.createPolicy;
  if (policy === "open") return;
  if (policy === "token") {
    assertAuthorized(request);
    return;
  }
  if (isAdmin(request)) return;
  const { resolveSession } = await import("@/lib/session");
  if (!(await resolveSession(request))) throw new AuthError("Please sign in before creating a site");
}

/**
 * A publish token this server will not honour, and why. The two causes need different advice:
 * a REVOKED token wants a fresh authorisation here; an UNKNOWN token was almost always issued by
 * a different deployment (tokens are per server) — the right move is to authorise on this one
 * and keep the other server's token, not to overwrite it. Agents key on `code`.
 */
export class TokenRejectedError extends AuthError {
  readonly code: "token_unknown" | "token_revoked" | "token_expired";
  constructor(code: "token_unknown" | "token_revoked" | "token_expired", message: string) {
    super(message);
    this.name = "TokenRejectedError";
    this.code = code;
  }
}

/**
 * A presented-but-dead publish token must fail loudly, never quietly fall through to the anonymous
 * path. Without this, an agent whose token was revoked keeps "publishing" — as unowned anonymous
 * sites — while believing they are born owned, and gets no signal that its credential died. Only
 * the OPEN routes (create / fork / auth-me) need this; gated routes already fail closed at
 * authorization. One extra lookup, and only on the failure path, to tell the two causes apart.
 */
export async function assertPresentedBearerAlive(request: Request, session: Session | null): Promise<void> {
  if (session) return;
  // The same rule for an OAuth access token: presented and dead must be answered, not ignored.
  const oauthBearer = oauthAccessTokenFromRequest(request);
  if (oauthBearer) {
    const { describeOauthAccessToken } = await import("@/lib/oauth");
    const { issuerFor } = await import("@/lib/oauth-shared");
    const state = await describeOauthAccessToken(oauthBearer, issuerFor(request));
    const again = "Authorize the connection again from the MCP client (it sends you through this server's sign-in), or remove the authorization header to publish anonymously.";
    if (state === "revoked") throw new TokenRejectedError("token_revoked", `This OAuth access token was revoked: the connection was disconnected from the account page, or the account was disabled. ${again}`);
    if (state === "expired") throw new TokenRejectedError("token_expired", `This OAuth access token has expired. Refresh it with the refresh token, or authorize the connection again from the MCP client.`);
    throw new TokenRejectedError("token_unknown", `This server does not know this OAuth access token: it was issued by another deployment, or for another address of this one. ${again}`);
  }
  const bearer = publishTokenFromRequest(request);
  if (!bearer) return;
  const { getPublishToken } = await import("@/lib/db");
  const { hashTokenSecret } = await import("@/lib/publish-token");
  const token = await getPublishToken(hashTokenSecret(bearer));
  const unknown = () => new TokenRejectedError("token_unknown",
    "This server does not know this publish token. Tokens are issued per server, so it was most likely obtained from a different artifact-site deployment: complete device authorization on THIS server (POST /api/device/start) and store the result under this host, keeping the other server's token where it is. Or remove the authorization header to publish anonymously.");
  if (!token) throw unknown();
  if (token.revokedAt != null) {
    throw new TokenRejectedError("token_revoked",
      "This publish token was revoked (from the account page, or because the account was disabled). Complete device authorization again (POST /api/device/start) to get a new one, or remove the authorization header to publish anonymously.");
  }
  // Known and live, yet resolveSession produced no session: only a revoke that landed between the
  // two lookups gets here. Say "unknown" rather than guess — the caller's next attempt will see
  // the settled state and the precise reason.
  throw unknown();
}
