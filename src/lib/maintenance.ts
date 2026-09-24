import { pruneNotifications } from "@/lib/notifications/service";
import "server-only";

// Request-driven housekeeping for deployments with no scheduler. Create and search routes
// call maintenanceTick(), at most once an hour per process. It expires anonymous sites, purges
// deleted files, sweeps upload sessions and comment images, prunes audit logs and backfills search text in the
// background. The admin console also runs jobs on demand (POST /api/admin/maintenance).
import { afterResponse } from "@/lib/after-response";
import { expireAnonymousSitesJob, purgeDeletedSites } from "@/lib/admin";
import { pruneAuditLogsJob } from "@/lib/audit-retention";
import { pruneViewDetails } from "@/lib/view-retention";
import { pruneOauth } from "@/lib/db";
import { sweepExpiredSessions } from "@/lib/upload-session";
import { sweepCommentAttachments } from "@/lib/comments/attachments";
import { backfillSiteTexts } from "@/lib/site-text";

const INTERVAL_MS = 60 * 60 * 1000;
let lastTick = 0;

export function maintenanceTick(now: number = Date.now()): void {
  if (now - lastTick < INTERVAL_MS) return;
  lastTick = now;
  // Expiry before purge: a site that expires now is a delete, and the purge only catches it once its retention has also run out.
  // Track the whole job chain: tests drain it before closing/resetting the DB.
  afterResponse(() => Promise.allSettled([
    expireAnonymousSitesJob({ now }), purgeDeletedSites({ now }),
    sweepExpiredSessions(now), pruneOauth(now), pruneViewDetails(now),
    pruneAuditLogsJob({ now }), pruneNotifications(now), backfillSiteTexts({ limit: 20, budgetMs: 20_000 }),
    sweepCommentAttachments().then(result => {
      if (result.errors) console.error("[maintenance] comment image cleanup failed; retrying next tick", { errors: result.errors });
    }),
  ]).then((results) => {
    for (const r of results) if (r.status === "rejected") console.error("[maintenance]", r.reason);
  }));
}

/** Tests only. */
export function __resetMaintenanceForTests(): void {
  lastTick = 0;
}
