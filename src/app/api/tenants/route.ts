import { z } from "zod";
import { tenantSlug } from "@/lib/tenant-management";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { putTenantAdmin } from "@/lib/role-bindings";
import {
  createId,
  rbacQuery,
  rbacTransaction,
  getUser,
  getUserByVerifiedEmail,
} from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { requireAdminWrite, resolveAdmin } from "@/lib/admin";
import { recordRbacAudit } from "@/lib/rbac-access";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../_util";
export async function GET(request: Request) {
  try {
    const session = await resolveSession(request);
    const admin = await resolveAdmin(request, session);
    if (!session && !admin) throw new AuthError("Please sign in first");
    const rows = admin
      ? await rbacQuery("SELECT t.id,t.name,COALESCE(t.slug,t.id) AS slug,t.disabled_at,(SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) AS default_user_count,(SELECT COUNT(*) FROM sites s WHERE s.tenant_id=t.id AND s.deleted_at IS NULL) AS site_count FROM tenants t ORDER BY t.name,t.id")
      : await rbacQuery(
          "SELECT t.id,t.name,COALESCE(t.slug,t.id) AS slug,t.disabled_at,m.role FROM tenants t JOIN authorization_tenant_members m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.id",
          [session!.userId],
        );
    return json({
      tenants: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        disabledAt: r.disabled_at,
        role: r.role ?? "platform-admin",
        ...(admin ? { defaultUserCount: Number(r.default_user_count), siteCount: Number(r.site_count) } : {}),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdminWrite(request);
    const body = z.object({ slug: z.unknown(), name: z.string().trim().min(1).max(100), adminEmail: z.string().optional(), adminUserId: z.string().optional() }).strict().parse(await request.json());
    const slug = tenantSlug(body.slug);
    const id = createId("tenant");
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100
    )
      return json({ error: "name is required (at most 100 characters)" }, 400);
    const user =
      typeof body.adminEmail === "string"
        ? await getUserByVerifiedEmail(body.adminEmail.trim())
        : typeof body.adminUserId === "string"
          ? await getUser(body.adminUserId)
          : null;
    if (!user || user.disabledAt)
      return json({ error: "An active adminUserId is required" }, 400);
    const session = await resolveSession(request);
    await rbacTransaction(async (q) => {
      await assertSessionCurrent(q, session);
      await requireAdminWrite(request);
      if (!(await q("SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL", [user.id])).length)
        throw Object.assign(new Error("An active account is required"), { statusCode: 400 });
      if ((await q("SELECT id FROM tenants WHERE LOWER(COALESCE(slug,id))=$1", [slug])).length)
        throw Object.assign(new Error("This workspace identifier is already in use"), { statusCode: 409 });
      const inserted = await q("INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [
        id,
        body.name.trim(),
        slug,
      ]);
      if (!inserted.length)
        throw Object.assign(new Error("This workspace identifier is already in use"), { statusCode: 409 });
      await q(
        "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
        [id, user.id],
      );
      await putTenantAdmin(q,id,user.id,true,actor.userId);
      await recordRbacAudit(
        q,
        id,
        actor.userId,
        "tenant.create",
        id,
        "created",
      );
    });
    return json({ id, slug }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
