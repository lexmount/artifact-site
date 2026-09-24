import type { RbacQuery } from "@/lib/rbac-store";

// View-only upgrade: never rerun the legacy grant import in 0007.
export const statements = [
  `DROP VIEW IF EXISTS authorization_site_members`,
  // Separate branches let named-user and tenant queries use their indexed joins.
  `CREATE VIEW authorization_site_members AS
    SELECT b.resource_site_id AS site_id,u.id AS user_id,CASE WHEN b.role_id='site-admin' THEN 'admin' ELSE b.role_id END AS role,b.created_by AS granted_by,b.created_at AS granted_at,b.id AS binding_id,b.subject_type
    FROM role_bindings b JOIN sites s ON s.id=b.resource_site_id JOIN tenants t ON t.id=s.tenant_id
    JOIN users u ON u.id=b.subject_user_id JOIN tenant_members m ON m.tenant_id=s.tenant_id AND m.user_id=u.id
    WHERE b.subject_type='user' AND t.disabled_at IS NULL AND u.disabled_at IS NULL
    UNION ALL
    SELECT b.resource_site_id,u.id,CASE WHEN b.role_id='site-admin' THEN 'admin' ELSE b.role_id END,b.created_by,b.created_at,b.id,b.subject_type
    FROM role_bindings b JOIN sites s ON s.id=b.resource_site_id AND s.tenant_id=b.subject_tenant_id JOIN tenants t ON t.id=s.tenant_id
    JOIN tenant_members m ON m.tenant_id=b.subject_tenant_id JOIN users u ON u.id=m.user_id
    WHERE b.subject_type='tenant' AND t.disabled_at IS NULL AND u.disabled_at IS NULL
    UNION ALL
    SELECT b.resource_site_id,u.id,b.role_id,b.created_by,b.created_at,b.id,b.subject_type
    FROM role_bindings b JOIN sites s ON s.id=b.resource_site_id JOIN tenants t ON t.id=s.tenant_id
    JOIN users u ON u.disabled_at IS NULL
    WHERE b.subject_type='everyone' AND t.disabled_at IS NULL AND s.taken_down_at IS NULL`,
];
export async function up(q: RbacQuery) {
  for (const statement of statements) await q(statement);
}
