// POST /api/admin/maintenance { task: "purge-deleted" | "sweep-uploads" | "reconcile" | "expire-anonymous" | "backfill-text" | "prune-audit", dryRun? }
// The same jobs the process runs on its own once an hour (lib/maintenance), on demand and recorded.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { expireAnonymousSitesJob, purgeDeletedSites, recordAdminAction, requireAdminWrite } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { reconcileOrphans } from "@/lib/reconcile";
import { pruneAuditLogsJob } from "@/lib/audit-retention";
import { backfillSiteTexts } from "@/lib/site-text";
import { sweepExpiredSessions } from "@/lib/upload-session";
import { errorResponse, json } from "../../_util";

const body = z.object({ task: z.enum(["purge-deleted", "sweep-uploads", "reconcile", "expire-anonymous", "backfill-text", "prune-audit"]), dryRun: z.boolean().optional() }).refine(
  (input) => input.task === "reconcile" || !input.dryRun,
  { message: "Only reconcile supports dryRun; no maintenance task was executed", path: ["dryRun"] },
);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const input = body.parse(await request.json());
    let result: unknown;
    switch (input.task) {
      case "prune-audit":
        result = await pruneAuditLogsJob();
        await recordAdminAction(request, actor, "maintenance.prune_audit", { kind: "system", id: "prune-audit" });
        break;
      case "purge-deleted":
        result = await purgeDeletedSites();
        await recordAdminAction(request, actor, "maintenance.purge_deleted", { kind: "system", id: "purge-deleted" });
        break;
      case "sweep-uploads":
        result = { swept: await sweepExpiredSessions() };
        await recordAdminAction(request, actor, "maintenance.sweep_uploads", { kind: "system", id: "sweep-uploads" });
        break;
      case "expire-anonymous":
        // Logged inside the job (with the count), attributed to the administrator who pressed it.
        result = await expireAnonymousSitesJob({ actor, request });
        break;
      case "backfill-text":
        // 25 s per call — under a proxy's typical 60 s read timeout; the console keeps calling while
        // `remaining` says there is more.
        result = await backfillSiteTexts({ limit: 20, budgetMs: 25_000 });
        await recordAdminAction(request, actor, "maintenance.backfill_text", { kind: "system", id: "backfill-text" });
        break;
      case "reconcile":
        result = await reconcileOrphans({ dryRun: input.dryRun ?? true });
        if (!input.dryRun) await recordAdminAction(request, actor, "maintenance.reconcile", { kind: "system", id: "reconcile" });
        break;
    }
    return json({ task: input.task, result });
  } catch (error) {
    return errorResponse(error);
  }
}
