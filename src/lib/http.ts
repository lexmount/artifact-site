// Request-level primitives every cookie-bearing module used to carry its own copy of: "did this
// request arrive over TLS?" and "read exactly one cookie". One definition, so the security
// properties below hold everywhere at once instead of drifting per file.

/** The subset of `Headers` (and of Next's `headers()`) these helpers read. */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}

/**
 * The FIRST hop of `x-forwarded-proto`, trimmed, or "" when the header is absent. The first hop
 * is the scheme the client used against the outermost proxy; later hops describe proxy-to-proxy
 * legs and say nothing about the browser. Callers decide the default for "absent" themselves —
 * see `isSecureRequest` (assume http) versus the address-minting helpers (assume https).
 */
export function forwardedProto(headers: HeaderBag): string {
  return (headers.get("x-forwarded-proto") || "").split(",")[0].trim();
}

/**
 * True when the caller reached us over HTTPS — either directly (the request URL says so) or
 * through a proxy that recorded it in `x-forwarded-proto`. Absent both, the answer is NO: this
 * gates whether `__Host-` cookie names are used, and a wrong "yes" on plain-http dev would make
 * every cookie unreadable, while a wrong "no" on production merely falls back to the unprefixed
 * name, which the browser would not have sent over https anyway (the two never collide).
 */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  return forwardedProto(request.headers) === "https";
}

/**
 * The value of cookie `name`, URL-decoded, or null when it is absent — OR when it appears more
 * than once. A sibling subdomain can plant a duplicate (`Domain=.example.com` reaches every host
 * under it), and which copy the browser lists first is not something to build a login on;
 * refusing ambiguity is safer than picking one.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const hits = header.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (hits.length !== 1) return null;
  // A malformed percent-escape is a broken cookie, not a server error: treat it as absent rather
  // than letting URIError surface as a 500 on every request that carries it.
  try { return decodeURIComponent(hits[0]); } catch { return null; }
}
