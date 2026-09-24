import { databaseRoleAllows, putTenantAdmin } from "@/lib/role-bindings";
import { managementReason } from "@/lib/management-reason";
import "server-only";
import { createId, getUser, rbacQuery, rbacTransaction } from "@/lib/db";
import { resolveAdmin } from "@/lib/admin";
import { EditForbiddenError } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { isTokenSession } from "@/lib/publish-token";
import {
  ANONYMOUS_TENANT,
  INIT_TENANT,
  type Permission,
  type ResourceRole,
  type SiteRole,
  type TenantRole,
} from "@/lib/rbac";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Session, Site } from "@/lib/types";

export async function tenantActive(id: string): Promise<boolean> {
  return (
    (
      await rbacQuery(
        "SELECT id FROM tenants WHERE id=$1 AND disabled_at IS NULL",
        [id],
      )
    ).length > 0
  );
}
export async function memberRole(
  tenantId: string,
  userId: string,
): Promise<TenantRole | null> {
  const [row] = await rbacQuery(
    "SELECT m.role FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND t.disabled_at IS NULL AND u.disabled_at IS NULL",
    [tenantId, userId],
  );
  return (row?.role as TenantRole) ?? null;
}
export async function siteMemberRole(
  siteId: string,
  userId: string,
): Promise<SiteRole | null> {
  const rows = await rbacQuery("SELECT role FROM authorization_site_members WHERE site_id=$1 AND user_id=$2",[siteId,userId]);
  return ["admin","editor","commenter","viewer"].find(role=>rows.some(row=>row.role===role)) as SiteRole | undefined ?? null;
}
export async function accountSiteRole(site: Site, session: Pick<Session, "userId"> | null): Promise<ResourceRole | null> {
  if (!session || !(await tenantActive(site.tenantId))) return null;
  const [user] = await rbacQuery("SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL", [session.userId]);
  if (!user) return null;
  if (site.ownerId === session.userId && await memberRole(site.tenantId,session.userId)) return "owner";
  const role=await siteMemberRole(site.id,session.userId);
  return role === "admin" ? "site-admin" : role;
}
/** Elevated governance requires an explicit reason and a browser session, not a delegated agent token. */
export async function managementRole(
  request: Request,
  site: Site,
  session: Session | null,
): Promise<ResourceRole | null> {
  const reason = managementReason(request);
  if (!reason) return null;
  const platform = await resolveAdmin(request, session);
  if (platform) return "platform-admin";
  if (
    session &&
    !isTokenSession(session) &&
    (await memberRole(site.tenantId, session.userId)) === "admin"
  )
    return "tenant-admin";
  return null;
}
export async function recordRbacAudit(
  q: RbacQuery,
  tenantId: string,
  actorId: string | null,
  action: string,
  targetId: string,
  reason: string,
): Promise<void> {
  await q(
    "INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [createId("rba"), tenantId, actorId, action, targetId, reason, Date.now()],
  );
}
export async function requireTenantManager(
  request: Request,
  tenantId: string,
  existingSession?: Session | null,
): Promise<Session | null> {
  const session = existingSession === undefined ? await resolveSession(request) : existingSession;
  if (
    !(await resolveAdmin(request, session)) &&
    (!session ||
      isTokenSession(session) ||
      (await memberRole(tenantId, session.userId)) !== "admin")
  )
    throw new EditForbiddenError("Tenant administrator access required");
  if (!(await rbacQuery("SELECT id FROM tenants WHERE id=$1", [tenantId])).length)
    throw Object.assign(new Error("Tenant not found"), { statusCode: 404 });
  if (tenantId === ANONYMOUS_TENANT)
    throw new EditForbiddenError(
      "The anonymous tenant has no editable membership",
    );
  return session;
}
export async function creationTenant(
  userId: string | null,
  requested?: string,
): Promise<string> {
  if (!userId) {
    if (requested && requested !== ANONYMOUS_TENANT)
      throw new EditForbiddenError(
        "Anonymous artifacts belong to the anonymous tenant",
      );
    if (!(await tenantActive(ANONYMOUS_TENANT)))
      throw new EditForbiddenError("Tenant is disabled");
    return ANONYMOUS_TENANT;
  }
  const tenantId =
    requested || (await getUser(userId))?.tenantId || INIT_TENANT;
  if (tenantId === ANONYMOUS_TENANT || !(await memberRole(tenantId, userId)))
    throw new EditForbiddenError(
      "Active tenant membership required to create artifacts",
    );
  return tenantId;
}
/** Serializes all membership changes, including concurrent attempts to remove the last administrator. */
export async function changeTenantMember(
  request: Request,
  tenantId: string,
  userId: string,
  role: TenantRole | null,
): Promise<void> {
  // Resolve identity before acquiring the global RBAC lock; role reads use its transaction.
  const session = await resolveSession(request);
  const platform = await resolveAdmin(request, session);
  const { assertSessionCurrent } = await import("@/lib/authorized-commit");
  await rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    const [manager] = session
      ? await q(
          "SELECT m.role FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND u.disabled_at IS NULL",
          [tenantId, session.userId],
        )
      : [];
    if (
      !platform &&
      (!session || isTokenSession(session) || manager?.role !== "admin")
    )
      throw new EditForbiddenError("Tenant administrator access required");
    if (tenantId === ANONYMOUS_TENANT)
      throw new EditForbiddenError("The anonymous tenant has no members");
    const [tenant] = await q("SELECT * FROM tenants WHERE id=$1", [tenantId]);
    const [user] = await q(
      "SELECT id,disabled_at FROM users WHERE id=$1",
      [userId],
    );
    if (!tenant || tenant.disabled_at != null || !user || (role !== null && user.disabled_at != null))
      throw new EditForbiddenError("Active tenant and account required");
    const [existing] = await q(
      "SELECT role FROM authorization_tenant_members WHERE tenant_id=$1 AND user_id=$2",
      [tenantId, userId],
    );
    if (existing?.role === "admin" && role !== "admin" && user.disabled_at == null) {
      const admins = await q(
        "SELECT m.user_id FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='admin' AND u.disabled_at IS NULL",
        [tenantId],
      );
      if (admins.length <= 1)
        throw new EditForbiddenError(
          "Cannot remove the last active tenant administrator",
        );
    }
    if (role === null) {
      if (
        (
          await q(
            "SELECT id FROM sites WHERE tenant_id=$1 AND owner_id=$2 AND deleted_at IS NULL",
            [tenantId, userId],
          )
        ).length
      )
        throw new EditForbiddenError(
          "Transfer owned sites before removing this member",
        );
      await q(
        "DELETE FROM role_bindings WHERE subject_user_id=$1 AND resource_site_id IN (SELECT id FROM sites WHERE tenant_id=$2)",
        [userId, tenantId],
      );
      await q("DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2", [
        tenantId,
        userId,
      ]);
    } else {
      await q(
        "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [tenantId, userId],
      );
    }
    await putTenantAdmin(q,tenantId,userId,role === "admin",session?.userId ?? null);
    await recordRbacAudit(
      q,
      tenantId,
      session?.userId ?? null,
      "tenant.member.change",
      userId,
      role ?? "removed",
    );
  });
}
export async function assertRolePermission(
  role: ResourceRole | null,
  permission: Permission,
): Promise<void> {
  if (!await databaseRoleAllows(role, permission))
    throw new EditForbiddenError(`Missing permission: ${permission}`);
}
