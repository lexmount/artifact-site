// Orphan reconciler — GC for version trees in storage that no metadata references. Orphans come
// from the files-first write order (files land, then the DB row is recorded): a crash / DB failure
// between the two, or a partially-failed delete, leaves objects with no version row. Since the local
// backend's orphans are visible on disk but S3's are not, this sweep is the safety net for both.
import { getSite, getVersion } from "@/lib/db";
import { config } from "@/lib/config";
import { getStorage } from "@/lib/storage";
import type { Site } from "@/lib/types";

export interface ReconcileResult {
  dryRun: boolean;
  scannedVersions: number;
  orphanVersions: number;
  skippedByGrace: number;
  deletedVersions: number;
  errors: number;
}

// Don't touch trees whose newest object is younger than this — they may be an in-flight upload whose
// version row hasn't been committed yet. One hour is comfortably longer than any single upload.
const DEFAULT_GRACE_MS = 60 * 60 * 1000;

/**
 * Delete version trees in storage that have no live metadata. A tree is an orphan when its version
 * row is missing (or points at a different site), or when its site is missing / soft-deleted. Recent
 * trees are spared by a grace window so an in-flight create is never swept. Pass dryRun to only count.
 */
export async function reconcileOrphans(opts: { dryRun?: boolean; graceMs?: number } = {}): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const storage = getStorage();
  const stored = await storage.listStoredVersions();
  const now = Date.now();
  const result: ReconcileResult = { dryRun, scannedVersions: stored.length, orphanVersions: 0, skippedByGrace: 0, deletedVersions: 0, errors: 0 };
  const siteCache = new Map<string, Site | null>(); // a site's many versions share one lookup

  for (const { siteId, versionId, newestMtime } of stored) {
    let orphan = false;
    const version = await getVersion(versionId);
    if (!version || version.siteId !== siteId) {
      orphan = true; // no version row (crash before insert), or the id belongs to another site
    } else {
      if (!siteCache.has(siteId)) siteCache.set(siteId, await getSite(siteId));
      const site = siteCache.get(siteId)!;
      // A soft-deleted site keeps its files for the retention window (restorable); only a purged one,
      // or one the purge has not reached yet, counts as an orphan here.
      if (!site) orphan = true;
      else if (site.deletedAt && (site.purgedAt || now - site.deletedAt >= config.deletedRetentionMs)) orphan = true;
    }
    if (!orphan) continue;

    result.orphanVersions += 1;
    if (now - newestMtime < graceMs) {
      result.skippedByGrace += 1; // too fresh — might be an upload still recording its metadata
      continue;
    }
    if (dryRun) continue;
    try {
      await storage.removeVersion(siteId, versionId);
      result.deletedVersions += 1;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}
