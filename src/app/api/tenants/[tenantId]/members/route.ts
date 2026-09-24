import { rbacQuery, getUserByVerifiedEmail } from "@/lib/db";
import { changeTenantMember, requireTenantManager } from "@/lib/rbac-access";
import { csrfSafe } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../../../_util";
type Context = { params: Promise<{ tenantId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { tenantId } = await context.params;
    await requireTenantManager(request, tenantId);
    const members = await rbacQuery(
      "SELECT m.user_id,m.role,u.display_name,u.email FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.display_name,u.id",
      [tenantId],
    );
    return json({ members });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(request: Request, context: Context) {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { tenantId } = await context.params;
    const body = await request.json();
    await requireTenantManager(request, tenantId);
    if (typeof body.email === "string") {
      body.userId = (await getUserByVerifiedEmail(body.email.trim()))?.id;
      if (!body.userId) return json({ error: "No account with this verified email", code: "user_not_found" }, 404);
    }
    if (
      typeof body.userId !== "string" ||
      !["admin", "member", null].includes(body.role)
    )
      return json(
        {
          error:
            "userId and role (admin, member or null to remove) are required",
        },
        400,
      );
    await changeTenantMember(request, tenantId, body.userId, body.role);
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
