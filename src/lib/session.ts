// Browser sessions. Stateful on purpose: "remove a collaborator" has to take effect immediately,
// and a self-contained JWT cannot be un-issued. The row lives in Postgres, so any replica can
// validate — and revoke — a cookie the moment a grant is withdrawn.
//
// Background: ARCHITECTURE.md, "Identity".
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import { randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { safeEqual, sha256hex } from "@/lib/crypto";
import { createSession, getPublishToken, getSession, revokeSession, touchPublishToken, touchSession } from "@/lib/db";
import { isSecureRequest, readCookie } from "@/lib/http";
import { InsufficientScopeError } from "@/lib/auth";
import { resolveOauthAccessToken } from "@/lib/oauth";
import { issuerFor, parseScopeList, SCOPE_WRITE } from "@/lib/oauth-shared";
import { hashTokenSecret, oauthAccessTokenFromRequest, publishTokenFromRequest } from "@/lib/publish-token";
import type { Session } from "@/lib/types";

/** The methods a read-only OAuth grant may use. Everything that changes state is a POST/PUT/PATCH/DELETE. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The sliding window, and the ceiling it can never be pushed past. These MUST differ: when they
// were equal, `min(now + TTL, absolute)` always came back as the current expiry, the difference was
// zero, and the refresh below never fired once — lastSeenAt froze at login and every session hard
// expired 30 days later no matter how active its owner was.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // idle timeout
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000; // total lifetime, active or not
/** Don't write to the DB on every single request — only once the window has moved materially. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `__Host-` forces Secure + Path=/ + no Domain, which is exactly what stops a sibling subdomain
 * from tossing a cookie of the same name and pinning the user to an attacker's session. The prefix
 * is only honoured over HTTPS, so plain-HTTP local dev falls back to an unprefixed name; production
 * is always HTTPS and always gets the hardened one.
 */
const SECURE_COOKIE = "__Host-ah_session";
const DEV_COOKIE = "ah_session";

/** The DB stores sha256(secret), never the secret — a read-only dump yields nothing usable. */
const hashSecret = sha256hex;

/**
 * The cookie this request should be read from, and nothing else.
 *
 * The unprefixed name exists only so plain-http local dev works. Falling back to it on HTTPS would
 * hand the whole __Host- guarantee back: a sibling subdomain cannot set __Host-ah_session — that is
 * the prefix's entire point — but it can set `ah_session` with Domain=.example.com, and a fallback
 * would happily accept it.
 */
function readSessionSecret(request: Request): string | null {
  if (isSecureRequest(request)) return readCookie(request, SECURE_COOKIE);
  return readCookie(request, DEV_COOKIE);
}

export interface MintedSession {
  session: Session;
  /** Set-Cookie value. The plaintext secret exists only here and in the browser. */
  cookie: string;
}

export async function mintSession(
  request: Request,
  userId: string,
  opts: { oidcSid?: string | null; ip?: string | null; userAgent?: string | null } = {},
): Promise<MintedSession> {
  const secret = randomBytes(32).toString("base64url");
  const id = hashSecret(secret);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await createSession({
    id, userId, oidcSid: opts.oidcSid ?? null,
    expiresAt,
    // Ceiling fixed at login: without it a stolen cookie renews itself forever.
    absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
    ip: opts.ip ?? null, userAgent: opts.userAgent ?? null,
  });
  const session: Session = {
    id, userId, oidcSid: opts.oidcSid ?? null, createdAt: now,
    expiresAt, absoluteExpiresAt: now + SESSION_ABSOLUTE_MS, lastSeenAt: now, revokedAt: null,
    ip: opts.ip ?? null, userAgent: opts.userAgent ?? null,
  };
  return { session, cookie: buildCookie(request, secret, SESSION_TTL_MS / 1000) };
}

function buildCookie(request: Request, value: string, maxAgeSec: number): string {
  const secure = isSecureRequest(request);
  const name = secure ? SECURE_COOKIE : DEV_COOKIE;
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(request: Request): string {
  return buildCookie(request, "", 0);
}

/**
 * Resolve the caller's session, or null. Slides the expiry (clamped to the absolute ceiling) at
 * most once per TOUCH_INTERVAL_MS so an active user stays logged in without a write per request.
 */
export async function resolveSession(request: Request): Promise<Session | null> {
  // An OAuth access token (lib/oauth) folds into a session the same way a publish token does, with
  // two differences: it expires, and it carries what the person granted (`scopes`). A grant that
  // lacks the write scope may only READ, and the HTTP method is the cleanest line to draw that
  // at — every route that changes something is a POST/PUT/PATCH/DELETE — so the refusal is thrown
  // here, before any handler runs, as the 403 an OAuth client knows how to act on.
  const oauthBearer = oauthAccessTokenFromRequest(request);
  if (oauthBearer) {
    const token = await resolveOauthAccessToken(oauthBearer, issuerFor(request));
    if (!token) return null; // a bad explicit credential must not fall back to cookies
    const scopes = parseScopeList(token.scope);
    if (!scopes.includes(SCOPE_WRITE) && !READ_METHODS.has(request.method)) throw new InsufficientScopeError(SCOPE_WRITE);
    return {
      id: `oat:${token.id}`, userId: token.userId, oidcSid: null,
      createdAt: token.createdAt, expiresAt: token.expiresAt, absoluteExpiresAt: token.absoluteExpiresAt,
      lastSeenAt: token.lastUsedAt, revokedAt: null, ip: null, userAgent: null, scopes,
    };
  }

  // A publish token authenticates exactly like a login for authorization purposes, so it folds
  // into the session shape here — every caller downstream (site creation, capability checks,
  // audit attribution) then works for agents without knowing tokens exist. The synthetic session
  // never touches the sessions table; its id carries the token id for the audit trail.
  const bearer = publishTokenFromRequest(request);
  if (bearer) {
    const token = await getPublishToken(hashTokenSecret(bearer));
    if (!token || token.revokedAt != null) return null; // a bad explicit credential must not fall back to cookies
    const now = Date.now();
    if (!token.lastUsedAt || now - token.lastUsedAt > TOUCH_INTERVAL_MS) await touchPublishToken(token.id, now);
    return {
      id: `pt:${token.id}`, userId: token.userId, oidcSid: null,
      createdAt: token.createdAt, expiresAt: now + SESSION_TTL_MS, absoluteExpiresAt: now + SESSION_TTL_MS,
      lastSeenAt: token.lastUsedAt, revokedAt: null, ip: null, userAgent: null,
    };
  }

  const secret = readSessionSecret(request);
  if (!secret) return null;

  const session = await getSession(hashSecret(secret));
  if (!session) return null;

  const now = Date.now();
  if (session.revokedAt != null) return null;
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;

  const target = Math.min(now + SESSION_TTL_MS, session.absoluteExpiresAt);
  if (target - session.expiresAt > TOUCH_INTERVAL_MS) {
    await touchSession(session.id, target, now);
    return { ...session, expiresAt: target, lastSeenAt: now };
  }
  return session;
}

export async function endSession(request: Request): Promise<void> {
  const secret = readSessionSecret(request);
  if (secret) await revokeSession(hashSecret(secret));
}

/**
 * CSRF gate for cookie-authenticated writes. Origin is checked EXACTLY, and a missing or literal
 * "null" Origin is rejected rather than waved through — a sandboxed preview iframe is an opaque
 * origin and sends exactly `Origin: null`, so "absent means same-site" would hand hosted, untrusted
 * artifacts a way to act as the signed-in user. SameSite=Lax is only defence in depth here.
 */
/**
 * The CSRF gate writes should actually use. CSRF is a property of credentials the browser attaches
 * on its own (cookies); a publish-token or OAuth Bearer is always set deliberately by the caller,
 * so such a request cannot be a cross-site forgery no matter what its Origin says — and
 * non-browser agents have no Origin to send. Same-origin stays required for everything
 * cookie-authenticated.
 */
export function csrfSafe(request: Request): boolean {
  return Boolean(publishTokenFromRequest(request)) || Boolean(oauthAccessTokenFromRequest(request)) || isSameOrigin(request);
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  const expected = config.publicUrl || new URL(request.url).origin;
  return safeEqual(origin, expected);
}
