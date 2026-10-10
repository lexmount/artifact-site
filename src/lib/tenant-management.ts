import "server-only";
import { BadRequestError } from "@/lib/errors";
import { rbacTransaction } from "@/lib/db";
import { requireAdminWrite } from "@/lib/admin";
import { resolveSession } from "@/lib/session";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { recordRbacAudit } from "@/lib/rbac-access";

export function tenantSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(slug))
    throw new BadRequestError("Use 2–63 lowercase letters, digits or hyphens, starting with a letter");
  if (["init", "anonymous"].includes(slug))
    throw new BadRequestError("This workspace identifier is reserved");
  return slug;
}

/** Membership, the publishing default and its audit commit under the shared RBAC lock. */
export async function changeDefaultTenant(request: Request, userId: string, tenantId: string) {
  await requireAdminWrite(request);
  const session = await resolveSession(request);
  return rbacTransaction(async q => {
    await assertSessionCurrent(q, session);
    const actor = await requireAdminWrite(request);
    const [user] = await q("SELECT tenant_id FROM users WHERE id=$1", [userId]);
    if (!user) throw new BadRequestError("Account not found");
    const [tenant] = await q("SELECT id FROM tenants WHERE id=$1 AND disabled_at IS NULL", [tenantId]);
    if (!tenant || tenantId === "anonymous") throw new BadRequestError("Choose an active account workspace");
    const added = await q("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id", [tenantId, userId]);
    if (user.tenant_id !== tenantId || added.length) {
      await q("UPDATE users SET tenant_id=$1,updated_at=$2 WHERE id=$3", [tenantId, Date.now(), userId]);
      await recordRbacAudit(q, tenantId, actor.userId, "user.default_tenant.change", userId,
        JSON.stringify({ previousTenantId: user.tenant_id, tenantId, membershipAdded: Boolean(added.length) }));
    }
    return { tenantId, membershipAdded: Boolean(added.length) };
  });
}
