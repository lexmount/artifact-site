import type { RbacQuery } from "@/lib/rbac-store";

export const statements = [
  "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug TEXT",
  "UPDATE tenants SET slug=id WHERE slug IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_unique ON tenants (LOWER(COALESCE(slug,id)))",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") await q(statements[0]);
  else if (!(await q("PRAGMA table_info(tenants)")).some(c => c.name === "slug"))
    await q(statements[0].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
  for (const sql of statements.slice(1)) await q(sql);
}
