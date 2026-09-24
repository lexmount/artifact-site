import { putTenantAdmin } from "@/lib/role-bindings";
import {
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
      ? await rbacQuery("SELECT id,name,disabled_at FROM tenants ORDER BY id")
      : await rbacQuery(
          "SELECT t.id,t.name,t.disabled_at,m.role FROM tenants t JOIN authorization_tenant_members m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.id",
          [session!.userId],
        );
    return json({
      tenants: rows.map((r) => ({
        id: r.id,
        name: r.name,
        disabledAt: r.disabled_at,
        role: r.role ?? "platform-admin",
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdminWrite(request);
    const body = await request.json();
    if (
      typeof body.id !== "string" ||
      !/^[a-z][a-z0-9-]{1,62}$/.test(body.id) ||
      ["init", "anonymous"].includes(body.id)
    )
      return json(
        {
          error:
            "A unique tenant id is required (2–63 lowercase letters, digits or hyphens)",
        },
        400,
      );
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
    await rbacTransaction(async (q) => {
      if ((await q("SELECT id FROM tenants WHERE id=$1", [body.id])).length)
        throw Object.assign(new Error("Tenant already exists"), { statusCode: 409 });
      await q("INSERT INTO tenants(id,name) VALUES($1,$2)", [
        body.id,
        body.name.trim(),
      ]);
      await q(
        "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
        [body.id, user.id],
      );
      await putTenantAdmin(q,body.id,user.id,true,actor.userId);
      await recordRbacAudit(
        q,
        body.id,
        actor.userId,
        "tenant.create",
        body.id,
        "created",
      );
    });
    return json({ id: body.id }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
