// The authorization server behind /mcp: consent, authorization codes, access and refresh tokens.
// The vocabulary and the discovery documents live in lib/oauth-shared; clients in lib/oauth-clients.
//
// Everything issued here follows the session model: the bearer secret exists once, in the token
// response; the database stores sha256 only, and the sha256 IS the row id. Tokens are opaque, not
// JWTs, because "disconnect" on the account page has to bite on the very next request — exactly
// as revoking a publish token does — and a self-contained token cannot be un-issued.
import "server-only";
import { randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { sha256hex } from "@/lib/crypto";
import {
  approveOauthAuthorization, consumeOauthAuthorization, consumeOauthRefreshToken, getOauthAuthorization, getOauthToken, getUser,
  insertOauthAuthorization, insertOauthTokens, redeemOauthCode, revokeOauthGrant, revokeOauthGrantsForClient, revokeOauthToken, touchOauthToken,
} from "@/lib/db";
import { matchRedirectUri, noteClientUse, redirectAllowed, resolveOauthClient, validateRedirectUri, type OauthClient } from "@/lib/oauth-clients";
import {
  ACCESS_TOKEN_TTL_MS, AUTHORIZATION_CODE_TTL_MS, CONSENT_TTL_MS, DISCOVERY_CORS_HEADERS, GRANT_ABSOLUTE_MS, OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX, OauthError, REFRESH_TOKEN_TTL_MS, ROTATION_GRACE_MS, canonicalResource, grantedScopes, isValidCodeChallenge,
  normalizeResource, parseScopeList, verifyPkce,
} from "@/lib/oauth-shared";
import { isTokenSession } from "@/lib/publish-token";
import { RateLimitError } from "@/lib/ratelimit";
import type { OauthToken, Session } from "@/lib/types";

/** Don't write last_used_at on every request — only once it has moved materially (as sessions do). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PARAM_CHARS = 2048;
const MAX_BODY_CHARS = 16 * 1024;

// --- authorization request → consent → code -------------------------------------------------------

export type AuthorizationOutcome =
  /** Something we could not verify: rendered by us, and NOTHING is sent to the redirect address. */
  | { kind: "invalid"; title: string; message: string }
  /** A well-formed request we refuse: the client learns why at its own redirect_uri (RFC 6749 §4.1.2.1). */
  | { kind: "redirect"; location: string }
  /** Valid, but nobody is signed in: send the person through the IdP and back here. */
  | { kind: "login" }
  /** Valid and signed in: show the consent page for this pending request. */
  | { kind: "consent"; requestId: string; client: OauthClient; scopes: string[]; redirectUri: string; resource: string };

function withParams(target: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.href;
}

function param(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value == null) return null;
  if (value.length > MAX_PARAM_CHARS) throw new OauthError("invalid_request", `${name} is too long`);
  return value;
}

/**
 * Validate an authorization request (RFC 6749 §4.1.1 + PKCE + RFC 8707) and, once someone is
 * signed in, record it as a pending consent. The order of checks is the security model: the
 * client and its redirect address are verified BEFORE anything can be redirected, so an attacker
 * cannot use this endpoint to bounce a browser somewhere of their choosing — every later refusal
 * goes back to a registered address, as the spec requires, never to an arbitrary one.
 */
