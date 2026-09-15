import { assertSessionCurrent } from "@/lib/authorized-commit";
import { rbacTransaction, rbacQuery } from "@/lib/db";
import { requireAdminWrite } from "@/lib/admin";
import { requireTenantManager, recordRbacAudit } from "@/lib/rbac-access";
import { csrfSafe } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../../_util";
type Context = { params: Promise<{ tenantId: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { tenantId } = await context.params;
    const body = await request.json();
    const session = await requireTenantManager(request, tenantId);
    if (body.disabled !== undefined) await requireAdminWrite(request);
    if (body.disabled !== undefined && typeof body.disabled !== "boolean")
      return json({ error: "disabled must be boolean" }, 400);
    if (
      body.name !== undefined &&
      (typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 100)
    )
      return json({ error: "Invalid name" }, 400);
    await rbacTransaction(async (q) => {
      await assertSessionCurrent(q, session);
      await requireTenantManager(request,tenantId,session);
      if (body.name !== undefined)
        await q("UPDATE tenants SET name=$1 WHERE id=$2", [
          body.name.trim(),
          tenantId,
        ]);
      if (body.disabled !== undefined)
        await q("UPDATE tenants SET disabled_at=$1 WHERE id=$2", [
          body.disabled ? Date.now() : null,
          tenantId,
        ]);
      await recordRbacAudit(
        q,
        tenantId,
        session?.userId ?? null,
        "tenant.update",
        tenantId,
        "settings changed",
      );
    });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function GET(request: Request, context: Context) {
  try {
    const { tenantId } = await context.params;
    await requireTenantManager(request, tenantId);
    const sites = await rbacQuery(
      "SELECT id,slug,title,owner_id,deleted_at,taken_down_at FROM sites WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 200",
      [tenantId],
    );
    const audit = await rbacQuery(
      "SELECT actor_id,action,target_id,reason,created_at FROM rbac_audit WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",
      [tenantId],
    );
    return json({ sites, audit });
  } catch (e) {
    return errorResponse(e);
  }
}
