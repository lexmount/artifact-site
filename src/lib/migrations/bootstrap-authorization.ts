import type { RbacQuery } from "@/lib/rbac-store";

// Called after the existing tables/columns exist, under the driver's migration transaction.
export async function bootstrapAuthorization(q: RbacQuery, dialect: "postgres" | "sqlite"): Promise<void> {
  // Only needed before the immutable numbered migrations have imported legacy grants.
  const columns = dialect === "sqlite" ? await q("PRAGMA table_info(sites)") : [];
  if (dialect === "postgres") await q("ALTER TABLE sites ADD COLUMN IF NOT EXISTS edit_policy TEXT NOT NULL DEFAULT 'owner'");
  else if (!columns.some(c => c.name === "edit_policy")) await q("ALTER TABLE sites ADD COLUMN edit_policy TEXT NOT NULL DEFAULT 'owner'");
  if (dialect === "postgres") await q("ALTER TABLE sites ADD COLUMN IF NOT EXISTS claim_token TEXT");
  else if (!columns.some(c => c.name === "claim_token")) await q("ALTER TABLE sites ADD COLUMN claim_token TEXT");
  await q(`CREATE TABLE IF NOT EXISTS site_collaborators (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
    granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    granted_at BIGINT NOT NULL, PRIMARY KEY(site_id,user_id)
  )`);
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