export async function prepareAuthorization(params: URLSearchParams, session: Session | null, issuer: string, now = Date.now()): Promise<AuthorizationOutcome> {
  const invalid = (title: string, message: string): AuthorizationOutcome => ({ kind: "invalid", title, message });
  if (!config.oidcEnabled) return invalid("Sign-in is not configured", "This server has no identity provider, so it cannot authorize applications. Ask the operator to configure OIDC sign-in first.");
  let clientId: string, redirectRaw: string, state: string | null, challenge: string, method: string | null, resourceRaw: string | null, scopeRaw: string | null, responseType: string | null;
  try {
    clientId = param(params, "client_id")?.trim() ?? "";
    redirectRaw = param(params, "redirect_uri") ?? "";
    state = param(params, "state");
    challenge = param(params, "code_challenge") ?? "";
    method = param(params, "code_challenge_method");
    resourceRaw = param(params, "resource");
    scopeRaw = param(params, "scope");
    responseType = param(params, "response_type");
  } catch (error) {
    return invalid("Invalid authorization request", (error as Error).message);
  }
  if (!clientId) return invalid("Invalid authorization request", "The request names no client_id.");
  let client: OauthClient | null;
  try {
    client = await resolveOauthClient(clientId, now);
  } catch (error) {
    if (error instanceof OauthError) return invalid("Unknown application", error.message);
    throw error;
  }
  if (!client) return invalid("Unknown application", "This server does not know the application that sent you here (its client_id is not registered).");
  const redirectUri = matchRedirectUri(client.redirectUris, redirectRaw);
  if (!redirectUri) return invalid("Invalid redirect address", `${client.name} asked to be sent back to an address it did not register. Nothing was sent to it.`);
  if (!redirectAllowed(redirectUri)) return invalid("Invalid redirect address", `${client.name} asked to be sent back to an address this server does not allow. Nothing was sent to it.`);
  const back = (error: string, description: string): AuthorizationOutcome => ({ kind: "redirect", location: withParams(redirectUri, { error, error_description: description, state, iss: issuer }) });
  if (responseType !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  if (!isValidCodeChallenge(challenge)) return back("invalid_request", "code_challenge is required (PKCE with S256)");
  // A missing method means S256 here: verification only ever hashes, so a `plain` client fails at the token endpoint rather than being let through.
  if (method !== null && method !== "S256") return back("invalid_request", "Only the S256 code_challenge_method is supported");
  const resource = normalizeResource(resourceRaw, issuer);
  if (!resource) return back("invalid_target", `resource must identify this server: ${canonicalResource(issuer)}`);
  const scopes = grantedScopes(scopeRaw);
  if (!session) return { kind: "login" };
  if (isTokenSession(session)) return invalid("Sign in in the browser", "Authorizing an application needs a browser sign-in; a session carried by a token cannot approve it.");
  const requestId = randomBytes(32).toString("base64url");
  await insertOauthAuthorization({
    id: requestId, clientId: client.id, clientName: client.name, redirectUri, scope: scopes.join(" "), state,
    codeChallenge: challenge, resource, userId: session.userId, codeHash: null, grantId: null,
    createdAt: now, expiresAt: now + CONSENT_TTL_MS, approvedAt: null, consumedAt: null,
  });
  await noteClientUse(client, now);
  return { kind: "consent", requestId, client, scopes, redirectUri, resource };
}

/**
 * The person's answer on the consent page. Allow mints the authorization code (its hash goes on
 * the row; the code itself exists only in the redirect) and settles the request exactly once;
 * deny tells the client so at its redirect address. The request must belong to the signed-in
 * account — a consent form cannot be handed to somebody else to approve.
 */
export async function decideAuthorization(input: { requestId: string; decision: "allow" | "deny" }, session: Session, issuer: string, now = Date.now()): Promise<{ location: string }> {
  const gone = () => new OauthError("invalid_request", "This authorization request is unknown, already answered or has expired. Start again from the application.");
  const auth = input.requestId ? await getOauthAuthorization(input.requestId) : null;
  if (!auth || auth.userId !== session.userId || auth.approvedAt != null || auth.consumedAt != null || auth.expiresAt <= now) throw gone();
  if (input.decision !== "allow") {
    await consumeOauthAuthorization(auth.id, now);
    return { location: withParams(auth.redirectUri, { error: "access_denied", error_description: "The user declined the request", state: auth.state, iss: issuer }) };
  }
  const code = randomBytes(32).toString("base64url");
  const grantId = `grant_${randomBytes(16).toString("base64url")}`;
  const approved = await approveOauthAuthorization(auth.id, session.userId, { codeHash: sha256hex(code), grantId, expiresAt: now + AUTHORIZATION_CODE_TTL_MS }, now);
  if (!approved) throw gone();
  return { location: withParams(auth.redirectUri, { code, state: auth.state, iss: issuer }) };
}

// --- tokens -------------------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(input: { userId: string; client: OauthClient; scope: string; resource: string; grantId: string; grantCreatedAt: number; absoluteExpiresAt: number; now: number }): Promise<TokenResponse> {
  const { now } = input;
  const access = OAUTH_ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const refresh = OAUTH_REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const shared = {
    grantId: input.grantId, userId: input.userId, clientId: input.client.id, clientName: input.client.name, scope: input.scope,
    resource: input.resource, grantCreatedAt: input.grantCreatedAt, createdAt: now, absoluteExpiresAt: input.absoluteExpiresAt,
    lastUsedAt: null, revokedAt: null,
  };
  const accessRow: OauthToken = { ...shared, id: sha256hex(access), kind: "access", expiresAt: Math.min(now + ACCESS_TOKEN_TTL_MS, input.absoluteExpiresAt) };
  const refreshRow: OauthToken = { ...shared, id: sha256hex(refresh), kind: "refresh", expiresAt: Math.min(now + REFRESH_TOKEN_TTL_MS, input.absoluteExpiresAt) };
  await insertOauthTokens([accessRow, refreshRow]);
  return { access_token: access, token_type: "Bearer", expires_in: Math.max(1, Math.floor((accessRow.expiresAt - now) / 1000)), refresh_token: refresh, scope: input.scope };
}

