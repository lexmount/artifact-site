import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  "ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS comment_subscriptions (thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL CHECK(state IN ('following','unfollowed')), source TEXT NOT NULL CHECK(source IN ('create','reply','manual')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(thread_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS notification_events (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('comment.reply_created')), message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','agent')), created_at BIGINT NOT NULL, UNIQUE(type,message_id))`,
  `CREATE TABLE IF NOT EXISTS user_notifications (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE, recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL DEFAULT 'following', read_at BIGINT, created_at BIGINT NOT NULL, UNIQUE(event_id,recipient_user_id))`,
  "CREATE INDEX IF NOT EXISTS notification_inbox ON user_notifications(recipient_user_id,created_at DESC,id DESC)",
  "CREATE INDEX IF NOT EXISTS notification_unread ON user_notifications(recipient_user_id,created_at DESC) WHERE read_at IS NULL",
  `CREATE TABLE IF NOT EXISTS share_access_receipts (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id TEXT NOT NULL REFERENCES comment_spaces(id) ON DELETE CASCADE, tenant_id TEXT NOT NULL REFERENCES tenants(id), access_revision BIGINT NOT NULL, verified_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, revoked_at BIGINT, PRIMARY KEY(user_id,space_id))`,
  "CREATE INDEX IF NOT EXISTS share_receipts_expiry ON share_access_receipts(expires_at)",
];
export async function up(q: RbacQuery, dialect: "postgres" | "sqlite") {
  for (const sql of statements) {
    if (dialect === "sqlite" && sql.startsWith("ALTER")) {
      if (
        !(await q("PRAGMA table_info(site_shares)")).some(
          (c) => c.name === "access_revision",
        )
      )
        await q(sql.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN"));
    } else await q(sql);
  }
}
