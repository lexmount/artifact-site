import type { RbacQuery } from "@/lib/rbac-store";
export const statements = ["ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0"];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") await q(statements[0]);
  else if (!(await q("PRAGMA table_info(site_shares)")).some(c => c.name === "revision")) await q(statements[0].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
}
