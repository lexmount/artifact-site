// GET /api/admin/log?target=<userId|siteId>&limit= — administrative acts, newest first.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, visibleAdminLog } from "@/lib/admin";
import { getSite, listAdminLog, rbacQuery } from "@/lib/db";
import { managementReason } from "@/lib/management-reason";
import { recordRbacAudit } from "@/lib/rbac-access";
import { BadRequestError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";

const query = z.object({ target: z.string().trim().max(100).default(""), limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    const actor = await requireAdmin(request);
    const p = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const site = p.target ? await getSite(p.target) : null;
    if (site) {
      const reason = managementReason(request);
      if (!reason) throw new BadRequestError("A management reason is required for site audit history");
      await recordRbacAudit(rbacQuery, site.tenantId, actor.userId, "site.audit.read", site.id, reason);
      return json({ entries: await listAdminLog({ targetId: site.id, limit: p.limit }) });
    }
    return json({ entries: await visibleAdminLog(actor, { targetId: p.target || null, limit: p.limit }) });
  } catch (error) {
    return errorResponse(error);
  }
}
