import type { RbacQuery } from "@/lib/rbac-store";
// 0010 is reserved for comment attachments. These columns do not depend on it;
// both migrations remain additive when branches are deployed in either order.
export const statements = [
  "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS result_associated_by TEXT",
  "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS result_associated_at BIGINT",
  "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS result_actor_kind TEXT",
  "CREATE INDEX IF NOT EXISTS comment_messages_participant ON comment_messages(author_user_id,thread_id)",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  for (const statement of statements) {
    if (dialect === "sqlite" && statement.startsWith("ALTER")) {
      const column = /^ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS (\w+)\s/.exec(statement)?.[1];
      if (!column) throw new Error("Unexpected comment result migration statement");
      if (!(await q("PRAGMA table_info(comment_threads)")).some(c => c.name === column)) await q(statement.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
    } else await q(statement);
  }
}
