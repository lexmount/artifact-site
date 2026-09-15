// Publish tokens: the identity an agent carries so what it publishes is YOURS from birth.
//
// Anonymous publishing + after-the-fact claiming was the stopgap; this is the fix. A user approves
// a device-authorization request once per machine, the agent stores the minted token in a
// well-known file, and every later session on that machine publishes as the user — no claiming,
// no cookies, no per-site credential files.
//
// Secrets follow the session model exactly: the bearer secret exists in the response once, the DB
// stores sha256 only, and the sha256 IS the row id.
import { randomBytes } from "node:crypto";
import { sha256hex } from "@/lib/crypto";

/** Recognizable prefix so logs, greps and the Authorization parser can tell it apart from the
 *  admin PUBLISH_API_TOKEN, which shares the Bearer scheme. */
const PUBLISH_TOKEN_PREFIX = "ahp_";

export function createPublishTokenSecret(): string {
  return PUBLISH_TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

export function createDeviceCode(): string {
  return randomBytes(24).toString("base64url");
}

/** No 0/O/1/I/L — this code gets read off one screen and typed into another. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export function createUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return code.slice(0, 4) + "-" + code.slice(4);
}

export function hashTokenSecret(secret: string): string {
  return sha256hex(secret);
}

/** The `Authorization: Bearer ahp_…` this request carries, if any. Admin bearer (PUBLISH_API_TOKEN)
 *  has no such prefix and stays invisible to this parser. */
export function publishTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return bearer.startsWith(PUBLISH_TOKEN_PREFIX) ? bearer : null;
}

/**
 * OAuth access tokens (lib/oauth) share the Bearer scheme. Their own prefix keeps the three kinds of
 * bearer — the admin PUBLISH_API_TOKEN, an `ahp_` publish token, an `aho_` OAuth access token —
 * apart at the parser, so each is validated by exactly one path and never falls through to another.
 */
export const OAUTH_ACCESS_TOKEN_PREFIX = "aho_";

/** The `Authorization: Bearer aho_…` this request carries, if any. */
export function oauthAccessTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? bearer : null;
}

/**
 * A session minted from a bearer — a publish token (`pt:`) or an OAuth access token (`oat:`) —
 * rather than from a browser login. Token management, device approval and OAuth consent refuse
 * these: a leaked credential must never be able to mint itself a replacement or approve another.
 */
export function isTokenSession(session: { id: string }): boolean {
  return session.id.startsWith("pt:") || session.id.startsWith("oat:");
}

export const DEVICE_GRANT_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_S = 5;
