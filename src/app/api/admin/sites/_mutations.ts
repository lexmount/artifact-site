import { z } from "zod";
import { adminSiteTarget, deleteSiteAsAdmin, requireAdminWrite, restoreTakenDownSite, takeDownSite, undeleteSite, type AdminSiteTarget } from "@/lib/admin";
import { memberRole } from "@/lib/rbac-access";
import { ANONYMOUS_TENANT, INIT_TENANT } from "@/lib/rbac";
import { createId, getUserByVerifiedEmail } from "@/lib/db";
import { claimSiteRecorded } from "@/lib/sites";
import { apiAuditContext, auditRequestMeta } from "@/lib/audit";
import { managementReasonSchema, optionalManagementReasonSchema } from "@/lib/management-reason";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json, readBodyWithinUploadLimit } from "@/lib/api-http";
import { adminSite } from "./_shape";

const patch = z.union([
  z.object({ takenDown: z.literal(true), reason: managementReasonSchema }),
  z.object({ takenDown: z.literal(false), reason: optionalManagementReasonSchema }),
  z.object({ deleted: z.literal(false), reason: optionalManagementReasonSchema }),
]);
const del = z.object({ reason: managementReasonSchema });
const owner = z.object({ email: z.string().trim().email().max(254), reason: managementReasonSchema });

/** Both URL forms use the same authorization, CSRF, validation and audit behavior. */
export async function patchAdminSite(request: Request, target: AdminSiteTarget) {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const input = patch.parse(await request.json());
    const site = "takenDown" in input
      ? (input.takenDown ? await takeDownSite(request, actor, target, input.reason) : await restoreTakenDownSite(request, actor, target, input.reason))
      : await undeleteSite(request, actor, target, input.reason);
    return json({ site: adminSite(site) });
  } catch (error) { return errorResponse(error); }
}

export async function deleteAdminSite(request: Request, target: AdminSiteTarget) {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const input = del.parse(await request.json().catch(() => ({})));
    return json({ site: adminSite(await deleteSiteAsAdmin(request, actor, target, input.reason)) });
  } catch (error) { return errorResponse(error); }
}

/** Assign only unowned sites; never overwrite an existing owner, even under concurrent requests. */
export async function assignAdminSiteOwner(request: Request, target: AdminSiteTarget) {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const { email, reason } = owner.parse(await (await readBodyWithinUploadLimit(request, 4096)).json());
    const site = await adminSiteTarget(target);
    if (site.deletedAt) return json({ error: "Site not found" }, 404);
    if (site.ownerId) return json({ error: "This site already has an owner", code: "already_owned" }, 409);
    const user = await getUserByVerifiedEmail(email);
    if (!user || user.disabledAt) return json({ error: "An active account with this verified email must sign in first", code: "user_not_found" }, 404);
    const tenantId = site.tenantId === ANONYMOUS_TENANT ? INIT_TENANT : site.tenantId;
    if (!(await memberRole(tenantId, user.id))) return json({ error: "The new owner must be an active member of the destination tenant" }, 403);
    const won = await claimSiteRecorded(site.id, user.id, apiAuditContext(request, { kind: "admin", userId: actor.userId, anonId: null }), {
      id: createId("adm"), actorKind: actor.kind, actorUserId: actor.userId, action: "site.assign_owner",
      targetKind: "site", targetId: site.id, reason: `${reason}\nAssigned owner: ${user.id}`, ip: auditRequestMeta(request).ip, createdAt: Date.now(),
    });
    if (!won) return json({ error: "The site was assigned or deleted concurrently", code: "already_owned" }, 409);
    return json({ ok: true, ownerId: user.id });
  } catch (error) { return errorResponse(error); }
}
