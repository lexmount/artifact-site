import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  `CREATE TABLE notification_events_next (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('comment.reply_created','comment.mentioned')), message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, actor_user_id TEXT NOT NULL REFERENCES users(id), actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','agent')), created_at BIGINT NOT NULL, UNIQUE(type,message_id))`,
  `CREATE TABLE user_notifications_next (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES notification_events_next(id) ON DELETE CASCADE, recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL DEFAULT 'following', read_at BIGINT, created_at BIGINT NOT NULL, UNIQUE(event_id,recipient_user_id))`,
  "INSERT INTO notification_events_next SELECT * FROM notification_events",
  "INSERT INTO user_notifications_next SELECT * FROM user_notifications",
  "DROP TABLE user_notifications",
  "DROP TABLE notification_events",
  "ALTER TABLE notification_events_next RENAME TO notification_events",
  "ALTER TABLE user_notifications_next RENAME TO user_notifications",
  "CREATE INDEX notification_inbox ON user_notifications(recipient_user_id,created_at DESC,id DESC)",
  "CREATE INDEX notification_unread ON user_notifications(recipient_user_id,created_at DESC) WHERE read_at IS NULL",
  `CREATE TABLE IF NOT EXISTS comment_mentions (message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at BIGINT NOT NULL, removed_at BIGINT, PRIMARY KEY(message_id,mentioned_user_id))`,
  "CREATE INDEX IF NOT EXISTS comment_mentions_recipient ON comment_mentions(mentioned_user_id,message_id) WHERE removed_at IS NULL",
];
/** PostgreSQL retains the notification_events_next_* / user_notifications_next_*
 * constraint and backing-index names after RENAME. Keep this shared migration immutable;
 * future constraint changes must discover those names or normalize them in a new migration. */
export async function up(q: RbacQuery) {
  for (const statement of statements) await q(statement);
}
