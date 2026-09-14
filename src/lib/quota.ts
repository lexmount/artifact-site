import "server-only";

// Per-owner caps and the anonymous-site clock. Checked at every path that adds a site or a
// version (create, chunked commit, new version, edit, fork, rollback) — always against what is
// actually stored, never a running counter that could drift. Check-then-write, deliberately:
// two concurrent uploads can overshoot by one, and a cap is a policy, not an accounting ledger.
import { policy } from "@/lib/settings";
import { ownerUsage, type QuotaOwner } from "@/lib/db";
import { QuotaExceededError } from "@/lib/errors";
import type { Site } from "@/lib/types";

/** The owner whose quota a write against `site` draws on; null for pre-identity rows (nobody's). */
export function quotaOwnerOf(site: Pick<Site, "ownerId" | "anonOwnerId">): QuotaOwner | null {
  if (site.ownerId) return { userId: site.ownerId };
  if (site.anonOwnerId) return { anonId: site.anonOwnerId };
  return null;
}

/** From the `owner` argument the create paths take. */
export function quotaOwnerFor(owner: { ownerId?: string | null; anonOwnerId?: string | null }): QuotaOwner | null {
  if (owner.ownerId) return { userId: owner.ownerId };
  if (owner.anonOwnerId) return { anonId: owner.anonOwnerId };
  return null;
}

export function limitsFor(owner: QuotaOwner | null): { sites: number; bytes: number } {
  const q = policy.quota;
  if (!owner) return { sites: 0, bytes: 0 };
  return owner.userId ? { sites: q.sitesPerUser, bytes: q.bytesPerUser } : { sites: q.sitesPerAnon, bytes: q.bytesPerAnon };
}

/** Human size for the refusal message: MB with one decimal, KB below a megabyte, so a small cap never reads as "0MB". */
const mb = (n: number) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/**
 * Refuse a write that would push the owner over a cap. `sites` is how many new sites the write
 * adds (1 for create / fork), `bytes` the size of the version it adds. Free when no cap is set.
 */
export async function assertQuotaRoom(owner: QuotaOwner | null, delta: { sites?: number; bytes: number }): Promise<void> {
  const limit = limitsFor(owner);
  if (!owner || (!limit.sites && !limit.bytes)) return;
  const used = await ownerUsage(owner);
  const addSites = delta.sites ?? 0;
  if (limit.sites && addSites > 0 && used.sites + addSites > limit.sites) {
    throw new QuotaExceededError(
      `Site limit reached: this ${owner.userId ? "account" : "browser"} already has ${used.sites} of ${limit.sites} sites. Delete a site you no longer need, or publish a new version of an existing one instead of creating another.`,
      { kind: "sites", limit: limit.sites, used: used.sites, requested: addSites },
    );
  }
  if (limit.bytes && delta.bytes > 0 && used.bytes + delta.bytes > limit.bytes) {
    throw new QuotaExceededError(
      `Storage limit reached: ${mb(used.bytes)} of ${mb(limit.bytes)} in use and this version needs ${mb(delta.bytes)} more. Every version counts; delete sites (or trim assets) to free space.`,
      { kind: "bytes", limit: limit.bytes, used: used.bytes, requested: delta.bytes },
    );
  }
}

/** When an anonymous site will be removed, or null (owned, pre-identity, or expiry off). */
export function anonymousExpiresAt(site: Pick<Site, "ownerId" | "anonOwnerId" | "updatedAt" | "deletedAt">): number | null {
  const ttl = policy.anonSiteTtlMs;
  if (!ttl || site.ownerId || !site.anonOwnerId || site.deletedAt) return null;
  return site.updatedAt + ttl;
}
