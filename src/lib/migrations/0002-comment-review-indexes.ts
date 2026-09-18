import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS result_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL",
  "CREATE INDEX IF NOT EXISTS comment_threads_creation ON comment_threads(space_id,created_at,id)",
  "CREATE INDEX IF NOT EXISTS comment_threads_author ON comment_threads(created_by,space_id,created_at,id)",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") await q(statements[0]);
  else {
    // SQLite lacks ADD COLUMN IF NOT EXISTS. Inspect only the specific column; other failures
    // must propagate so a partially applied schema cannot be recorded as successful.
    const columns = await q("PRAGMA table_info(comment_threads)");
    if (!columns.some(column => column.name === "result_version_id"))
      await q(statements[0].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
  }
  for (const statement of statements.slice(1)) await q(statement);
}
