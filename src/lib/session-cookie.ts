/**
 * Shared names only: no session, database or OAuth dependencies.
 * `__Host-` forces Secure + Path=/ + no Domain, preventing sibling-domain cookie tossing.
 * Plain-HTTP development uses an unprefixed name; HTTPS authentication must never accept it.
 */
export const SESSION_COOKIE_NAMES = {
  secure: "__Host-ah_session",
  development: "ah_session",
} as const;