/**
 * grant_type=authorization_code. The code is consumed before anything else is checked, so a
 * failed exchange burns it; a code presented twice revokes every token minted from it (OAuth 2.1
 * §4.1.3: the replay is evidence that the code leaked, and the first redeemer may be the thief).
 */
export async function exchangeAuthorizationCode(client: OauthClient, input: { code: string | null; codeVerifier: string | null; redirectUri: string | null; resource: string | null }, issuer: string, now = Date.now()): Promise<TokenResponse> {
  if (!input.code) throw new OauthError("invalid_request", "code is required");
  if (!input.codeVerifier) throw new OauthError("invalid_request", "code_verifier is required (PKCE)");
  const denied = (why: string) => new OauthError("invalid_grant", why);
  const redeemed = await redeemOauthCode(sha256hex(input.code), now);
  if (!redeemed) throw denied("The authorization code is invalid or has expired");
  const auth = redeemed.authorization;
  if (redeemed.reused) {
    if (auth.grantId) await revokeOauthGrant(auth.grantId, now);
    throw denied("The authorization code was already used; the tokens it produced have been revoked");
  }
  if (auth.clientId !== client.id) throw denied("The authorization code was issued to a different client");
  const redirectUri = validateRedirectUri(input.redirectUri);
  if (!redirectUri || redirectUri !== auth.redirectUri) throw denied("redirect_uri does not match the authorization request");
  if (!verifyPkce(input.codeVerifier, auth.codeChallenge)) throw denied("PKCE verification failed");
  if (input.resource && normalizeResource(input.resource, issuer) !== auth.resource) throw new OauthError("invalid_target", "resource does not match the authorization request");
  await assertAccountActive(auth.userId);
  // A dynamically registered client_id is minted per install, so a second consent from the same
  // id really is a replacement: retire the previous grant, and "Connected applications" shows
  // what is in use rather than a trail of reconnections. A metadata-document client_id is one
  // document per APPLICATION (Claude's, say), shared by every install a person runs — superseding
  // there would have two machines revoking each other on every consent. Those stay side by side.
  if (client.kind === "registered") await revokeOauthGrantsForClient(auth.userId, client.id, now, auth.grantId!);
  await noteClientUse(client, now);
  return issueTokens({
    userId: auth.userId, client, scope: auth.scope, resource: auth.resource, grantId: auth.grantId!,
    grantCreatedAt: auth.approvedAt ?? now, absoluteExpiresAt: now + GRANT_ABSOLUTE_MS, now,
  });
}

/** Disabling an account revoked its sessions and tokens; a code approved just before, or a
 *  refresh token that was still in flight, must not mint new ones afterwards. */
