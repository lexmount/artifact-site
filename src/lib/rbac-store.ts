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
