// OIDC relying party (authorization_code + PKCE). Endpoints come from the issuer's discovery
// document, so switching IdP — or putting Feishu/WeCom behind the same one — is configuration.
//
// Background: ARCHITECTURE.md, "Identity".
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { consumeOidcFlow, createOidcFlow } from "@/lib/db";
import { isSecureRequest, readCookie } from "@/lib/http";

const FLOW_TTL_MS = 10 * 60 * 1000;
/** `__Host-` for the same reason as the session cookie: no sibling subdomain may plant one. */
const FLOW_COOKIE_SECURE = "__Host-oidc_flow";
const FLOW_COOKIE_DEV = "oidc_flow";

export class OidcError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OidcError";
    this.statusCode = statusCode;
  }
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  issuer: string;
}

let discoveryCache: { issuer: string; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

/**
 * Every server-side call to the IdP goes through this: a plain fetch with NO timeout hangs until
 * the TCP stack gives up (minutes) whenever the IdP or the pod's route to it stalls — and on the
 * login callback that is a user staring at a blank page on OUR domain, which reads as "the site
 * is stuck", not "the IdP is down". A short deadline turns that into a legible error in seconds.
 *
 * Returns the PARSED body, not the Response: AbortSignal.timeout covers the whole exchange, so a
 * deadline that fires mid-body would otherwise throw its TimeoutError out of the caller's
 * `res.json()` — past this catch — and surface as the generic 500 instead of the message above.
 * The half-dead IdP (headers arrive, body stalls) is exactly the case worth naming.
 */
async function fetchIdp<T>(what: string, url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const timeout = () => new OidcError(`${what} timed out (the identity service did not respond within ${timeoutMs / 1000} seconds); please try again`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw timeout();
    throw new OidcError(`${what} failed: could not reach the identity service`);
  }
  if (!res.ok) throw new OidcError(`${what} failed: HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw timeout();
    throw new OidcError(`${what} failed: the response is not valid JSON`);
  }
}

async function discover(): Promise<{ doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }> {
  const { issuer } = config.oidc;
  if (!issuer) throw new OidcError("OIDC is not configured (ARTIFACT_OIDC_ISSUER is missing)");
  if (discoveryCache?.issuer === issuer) return discoveryCache;

  const doc = await fetchIdp<Discovery>("OIDC discovery", `${issuer}/.well-known/openid-configuration`, {}, 5_000);
  // The document is fetched over TLS from the issuer, but a mismatched `issuer` field would mean
  // we are about to trust tokens minted by someone else.
  if (doc.issuer !== issuer) throw new OidcError("The issuer in the OIDC discovery document does not match the configuration");
  discoveryCache = { issuer, doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  return discoveryCache;
}

export function __resetDiscoveryForTests(): void {
  discoveryCache = null;
}

export function redirectUri(): string {
  if (!config.publicUrl) throw new OidcError("ARTIFACT_PUBLIC_URL is missing, so the callback URL cannot be derived");
  // Path is validated against the routes we actually serve — see config.oidcRedirectPath.
  return `${config.publicUrl}${config.oidcRedirectPath}`;
}

/**
 * Normalize a post-login destination to a same-site path.
 *
 * A prefix test ("starts with / but not //") is not enough: `/\evil.com` passes it, and browsers
 * treat the backslash as a slash, so it becomes a protocol-relative jump off-site. Parse against a
 * throwaway base, require the origin to still be that base, then re-serialize — never echo the
 * caller's string back.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  // Control chars (CR/LF header splitting) and backslash, which browsers fold to "/".
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return "/";
  const base = "https://placeholder.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  return `${url.pathname}${url.search}${url.hash}` || "/";
}

function flowCookieName(request: Request): string {
  return isSecureRequest(request) ? FLOW_COOKIE_SECURE : FLOW_COOKIE_DEV;
}

function buildFlowCookie(request: Request, value: string, maxAgeSec: number): string {
  const secure = isSecureRequest(request);
  const parts = [
    `${secure ? FLOW_COOKIE_SECURE : FLOW_COOKIE_DEV}=${encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Start a login. The `state` is a server-side flow id echoed in a one-shot cookie — signing a
 * self-contained blob would prove only that WE issued it, not that we issued it to THIS browser,
 * which is the gap that lets an attacker complete their own login, capture the callback URL and
 * hand it to a victim, silently signing them in as the attacker.
 *
 * The PKCE verifier and nonce stay in the database. Putting either in `state` or the URL would
 * reduce PKCE to decoration.
 */
export async function beginLogin(request: Request, rawReturnTo: string | null): Promise<{ url: string; cookie: string }> {
  const { doc } = await discover();
  const flowId = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  await createOidcFlow({
    flowId, verifier, nonce,
    returnTo: safeReturnTo(rawReturnTo),
    expiresAt: Date.now() + FLOW_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    // response_mode stays the default (query): form_post would arrive as a cross-site POST and
    // force SameSite=None on the session cookie.
    scope: "openid profile email",
    state: flowId,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${doc.authorization_endpoint}?${params}`, cookie: buildFlowCookie(request, flowId, FLOW_TTL_MS / 1000) };
}

export function clearFlowCookie(request: Request): string {
  return buildFlowCookie(request, "", 0);
}

export interface OidcClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  sid: string | null;
  returnTo: string;
}

/** Finish a login: verify the browser binding, redeem the code, validate the id_token. */
export async function completeLogin(request: Request, code: string, state: string): Promise<OidcClaims> {
  const cookieFlow = readCookie(request, flowCookieName(request));
  if (!cookieFlow || !state) throw new OidcError("Sign-in state is missing; please sign in again");

  // Constant-time, and length-checked first — this is the browser-binding check.
  if (!safeEqual(cookieFlow, state)) throw new OidcError("Sign-in state does not match; please sign in again");

  // Atomic single-use: two replicas racing the same callback cannot both proceed.
  const flow = await consumeOidcFlow(state, Date.now());
  if (!flow) throw new OidcError("Sign-in state has expired or was already used; please sign in again");

  const { doc, jwks } = await discover();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    code_verifier: flow.verifier,
  });
  const tokens = await fetchIdp<{ id_token?: string }>("Token exchange", doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, 8_000);
  if (!tokens.id_token) throw new OidcError("The IdP did not return an id_token");

  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: doc.issuer,
    audience: config.oidc.clientId,
  });
  // Binds the token to THIS flow; without it a token minted for another login could be replayed.
  if (payload.nonce !== flow.nonce) throw new OidcError("The id_token nonce does not match");

  const emailVerified = payload.email_verified === true;
  return {
    subject: String(payload.sub),
    // An unverified address is never recorded: it is what an attacker would use to pre-register a
    // victim's mailbox and inherit invitations addressed to them.
    email: emailVerified ? ((payload.email as string | undefined) ?? null) : null,
    emailVerified,
    displayName: (payload.name as string | undefined) ?? (payload.preferred_username as string | undefined) ?? null,
    avatarUrl: (payload.picture as string | undefined) ?? null,
    sid: (payload.sid as string | undefined) ?? null,
    returnTo: safeReturnTo(flow.returnTo),
  };
}