async function assertAccountActive(userId: string): Promise<void> {
  const user = await getUser(userId);
  if (!user || user.disabledAt != null) throw new OauthError("invalid_grant", "The account is disabled");
}

/**
 * grant_type=refresh_token, with rotation: the presented token is retired and a new pair issued
 * under the same grant and the same ceiling. A retired refresh token presented again is treated
 * as theft and ends the grant (OAuth 2.1 §4.3.1). Scope may only narrow.
 */
export async function refreshTokens(client: OauthClient, input: { refreshToken: string | null; scope: string | null; resource: string | null }, issuer: string, now = Date.now()): Promise<TokenResponse> {
  const denied = (why: string) => new OauthError("invalid_grant", why);
  if (!input.refreshToken?.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) throw denied("refresh_token is missing or not one this server issued");
  const consumed = await consumeOauthRefreshToken(sha256hex(input.refreshToken), now);
  if (!consumed) throw denied("The refresh token is invalid or has expired; authorize again");
  const { token, reused } = consumed;
  if (reused) {
    // Replay means theft — except in the first moments after a rotation, when it is far more
    // likely an honest client's parallel calls all hit the hour boundary at once and raced each
    // other to refresh (the SDK transport has no refresh lock). Within that window the loser is
    // simply told to use the pair the winner got; ending the grant would send the person back to
    // the consent page for nothing. The window is a matter of time, not of identity: for a public
    // client the client_id proves nothing (anyone may present ChatGPT's), so the comparison below
    // only rules out a caller that names a DIFFERENT client — that one fails hard regardless.
    if (token.clientId === client.id && token.revokedAt != null && now - token.revokedAt < ROTATION_GRACE_MS) {
      throw denied("This refresh token was just rotated; use the tokens that rotation returned");
    }
    await revokeOauthGrant(token.grantId, now);
    throw denied("The refresh token was already used; the connection has been revoked. Authorize again.");
  }
  if (token.clientId !== client.id) {
    await revokeOauthGrant(token.grantId, now);
    throw denied("The refresh token was issued to a different client; the connection has been revoked");
  }
  if (token.absoluteExpiresAt <= now) throw denied("The connection has reached its maximum age; authorize again");
  await assertAccountActive(token.userId);
  const held = parseScopeList(token.scope);
  let scope = token.scope;
  if (input.scope) {
    const wanted = parseScopeList(input.scope);
    if (wanted.length === 0 || wanted.some((s) => !held.includes(s))) throw new OauthError("invalid_scope", "A refresh may only narrow the granted scope");
    scope = wanted.join(" ");
  }
  if (input.resource && normalizeResource(input.resource, issuer) !== token.resource) throw new OauthError("invalid_target", "resource does not match the grant");
  // Rotation retires the whole previous pair, not only the refresh token: the old access token
  // would otherwise keep its (possibly wider) scope alive for up to an hour, and a grant with
  // exactly one live pair is also what lets the account page list grants by their refresh token.
  await revokeOauthGrant(token.grantId, now);
  await noteClientUse(client, now);
  return issueTokens({
    userId: token.userId, client, scope, resource: token.resource, grantId: token.grantId,
    grantCreatedAt: token.grantCreatedAt, absoluteExpiresAt: token.absoluteExpiresAt, now,
  });
}

/**
 * RFC 7009. Always succeeds from the client's point of view (a token that does not exist is
 * already as revoked as it gets). A refresh token takes the whole grant with it; an access
 * token only itself. Tokens belonging to another client are left alone — and unmentioned.
 */
export async function revokeToken(client: OauthClient, token: string | null, now = Date.now()): Promise<void> {
  if (!token) return;
  const row = await getOauthToken(sha256hex(token));
  if (!row || row.clientId !== client.id || row.revokedAt != null) return;
  if (row.kind === "refresh") await revokeOauthGrant(row.grantId, now);
  else await revokeOauthToken(row.id, now);
}

