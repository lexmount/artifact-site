import { z } from "zod";
import { managementReasonSchema } from "@/lib/management-reason";
import { requireAdminWrite } from "@/lib/admin";
import { knownSite } from "@/lib/known-site";
import { rbacQuery } from "@/lib/db";
import { recordRbacAudit } from "@/lib/rbac-access";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json, readBodyWithinUploadLimit } from "@/lib/api-http";

export async function POST(request: Request) {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const { reference, reason } = z.object({
      reference: z.string().trim().min(1).max(2048),
      reason: managementReasonSchema,
    }).strict().parse(await (await readBodyWithinUploadLimit(request, 8192)).json());
    const site = await knownSite(request, reference);
    await recordRbacAudit(rbacQuery, site.tenantId, actor.userId, "site.management", site.id, reason);
    const { id, slug, title, ownerId, deletedAt, purgedAt, takenDownAt } = site;
    return json({ site: { id, slug, title, ownerId, deletedAt, purgedAt, takenDownAt } });
  } catch (error) { return errorResponse(error); }
}
