import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  "ALTER TABLE versions ADD COLUMN IF NOT EXISTS package_meta TEXT",
  "ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS package_options TEXT",
  "ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS package_lease TEXT",
  "ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS package_lease_until BIGINT",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  for (const sql of statements) {
    const table = sql.split(" ")[2], column = sql.split(" ")[8];
    if (dialect === "postgres") await q(sql);
    else if (!(await q(`PRAGMA table_info(${table})`)).some(c => c.name === column)) await q(sql.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
  }
}