/**
 * The access token behind an `aho_` bearer, if it is live and was minted for THIS server (RFC 8707
 * audience check: a token issued when the deployment answered to another address is refused,
 * which is what makes ARTIFACT_PUBLIC_URL load-bearing here). Touches last_used_at at most once
 * per interval. Used by lib/session to fold the token into a session.
 */
export async function resolveOauthAccessToken(secret: string, issuer: string, now = Date.now()): Promise<OauthToken | null> {
  const token = await getOauthToken(sha256hex(secret));
  if (!token || token.kind !== "access" || token.revokedAt != null || token.expiresAt <= now) return null;
  if (token.resource !== canonicalResource(issuer)) return null;
  if (!token.lastUsedAt || now - token.lastUsedAt > TOUCH_INTERVAL_MS) await touchOauthToken(token.id, now);
  return token;
}

export type OauthTokenState = "alive" | "unknown" | "revoked" | "expired" | "foreign";

/** Why a presented access token was refused — for the error message, after the fact. */
export async function describeOauthAccessToken(secret: string, issuer: string, now = Date.now()): Promise<OauthTokenState> {
  const token = await getOauthToken(sha256hex(secret));
  if (!token || token.kind !== "access") return "unknown";
  if (token.revokedAt != null) return "revoked";
  if (token.expiresAt <= now) return "expired";
  if (token.resource !== canonicalResource(issuer)) return "foreign";
  return "alive";
}

// --- HTTP shapes shared by the token, registration and revocation routes -------------------------

/**
 * At most `max` bytes of the body, refused BEFORE the rest is buffered: these endpoints are
 * unauthenticated, so the ceiling has to bite on bytes as they arrive, not on a length header
 * the caller controls. Shared by the token, revocation and registration endpoints.
 */
export async function readBounded(request: Request, max: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        throw new OauthError("invalid_request", "The request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The token endpoint's body: form-encoded per RFC 6749, with JSON tolerated for hand-written clients. */
export async function readTokenRequest(request: Request): Promise<URLSearchParams> {
  const text = await readBounded(request, MAX_BODY_CHARS);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OauthError("invalid_request", "The request body is not valid JSON");
    }
    const params = new URLSearchParams();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
      }
    }
    return params;
  }
  return new URLSearchParams(text);
}

/** Token-endpoint shaped: never cached, and reachable from a browser-hosted client (no cookies are involved). */
export function noStoreJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...DISCOVERY_CORS_HEADERS, "cache-control": "no-store", pragma: "no-cache", ...headers } });
}

/**
 * A browser navigation that failed — the consent form's POST, or a decision that arrived without a
 * session. Answered with a page, not JSON: a person is looking at it. Mirrors lib/oidc-callback.
 */
export function authorizationFailurePage(error: unknown): Response {
  const status = error instanceof OauthError ? error.statusCode
    : error instanceof RateLimitError ? 429
    : error && typeof error === "object" && "statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode
    : 500;
  if (status >= 500) console.error("[oauth-consent]", error);
  const message = status >= 500 ? "Something went wrong while answering the request. Please start again from the application." : (error as Error).message;
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorization did not complete — artifact-site</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;font:400 15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#fdfdfd;color:#171a17}
main{max-width:26rem;padding:2rem}h1{font-size:1.4rem;font-weight:600;margin:0 0 .6rem}p{margin:0 0 1.2rem;color:#626862}
a{display:inline-block;margin-right:.8rem;padding:.55rem .9rem;border:1px solid #e3e7e1;border-radius:7px;color:#171a17;text-decoration:none;font-weight:500;font-size:.9rem}</style></head>
<body><main><h1>Authorization did not complete</h1><p>${safe}</p><a href="/">Back to home</a></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** RFC 6749 §5.2 error bodies. Anything that is not an OAuth error is an internal fault: logged, answered generically. */
export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OauthError) return noStoreJson({ error: error.code, error_description: error.message }, error.statusCode);
  if (error instanceof RateLimitError) return noStoreJson({ error: "temporarily_unavailable", error_description: error.message }, 429);
  console.error("[oauth]", error);
  return noStoreJson({ error: "server_error", error_description: "Something went wrong; please try again" }, 500);
}
