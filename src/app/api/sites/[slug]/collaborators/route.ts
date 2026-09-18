import { assertSessionCurrent } from "@/lib/authorized-commit";
import type { NextResponse } from "next/server";
import { toSite, getUserByVerifiedEmail, rbacQuery, rbacTransaction } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { requirePermission } from "@/lib/authz";
import { memberRole, recordRbacAudit } from "@/lib/rbac-access";
import { csrfSafe, resolveSession } from "@/lib/session";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import { errorResponse, json } from "../../../_util";

type Context = { params: Promise<{ slug: string }> };
export async function GET(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  try {
    const view = await getSiteView((await context.params).slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requirePermission(request, view.site, "site.members.manage");
    const rows = await rbacQuery(
      "SELECT m.user_id,m.role,m.granted_at,u.email,u.display_name FROM site_members m JOIN users u ON u.id=m.user_id WHERE m.site_id=$1 ORDER BY m.granted_at",
      [view.site.id],
    );
    return json({
      collaborators: rows.map((r) => ({
        userId: r.user_id,
        role: r.role,
        email: r.email,
        displayName: r.display_name,
        grantedAt: Number(r.granted_at),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const view = await getSiteView((await context.params).slug);
    if (!view) return json({ error: "site not found" }, 404);
    const session = await resolveSession(request);
    // Reject unauthorized callers before resolving the target email; the transaction rechecks roles.
    await requirePermission(request, view.site, "site.members.manage", session, false);
    const body = await request.json();
    const role = body.role ?? "editor";
    if (role !== "admin" && role !== "editor")
      return json({ error: "role must be admin or editor" }, 400);
    const user =
      typeof body.email === "string"
        ? await getUserByVerifiedEmail(body.email.trim())
        : null;
    if (!user || user.disabledAt)
      return json(
        {
          error: "An active account with a verified email is required",
          code: "user_not_found",
        },
        404,
      );
    await rbacTransaction(async (q) => {
      await assertSessionCurrent(q, session);
      const [row] = await q("SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL", [view.site.id]);
      if (!row) throw new EditForbiddenError("Site no longer exists");
      const site = toSite(row);
      const [old] = await q(
        "SELECT role FROM site_members WHERE site_id=$1 AND user_id=$2",
        [view.site.id, user.id],
      );
      const { actor } = await requirePermission(
        request,
        site,
        role === "admin" || old?.role === "admin"
          ? "site.admins.manage"
          : "site.members.manage",
        session,
      );
      if (user.id === site.ownerId)
        throw new EditForbiddenError(
          "The owner's role is changed through ownership transfer",
        );
      if (!(await memberRole(site.tenantId, user.id)))
        throw new EditForbiddenError(
          "Site members must belong to the site's tenant; use a share link for external collaborators",
        );
      await q(
        "INSERT INTO site_members(site_id,user_id,role,granted_by,granted_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(site_id,user_id) DO UPDATE SET role=excluded.role,granted_by=excluded.granted_by",
        [view.site.id, user.id, role, actor.userId, Date.now()],
      );
      await recordRbacAudit(
        q,
        site.tenantId,
        actor.userId,
        "site.member.change",
        view.site.id,
        JSON.stringify({userId:user.id,role}),
      );
    });
    return json({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(
  request: Request,
  context: Context,
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const view = await getSiteView((await context.params).slug);
    if (!view) return json({ error: "site not found" }, 404);
    const session = await resolveSession(request);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId is required" }, 400);
    await rbacTransaction(async (q) => {
      await assertSessionCurrent(q, session);
      const [row] = await q("SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL", [view.site.id]);
      if (!row) throw new EditForbiddenError("Site no longer exists");
      const site = toSite(row);
      const [old] = await q(
        "SELECT role FROM site_members WHERE site_id=$1 AND user_id=$2",
        [view.site.id, userId],
      );
      const { actor } = await requirePermission(
        request,
        site,
        old?.role === "admin" ? "site.admins.manage" : "site.members.manage",
        session,
      );
      if (!old) return;
      await q("DELETE FROM site_members WHERE site_id=$1 AND user_id=$2", [
        view.site.id,
        userId,
      ]);
      await recordRbacAudit(
        q,
        site.tenantId,
        actor.userId,
        "site.member.remove",
        view.site.id,
        JSON.stringify({userId}),
      );
    });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
