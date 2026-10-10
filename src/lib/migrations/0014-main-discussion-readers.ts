import type { RbacQuery } from "@/lib/rbac-store";
export const statements = ["ALTER TABLE site_comment_settings ADD COLUMN reader_access INTEGER NOT NULL DEFAULT 0 CHECK(reader_access IN (0,1))"];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "sqlite") {
    const columns = await q("PRAGMA table_info(site_comment_settings)");
    if (!columns.some(column => column.name === "reader_access")) await q(statements[0]);
  } else await q(statements[0].replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"));
}
