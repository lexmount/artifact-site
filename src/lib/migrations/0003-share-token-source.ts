import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  "ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS token TEXT",
  "ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS source TEXT",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") {
    for (const statement of statements) await q(statement);
  } else {
    const columns = await q("PRAGMA table_info(site_shares)");
    for (const [index, name] of ["token", "source"].entries())
      if (!columns.some(column => column.name === name))
        await q(statements[index].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
  }
}
