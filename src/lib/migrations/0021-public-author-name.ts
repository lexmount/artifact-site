import type { RbacQuery } from "@/lib/rbac-store";

// Do not backfill display_name: older OIDC logins stored login identifiers there.
export const statements = ["ALTER TABLE users ADD COLUMN IF NOT EXISTS public_display_name TEXT"];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") await q(statements[0]);
  else if (!(await q("PRAGMA table_info(users)")).some(column => column.name === "public_display_name"))
    await q(statements[0].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
}
