// GET /api/admin/log?target=<userId|siteId|systemTarget>&limit= — administrative acts, newest first.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, visibleAdminLog } from "@/lib/admin";
import { getSite, getUser, listAdminLog, rbacQuery } from "@/lib/db";
import { managementReason } from "@/lib/management-reason";
import { recordRbacAudit } from "@/lib/rbac-access";
import { NotFoundError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";

const query = z.object({ target: z.string().trim().max(100).default(""), limit: z.coerce.number().int().min(1).max(500).default(100) });
// Stable non-site targets emitted by settings and maintenance, even before their first event.
const systemTargets = new Set(["settings", "purge-deleted", "sweep-uploads", "reconcile", "expire-anonymous", "backfill-text", "prune-audit"]);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    const actor = await requireAdmin(request);
    const p = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (!p.target || systemTargets.has(p.target) || await getUser(p.target)) {
      return json({ entries: await visibleAdminLog(actor, { targetId: p.target || null, limit: p.limit }) });
    }
    const reason = managementReason(request);
    // Missing/invalid reasons and unresolved targets share a response: no existence oracle.
    if (!reason) throw new NotFoundError("Audit target not found or management reason required");
    const site = await getSite(p.target);
    if (!site) throw new NotFoundError("Audit target not found or management reason required");
    await recordRbacAudit(rbacQuery, site.tenantId, actor.userId, "site.audit.read", site.id, reason);
    return json({ entries: await listAdminLog({ scope: "all", targetId: site.id, limit: p.limit }) });
  } catch (error) {
    return errorResponse(error);
  }
}
