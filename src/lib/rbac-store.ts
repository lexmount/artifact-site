import "server-only";
import type { Row } from "@/lib/db";
export type RbacQuery = (
  sql: string,
  params?: readonly (string | number | null)[],
) => Promise<Row[]>;
export type RbacTransaction = <T>(
  work: (query: RbacQuery) => Promise<T>,
) => Promise<T>;
// Called after the existing tables/columns exist, under the driver's migration transaction.
export async function migrateRbac(q: RbacQuery): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS publish_operations (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    lease TEXT NOT NULL,
    lease_until BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    result TEXT,
    http_status INTEGER,
    client_fingerprint TEXT
  )`);
  await q("CREATE INDEX IF NOT EXISTS idx_publish_operations_expiry ON publish_operations(expires_at)");
  await q(`CREATE TABLE IF NOT EXISTS preview_secret (
    id TEXT PRIMARY KEY CHECK (id='active'),
    secret TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    disabled_at BIGINT
  )`);
  await q(
    `INSERT INTO tenants (id,name) VALUES ('init','init'),('anonymous','anonymous') ON CONFLICT (id) DO NOTHING`,
  );
  await q(`CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','member')), PRIMARY KEY(tenant_id,user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS site_members (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','editor')),
    granted_by TEXT,
    granted_at BIGINT NOT NULL, PRIMARY KEY(site_id,user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS rbac_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  for (const table of ["audit_log", "admin_log", "rbac_audit"]) {
    await q(`CREATE INDEX IF NOT EXISTS idx_${table}_retention ON ${table}(created_at,id)`);
  }
  await q(`CREATE TABLE IF NOT EXISTS rbac_migrations (
    id TEXT PRIMARY KEY
  )`);
  if (!(await q(`SELECT id FROM rbac_migrations WHERE id='initial'`)).length) {
    await q(`UPDATE users SET tenant_id='init'`);
    await q(
      `INSERT INTO tenant_members (tenant_id,user_id,role) SELECT 'init',id,'member' FROM users WHERE 1=1 ON CONFLICT DO NOTHING`,
    );
    await q(
      `UPDATE sites SET tenant_id=CASE WHEN owner_id IS NULL THEN 'anonymous' ELSE 'init' END`,
    );
    await q(
      `INSERT INTO site_members (site_id,user_id,role,granted_by,granted_at) SELECT site_id,user_id,'editor',granted_by,granted_at FROM site_collaborators WHERE 1=1 ON CONFLICT DO NOTHING`,
    );
    await q(`UPDATE sites SET edit_policy='owner'`);
    await q(`INSERT INTO rbac_migrations (id) VALUES ('initial')`);
  }
  await q(
    `CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id,updated_at)`,
  );
  await q(
    `CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id,tenant_id)`,
  );
  await q(
    `CREATE INDEX IF NOT EXISTS idx_site_members_user ON site_members(user_id,site_id)`,
  );
  if (!(await q("SELECT id FROM rbac_migrations WHERE id='retire-owned-edit-tokens'")).length) {
    await q("UPDATE sites SET edit_token='',claim_token=NULL WHERE owner_id IS NOT NULL");
    await q("INSERT INTO rbac_migrations(id) VALUES('retire-owned-edit-tokens')");
  }

}

/** A removed member must not be re-added at the next login. NULL marks only new accounts. */
export async function initializeUserTenant(
  q: RbacQuery,
  userId: string,
): Promise<void> {
  const fresh = await q(
    "UPDATE users SET tenant_id='init' WHERE id=$1 AND tenant_id IS NULL RETURNING id",
    [userId],
  );
  if (fresh.length)
    await q(
      "INSERT INTO tenant_members (tenant_id,user_id,role) VALUES ('init',$1,'member') ON CONFLICT DO NOTHING",
      [userId],
    );
}

/** Apply tenant scope before LIMIT, identically in both stores. */
export async function searchTenantUsers(query: RbacQuery, term: string, viewerId: string, limit: number): Promise<Row[]> {
  const pattern = `${term.replace(/[\\%_]/g, "\\$&")}%`;
  return query(`SELECT u.* FROM users u
      WHERE u.disabled_at IS NULL
        AND (lower(u.display_name) LIKE lower($1) ESCAPE '\\'
          OR (u.email_verified AND lower(u.email) LIKE lower($1) ESCAPE '\\'))
        AND EXISTS (SELECT 1 FROM tenant_members mine
          JOIN tenant_members other ON other.tenant_id=mine.tenant_id
          JOIN tenants t ON t.id=mine.tenant_id
          WHERE mine.user_id=$2 AND other.user_id=u.id AND t.disabled_at IS NULL)
      ORDER BY COALESCE(u.last_login_at,0) DESC,u.id LIMIT $3`, [pattern, viewerId, limit]);
}
