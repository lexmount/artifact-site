import { recordRbacAudit } from "@/lib/rbac-access";
// Owner-level transfer and disown operations. Email administrators assign unowned sites
// through /api/admin/sites/:slug/owner; this route retains its same-origin requirement.
//
//   DELETE → disown  (owner_id back to NULL; the site returns to unowned state; reassignment requires an authorized caller)
//   POST   → transfer to another account, by verified email
import type { NextResponse } from "next/server";
import {
  clearSiteOwner,
  getUserByVerifiedEmail,
  rbacTransaction,
  toSite,
} from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { requireActor, resolveCapability, resolveViewer, atLeast } from "@/lib/authz";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import { csrfSafe, resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../../_util";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor } = await requireActor(request, view.site, "owner");
    await clearSiteOwner(view.site.id);
    await recordSiteAudit(
      view.site.id,
      "disown",
      apiAuditContext(request, actor),
    );
    return json({ ok: true, ownerId: null }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const session = await resolveSession(request);
    if (!atLeast(await resolveCapability(resolveViewer(request, session), view.site), "owner"))
      throw new EditForbiddenError("Site ownership access required");

    const body = (await request.json()) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) return json({ error: "email is required" }, 400);

    const target = await getUserByVerifiedEmail(email);
    if (!target)
      return json(
        {
          error:
            "No user with this email has signed in here, or the email is unverified",
          code: "user_not_found",
        },
        404,
      );

    const actor = await rbacTransaction(async (q) => {
      const [row] = await q(
        "SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL",
        [view.site.id],
      );
      if (!row) throw new AuthError("Site no longer exists");
      const site = toSite(row);
      const { actor } = await requireActor(request, site, "owner", session);
      const members = await q(
        "SELECT m.user_id FROM tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND u.disabled_at IS NULL",
        [site.tenantId, target.id],
      );
      if (!members.length)
        throw new EditForbiddenError(
          "The new owner must be an active member of this tenant",
        );
      await q(
        "UPDATE sites SET owner_id=$1,anon_owner_id=NULL,updated_at=$2 WHERE id=$3",
        [target.id, Date.now(), site.id],
      );
      await recordRbacAudit(
        q,
        site.tenantId,
        actor.userId,
        "site.owner.transfer",
        site.id,
        target.id,
      );
      return actor;
    });
    await recordSiteAudit(
      view.site.id,
      "transfer",
      apiAuditContext(request, actor),
    );
    return json({ ok: true, ownerId: target.id }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
