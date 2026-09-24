import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  "ALTER TABLE comment_messages ADD COLUMN IF NOT EXISTS rich_content JSONB",
  // Rows intentionally survive parent deletion until the private bytes have been removed.
  `CREATE TABLE IF NOT EXISTS comment_attachments (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, version_id TEXT NOT NULL, share_id TEXT, owner_id TEXT NOT NULL, message_id TEXT, name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size BIGINT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at BIGINT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, deleted_at BIGINT)`,
  "CREATE INDEX IF NOT EXISTS idx_comment_attachments_message ON comment_attachments(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_comment_attachments_cleanup ON comment_attachments(deleted_at,created_at)",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  if (dialect === "postgres") await q(statements[0]);
  else if (!(await q("PRAGMA table_info(comment_messages)")).some(c => c.name === "rich_content")) await q(statements[0].replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
  for (const sql of statements.slice(1)) await q(sql);
}
