import { rbacQuery } from "@/lib/db";
/** Reconstruct only retired PR1 storage for migration tests; never used by runtime code. */
export async function restorePreCleanupSchema() {
  await rbacQuery("ALTER TABLE tenant_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  await rbacQuery("ALTER TABLE sites ADD COLUMN claim_token TEXT");
  await rbacQuery("ALTER TABLE sites ADD COLUMN edit_policy TEXT NOT NULL DEFAULT 'owner'");
  await rbacQuery("CREATE TABLE site_members(site_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,granted_by TEXT,granted_at BIGINT NOT NULL,PRIMARY KEY(site_id,user_id))");
  await rbacQuery("CREATE TABLE site_collaborators(site_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'editor',granted_by TEXT,granted_at BIGINT NOT NULL,PRIMARY KEY(site_id,user_id))");
  await rbacQuery("DELETE FROM schema_migrations WHERE id='0009-authorization-cleanup'");
}
