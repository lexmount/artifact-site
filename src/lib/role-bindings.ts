import "server-only";
import { createId, rbacQuery } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Permission, ResourceRole } from "@/lib/rbac";
/** Database-backed catalog. No cross-request cache: catalog changes are visible immediately. Binding revocation is checked separately. */
export async function rolePermissions(
  role: ResourceRole | null,
): Promise<Permission[]> {
  if (!role) return [];
  return (
    await rbacQuery(
      "SELECT permission_code FROM role_permissions WHERE role_id=$1",
      [role],
    )
  ).map((r) => r.permission_code as Permission);
}
export async function databaseRoleAllows(
  role: ResourceRole | null,
  permission: Permission,
) {
  return (await rolePermissions(role)).includes(permission);
}
/** Internal mutation helpers; callers must authorize under rbacTransaction. */
export async function putUserSiteRole(
  q: RbacQuery,
  siteId: string,
  userId: string,
  role: string | null,
  actor: string | null,
) {
  const [old] = await q(
    "SELECT id FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2",
    [siteId, userId],
  );
  if (role === null) {
    await q(
      "DELETE FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2",
      [siteId, userId],
    );
    return;
  }
  const roleId = role === "admin" ? "site-admin" : role;
  const now = Date.now();
  if (old)
    await q(
      "UPDATE role_bindings SET role_id=$1,updated_at=$2,revision=revision+1 WHERE id=$3",
      [roleId, now, old.id as string],
    );
  else
    await q(
      "INSERT INTO role_bindings(id,subject_type,subject_user_id,resource_type,resource_site_id,role_id,created_by,created_at,updated_at) VALUES($1,'user',$2,'site',$3,$4,$5,$6,$6)",
      [createId("binding"), userId, siteId, roleId, actor, now],
    );
}
export async function putTenantAdmin(
  q: RbacQuery,
  tenantId: string,
  userId: string,
  admin: boolean,
  actor: string | null,
) {
  if (!admin) {
    await q(
      "DELETE FROM role_bindings WHERE resource_tenant_id=$1 AND subject_user_id=$2",
      [tenantId, userId],
    );
    return;
  }
  const now = Date.now();
  await q(
    "INSERT INTO role_bindings(id,subject_type,subject_user_id,resource_type,resource_tenant_id,role_id,created_by,created_at,updated_at) VALUES($1,'user',$2,'tenant',$3,'tenant-admin',$4,$5,$5) ON CONFLICT DO NOTHING",
    [createId("binding"), userId, tenantId, actor, now],
  );
}
export async function everyoneRole(
  siteId: string,
): Promise<ResourceRole | null> {
  const [row] = await rbacQuery(
    "SELECT b.role_id FROM role_bindings b JOIN sites s ON s.id=b.resource_site_id JOIN tenants t ON t.id=s.tenant_id WHERE b.resource_site_id=$1 AND b.subject_type='everyone' AND s.taken_down_at IS NULL AND s.deleted_at IS NULL AND t.disabled_at IS NULL",
    [siteId],
  );
  return (row?.role_id as ResourceRole) ?? null;
}
