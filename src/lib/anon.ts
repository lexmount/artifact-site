// Anonymous browser identity. Lets someone who has never signed in keep editing the sites they
// created, and lets a later sign-in adopt all of them in one statement.
//
// Deliberately a cookie, NOT the client IP. This app sits behind a gateway, so most requests
// arrive with the gateway's address — an IP-keyed identity would put every colleague in one
// bucket (each able to edit the others' sites) and would evaporate on a network change. The rate
// limiter already shows the failure mode: with no x-real-ip it falls back to one shared bucket.
import { isAdmin } from "@/lib/auth";
import { randomBytes } from "node:crypto";
import { isSecureRequest, readCookie } from "@/lib/http";

const SECURE_COOKIE = "__Host-ah_anon";
const DEV_COOKIE = "ah_anon";
const MAX_AGE_SEC = 180 * 24 * 60 * 60;

/**
 * The caller's anonymous id, or null if this browser has never been given one.
 *
 * No fallback to the unprefixed name on HTTPS — it exists only for plain-http local dev. Accepting
 * it in production would let a sibling subdomain set `ah_anon` with Domain=.example.com and inherit
 * someone else's anonymous ownership, which on an unclaimed site is full control.
 */
export function anonIdFromRequest(request: Request): string | null {
  if (isAdmin(request)) return null;
  return readCookie(request, isSecureRequest(request) ? SECURE_COOKIE : DEV_COOKIE);
}

/** Existing id, or a fresh one plus the Set-Cookie that persists it. */
export function ensureAnonId(request: Request): { anonId: string | null; cookie: string | null } {
  // Operator credentials are not browser identities or anonymous quota/expiry owners.
  if (isAdmin(request)) return { anonId: null, cookie: null };
  const existing = anonIdFromRequest(request);
  if (existing) return { anonId: existing, cookie: null };

  const anonId = `anon_${randomBytes(24).toString("base64url")}`;
  const secure = isSecureRequest(request);
  const parts = [
    `${secure ? SECURE_COOKIE : DEV_COOKIE}=${encodeURIComponent(anonId)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return { anonId, cookie: parts.join("; ") };
}
