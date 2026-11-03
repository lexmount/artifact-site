import type { RbacQuery } from "@/lib/rbac-store";
const stateTable = `CREATE TABLE IF NOT EXISTS site_sharing_state_new (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, owner_id TEXT REFERENCES users(id) ON DELETE CASCADE, audience TEXT NOT NULL CHECK(audience IN ('private','tenant','login','anyone','public','passcode')), comments INTEGER NOT NULL CHECK(comments IN (0,1)), source TEXT NOT NULL CHECK(source IN ('default','manual','folder','all')), source_id TEXT REFERENCES sharing_scopes(id) ON DELETE SET NULL, revision INTEGER NOT NULL DEFAULT 1, pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1)), updated_at BIGINT NOT NULL)`;
export const statements = [
  stateTable,
  "ALTER TABLE site_sharing_state DROP CONSTRAINT IF EXISTS site_sharing_state_audience_check",
  "ALTER TABLE site_sharing_state ADD CONSTRAINT site_sharing_state_audience_check CHECK(audience IN ('private','tenant','login','anyone','public','passcode'))",
  "CREATE TABLE IF NOT EXISTS main_passcode_secret (id TEXT PRIMARY KEY, secret TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS main_link_passcodes (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, id TEXT NOT NULL, ciphertext TEXT NOT NULL, passcode_hash TEXT NOT NULL)",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") {
    await q(statements[1]);
    await q(statements[2]);
  } else {
    await q(stateTable);
    await q("INSERT INTO site_sharing_state_new SELECT * FROM site_sharing_state");
    await q("DROP TABLE site_sharing_state");
    await q("ALTER TABLE site_sharing_state_new RENAME TO site_sharing_state");
    await q("CREATE INDEX IF NOT EXISTS sharing_state_source ON site_sharing_state(source_id)");
  }
  for (const sql of statements.slice(3)) await q(sql);
}
