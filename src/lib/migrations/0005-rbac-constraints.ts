import type { RbacQuery } from "@/lib/rbac-store";
// Additive constraints: old invalid rows remain diagnosable; new writes cannot add violations.
// Do not delete or reassign historical reports during a security upgrade.
export const statements = [
  "ALTER TABLE sites ADD CONSTRAINT sites_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID",
  "ALTER TABLE site_shares ADD CONSTRAINT shares_site_version_fk FOREIGN KEY (site_id,version_id) REFERENCES versions(site_id,id) ON DELETE CASCADE NOT VALID",
  "ALTER TABLE sites ADD CONSTRAINT official_site_version_fk FOREIGN KEY (id,official_version_id) REFERENCES versions(site_id,id) ON DELETE SET NULL (official_version_id) NOT VALID",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") {
    const [server] = await q("SHOW server_version_num");
    if (!(Number(server?.server_version_num) >= 150000)) {
      throw new Error("PostgreSQL 15 or newer is required for RBAC relationship constraints; upgrade the database before starting this version");
    }
    for (const statement of statements) {
      const [, table, name] = /ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/.exec(statement)!;
      const existing = await q("SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$2", [table, name]);
      if (!existing.length) await q(statement);
    }
    return;
  }
  // SQLite cannot add foreign keys without rebuilding tables. Enforce equivalent new-write
  // relationship checks without disturbing legacy rows; existing version FKs handle deletion.
  for (const event of ["INSERT", "UPDATE"] as const) {
    const update = event === "UPDATE";
    for (const prefix of ["sites_tenant", "shares_version", "official_version"]) {
      await q(`DROP TRIGGER IF EXISTS ${prefix}_${event.toLowerCase()}`);
    }
    await q(`CREATE TRIGGER sites_tenant_${event.toLowerCase()} BEFORE ${update ? "UPDATE OF tenant_id" : event} ON sites
      WHEN ${update ? "NEW.tenant_id IS NOT OLD.tenant_id AND" : ""} NOT EXISTS (SELECT 1 FROM tenants WHERE id=NEW.tenant_id)
      BEGIN SELECT RAISE(ABORT, 'Invalid site tenant'); END`);
    await q(`CREATE TRIGGER shares_version_${event.toLowerCase()} BEFORE ${update ? "UPDATE OF site_id, version_id" : event} ON site_shares
      WHEN ${update ? "(NEW.site_id IS NOT OLD.site_id OR NEW.version_id IS NOT OLD.version_id) AND" : ""}
        NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions WHERE site_id=NEW.site_id AND id=NEW.version_id)
      BEGIN SELECT RAISE(ABORT, 'Share version belongs to another site'); END`);
    await q(`CREATE TRIGGER official_version_${event.toLowerCase()} BEFORE ${update ? "UPDATE OF id, official_version_id" : event} ON sites
      WHEN ${update ? "(NEW.id IS NOT OLD.id OR NEW.official_version_id IS NOT OLD.official_version_id) AND" : ""}
        NEW.official_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions WHERE site_id=NEW.id AND id=NEW.official_version_id)
      BEGIN SELECT RAISE(ABORT, 'Official version belongs to another site'); END`);
  }
}
