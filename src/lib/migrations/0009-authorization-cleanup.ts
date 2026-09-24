import type { RbacQuery } from "@/lib/rbac-store";

// Run after 0007 imported grants and 0008 installed the binding-backed views.
// No data is copied here: revoked grants must never be reimported.
export const statements = [
  "DROP TABLE IF EXISTS site_invites",
  "DROP TABLE IF EXISTS site_collaborators",
  "DROP TABLE IF EXISTS site_members",
  "DROP TABLE IF EXISTS rbac_migrations",
  "ALTER TABLE tenant_members DROP COLUMN role",
  "ALTER TABLE sites DROP COLUMN edit_policy",
  "ALTER TABLE sites DROP COLUMN claim_token",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  for (const statement of statements) {
    const drop = /^ALTER TABLE (\w+) DROP COLUMN (\w+)$/.exec(statement);
    if (drop) {
      const columns = dialect === "postgres"
        ? await q("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [drop[1]])
        : await q(`PRAGMA table_info(${drop[1]})`);
      if (!columns.some(c => c.name === drop[2])) continue;
    }
    await q(statement);
  }
}
