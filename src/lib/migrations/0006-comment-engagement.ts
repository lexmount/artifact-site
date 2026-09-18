import type { RbacQuery } from "@/lib/rbac-store";
// Site likes retain their existing anonymous identity rules. Message reactions require an account.
export const statements = [
  `CREATE TABLE IF NOT EXISTS comment_reactions (message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 128), created_at BIGINT NOT NULL, PRIMARY KEY(message_id,user_id,emoji))`,
  `CREATE TABLE IF NOT EXISTS comment_read_scopes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, scope_key TEXT NOT NULL, read_through BIGINT NOT NULL, PRIMARY KEY(user_id,site_id,scope_key))`,
  `CREATE TABLE IF NOT EXISTS comment_read_messages (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, PRIMARY KEY(user_id,message_id))`,
  `CREATE INDEX IF NOT EXISTS idx_comment_receipt_message ON comment_read_messages(message_id,user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_unread_time ON comment_messages(created_at,id)`,
];
export async function up(q: RbacQuery) { for (const statement of statements) await q(statement); }
