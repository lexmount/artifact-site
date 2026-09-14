// In-memory per-client token bucket for the write routes (create / fork / edit).
// Single-replica by design (local SQLite + local files), so an in-process Map is the
// right tool — no Redis. Guards against upload floods and fork's cp-r amplification.
import { AsyncLocalStorage } from "node:async_hooks";
import { rateLimit as cfg } from "@/lib/config";

// Only server code can enter this scope; no HTTP header can bypass route limits.
const alreadyLimited = new AsyncLocalStorage<boolean>();
export function withRateLimitChecked<T>(run: () => T): T { return alreadyLimited.run(true, run); }

export class RateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message = "Too many requests; please try again later") {
    super(message);
    this.name = "RateLimitError";
  }
}

type Bucket = { tokens: number; last: number };

const buckets = new Map<string, Bucket>();

/**
 * Trusted client identity. The LEFTMOST X-Forwarded-For hop is client-supplied (append-style
 * gateways like nginx put the real peer on the RIGHT), so trusting it lets an attacker
 * rotate a fake header per request and defeat the limiter entirely. We therefore prefer
 * `x-real-ip` (gateway-set to $remote_addr, not client-overridable), then the RIGHTMOST XFF hop,
 * then a shared "unknown" bucket. This assumes only the gateway can reach the app port — an
 * attacker with direct port access can still forge these, which the deploy must prevent.
 */
export function clientKey(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]; // rightmost = the peer the gateway actually saw
  }
  return "unknown";
}

/**
 * Consume one token for this client. Throws RateLimitError (429) when the bucket is empty.
 * The Map doubles as an LRU: touched keys move to the tail, and once MAX_BUCKETS is reached
 * the least-recently-used head is evicted — a true, O(1) hard ceiling on memory.
 *
 * `key` overrides the per-client bucket for the rare endpoint whose unit of abuse is NOT the
 * caller. Passcode entry is the case that forced it: the thing being brute-forced is one share's
 * six-character code, and every guess — from one attacker's script or from a thousand different
 * addresses — is a guess at that same secret. Keying on the IP would let a distributed attacker
 * spend a full bucket per address, and worse, a single determined guesser behind a corporate NAT
 * would exhaust the bucket that every innocent reader at that office shares, locking them all out
 * of a link they were legitimately given. Key on the share and both problems go away: the budget
 * belongs to the secret, and one reader's fumbling costs only that one link.
 *
 * Callers MUST namespace their keys (`share:<id>`, …) so they cannot collide with the IP-shaped
 * keys clientKey produces — the Map is shared by every endpoint.
 *
 * `capacity` raises the ceiling for a dimension that is meant to sit BEHIND the primary one. Its
 * only user today is the anti-scan arm of passcode entry: keying on the share alone budgets each
 * secret separately, so one address working through a hundred different links it already holds
 * gets a hundred fresh budgets. A second, much roomier bucket on the address catches that without
 * putting an office back in reach of the lockout the per-share key exists to prevent.
 */
export function checkRateLimit(
  request: Request,
  now: number = Date.now(),
  key: string = clientKey(request),
  capacity: number = cfg.burst,
  perMin: number = cfg.perMin,
): void {
  if (!cfg.enabled || (alreadyLimited.getStore() && key === clientKey(request))) return;
  const refillPerMs = perMin / 60_000;

  let bucket = buckets.get(key);
  if (bucket) {
    // Refill in place — do NOT reorder yet, so a rejected request can't promote itself.
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.last = now;
  } else {
    while (buckets.size >= cfg.maxKeys) {
      const lru = buckets.keys().next().value; // Map head = least recently used
      if (lru === undefined) break;
      buckets.delete(lru);
    }
    bucket = { tokens: capacity, last: now };
    buckets.set(key, bucket); // new client → at the MRU tail
  }

  if (bucket.tokens < 1) {
    // Rejected: leave the bucket at its current LRU position so an active flooder stays
    // evictable instead of pinning a slot by re-touching it on every rejected request.
    throw new RateLimitError();
  }
  bucket.tokens -= 1;
  // Allowed: promote to the MRU tail (existing keys only; a new key is already there).
  if (buckets.delete(key)) buckets.set(key, bucket);
}

/** Test-only: clear all buckets between cases. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
