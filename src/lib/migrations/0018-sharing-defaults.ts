import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  `CREATE TABLE IF NOT EXISTS sharing_defaults (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL CHECK(audience IN ('private','tenant','login','anyone','public')), comments INTEGER NOT NULL CHECK(comments IN (0,1)), updated_at BIGINT NOT NULL, PRIMARY KEY(tenant_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS sharing_scopes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), audience TEXT NOT NULL CHECK(audience IN ('private','tenant','login','anyone','public')), comments INTEGER NOT NULL CHECK(comments IN (0,1)), revision INTEGER NOT NULL DEFAULT 1, updated_at BIGINT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sharing_scope_owner ON sharing_scopes(owner_id,COALESCE(folder_id,''))`,
  `CREATE TABLE IF NOT EXISTS site_sharing_state (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, owner_id TEXT REFERENCES users(id) ON DELETE CASCADE, audience TEXT NOT NULL CHECK(audience IN ('private','tenant','login','anyone','public')), comments INTEGER NOT NULL CHECK(comments IN (0,1)), source TEXT NOT NULL CHECK(source IN ('default','manual','folder','all')), source_id TEXT REFERENCES sharing_scopes(id) ON DELETE SET NULL, revision INTEGER NOT NULL DEFAULT 1, pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1)), updated_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sharing_state_source ON site_sharing_state(source_id)`,
];
export async function up(q: RbacQuery) { for (const sql of statements) await q(sql); }
