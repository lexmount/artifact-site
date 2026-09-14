import "server-only";

// Housekeeping that has to happen somewhere on a deployment with no scheduler: the create routes
// call `maintenanceTick()` and, at most once an hour per process, it purges deleted sites past
// their retention window, expires unclaimed anonymous sites, sweeps abandoned upload sessions and
// backfills the searchable text of sites the index has not caught up with, in the background. The admin
// console runs the same jobs on demand (POST /api/admin/maintenance).
import { expireAnonymousSitesJob, purgeDeletedSites } from "@/lib/admin";
import { sweepExpiredSessions } from "@/lib/upload-session";
import { backfillSiteTexts } from "@/lib/site-text";

const INTERVAL_MS = 60 * 60 * 1000;
let lastTick = 0;

export function maintenanceTick(now: number = Date.now()): void {
  if (now - lastTick < INTERVAL_MS) return;
  lastTick = now;
  // Expiry before purge: a site that expires now is a delete, and the purge only catches it once its retention has also run out.
  void Promise.allSettled([expireAnonymousSitesJob({ now }), purgeDeletedSites({ now }), sweepExpiredSessions(now), backfillSiteTexts({ limit: 20, budgetMs: 20_000 })]).then((results) => {
    for (const r of results) if (r.status === "rejected") console.error("[maintenance]", r.reason);
  });
}

/** Tests only. */
export function __resetMaintenanceForTests(): void {
  lastTick = 0;
}
