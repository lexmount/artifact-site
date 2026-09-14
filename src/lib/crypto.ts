// The two hashing/compare primitives every credential path shares. Kept tiny and dependency-free
// so that lib modules on both sides of the auth boundary (sessions, share links, publish tokens,
// preview keys) agree on one implementation instead of each carrying a near-identical copy.
import { createHash, timingSafeEqual } from "node:crypto";

/** Hex SHA-256 of a UTF-8 string — the shape every secret is stored in (never the secret itself). */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time string equality. `timingSafeEqual` throws on unequal lengths, so the length check
 * comes first and answers false — a length mismatch leaks only the length, which the attacker
 * chose anyway.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
