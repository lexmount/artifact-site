import { appPath, localPath } from "@/lib/app-path";
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
import { autoLoginOptedOut, silentCompletionId } from "@/lib/oidc-auto-login";
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

// Associate a validated return target without changing the original error or exposing its message.
const loginFailureTargets = new WeakMap<object, string>();
export function rememberLoginFailureTarget(error: unknown, returnTo: string): void {
  if (error !== null && typeof error === "object") loginFailureTargets.set(error, safeReturnTo(returnTo));
}
export function loginFailureTarget(error: unknown): string {
  return error !== null && typeof error === "object" ? loginFailureTargets.get(error) ?? "/" : "/";
}

/** Only constructed after browser binding and single-use flow validation. */
export class SilentLoginFailure extends OidcError {
  constructor(readonly returnTo: string) { super("Automatic sign-in was not completed"); }
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
  // Dot-segment normalization can produce //host from /..//host. Reusing that
  // serialized path as a relative URL would reinterpret it as an external authority.
  if (url.origin !== base || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}` || "/";
}

function flowCookieName(request: Request, silent = false, state = ""): string {
  const name = isSecureRequest(request) ? FLOW_COOKIE_SECURE : FLOW_COOKIE_DEV;
  // Each silent flow owns its binding: concurrent tab responses cannot overwrite one another.
  // Hash the full state to keep attacker-supplied callback values out of cookie names.
  return silent ? `${name}_silent_${createHash("sha256").update(state).digest("hex")}` : name;
}

function buildFlowCookie(request: Request, value: string, maxAgeSec: number, silent = false, state = value): string {
  const secure = isSecureRequest(request);
  const parts = [
    `${flowCookieName(request, silent, state)}=${encodeURIComponent(value)}`,
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
export async function beginLogin(request: Request, rawReturnTo: string | null, silent = false, switchAccount = false): Promise<{ url: string; cookie: string }> {
  const { doc } = await discover();
  const callback = redirectUri();
  const flowId = `${silent ? "silent." : switchAccount ? "switch." : ""}${randomBytes(32).toString("base64url")}.${createHash("sha256").update(callback).digest("hex")}`;
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  await createOidcFlow({
    flowId, verifier, nonce,
    returnTo: appPath(safeReturnTo(localPath(rawReturnTo || "/"))),
    expiresAt: Date.now() + FLOW_TTL_MS,
  });

  if (silent) await createOidcFlow({
    flowId: silentCompletionId(flowId), verifier: "", nonce: "", returnTo: "/",
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
  if (silent) params.set("prompt", "none");
  else if (switchAccount) params.set("prompt", "login");
  return { url: `${doc.authorization_endpoint}?${params}`, cookie: buildFlowCookie(request, flowId, FLOW_TTL_MS / 1000, silent) };
}

export function clearFlowCookie(request: Request, silent = false): string {
  return buildFlowCookie(request, "", 0, silent, new URL(request.url).searchParams.get("state") ?? "");
}

export interface OidcClaims {
  silent?: boolean;
  switchAccount?: boolean;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  publicDisplayName: string | null;
  avatarUrl: string | null;
  sid: string | null;
  returnTo: string;
}

/** Finish a login: verify the browser binding, redeem the code, validate the id_token. */
export async function completeLogin(request: Request, code: string, state: string): Promise<OidcClaims> {
  const silent = state.startsWith("silent.");
  const cookieFlow = readCookie(request, flowCookieName(request, silent, state));
  if (!cookieFlow || !state) throw new OidcError("Sign-in state is missing; please sign in again");

  // Constant-time, and length-checked first — this is the browser-binding check.
  if (!safeEqual(cookieFlow, state)) throw new OidcError("Sign-in state does not match; please sign in again");

  // Bind the flow to the exact callback (origin AND mount) without changing stored rows.
  const binding = createHash("sha256").update(redirectUri()).digest("hex");
  if (!state.endsWith(`.${binding}`)) throw new OidcError("Sign-in callback does not match the login endpoint; please sign in again");

  // Atomic single-use: two replicas racing the same callback cannot both proceed.
  const flow = await consumeOidcFlow(state, Date.now());
  if (!flow) throw new OidcError("Sign-in state has expired or was already used; please sign in again");

  try {
    if (silent && autoLoginOptedOut(request)) throw new OidcError("Automatic sign-in was cancelled");
    if (new URL(request.url).searchParams.has("error") || !code) throw new OidcError("The identity service did not complete sign-in");
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

    if (silent && !await consumeOidcFlow(silentCompletionId(state), Date.now())) {
      throw new OidcError("Automatic sign-in was superseded by an explicit account action");
    }
    const emailVerified = payload.email_verified === true;
    return {
      silent,
      switchAccount: state.startsWith("switch."),
      subject: String(payload.sub),
      // An unverified address is never recorded: it is what an attacker would use to pre-register a
      // victim's mailbox and inherit invitations addressed to them.
      email: emailVerified ? ((payload.email as string | undefined) ?? null) : null,
      emailVerified,
      publicDisplayName: typeof payload.name === "string" ? payload.name : null,
      displayName: (payload.name as string | undefined) ?? (payload.preferred_username as string | undefined) ?? null,
      avatarUrl: (payload.picture as string | undefined) ?? null,
      sid: (payload.sid as string | undefined) ?? null,
      returnTo: safeReturnTo(flow.returnTo),
    };
  } catch (error) {
    if (silent) {
      await consumeOidcFlow(silentCompletionId(state), Date.now());
      throw new SilentLoginFailure(safeReturnTo(flow.returnTo));
    }
    rememberLoginFailureTarget(error, flow.returnTo);
    throw error;
  }
}
