import { z } from "zod";
import { requireAdminWrite } from "@/lib/admin";
import { createId, getSiteBySlug, getUserByVerifiedEmail } from "@/lib/db";
import { claimSiteRecorded } from "@/lib/sites";
import { apiAuditContext, auditRequestMeta } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json, readBodyWithinUploadLimit } from "@/app/api/_util";

/** Assign only unowned sites; never overwrite an existing owner, even under concurrent requests. */
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    checkRateLimit(request);
    const admin = await requireAdminWrite(request);
    const { email } = z.object({ email: z.string().trim().email().max(254) }).parse(await (await readBodyWithinUploadLimit(request, 4096)).json());
    const { slug } = await context.params;
    const site = await getSiteBySlug(slug);
    if (!site || site.deletedAt) return json({ error: "site not found" }, 404);
    if (site.ownerId) return json({ error: "This site already has an owner", code: "already_owned" }, 409);
    const user = await getUserByVerifiedEmail(email);
    if (!user || user.disabledAt) return json({ error: "An active account with this verified email must sign in first", code: "user_not_found" }, 404);
    const won = await claimSiteRecorded(site.id, user.id, apiAuditContext(request, { kind: "admin", userId: admin.userId, anonId: null }), {
      id: createId("adm"), actorKind: admin.kind, actorUserId: admin.userId, action: "site.assign_owner",
      targetKind: "site", targetId: site.id, reason: `Assigned owner: ${user.id}`, ip: auditRequestMeta(request).ip, createdAt: Date.now(),
    });
    if (!won) return json({ error: "The site was assigned or deleted concurrently", code: "already_owned" }, 409);
    return json({ ok: true, ownerId: user.id });
  } catch (error) { return errorResponse(error); }
}
