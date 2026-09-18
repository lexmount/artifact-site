import type { RbacQuery } from "@/lib/rbac-store";
/** Additive baseline; legacy schema creation still runs before this numbered migration. */
export async function up(q: RbacQuery): Promise<void> {
  for (const sql of statements) await q(sql);
}
export const statements = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_site_identity ON versions(site_id,id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_site_identity ON site_shares(site_id,id)`,
  `CREATE TABLE IF NOT EXISTS comment_secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS site_comment_settings (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, main_policy TEXT NOT NULL DEFAULT 'login' CHECK(main_policy IN ('off','login','members')), updated_by TEXT REFERENCES users(id), updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comment_spaces (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, version_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('main','share')), share_id TEXT, created_at BIGINT NOT NULL, FOREIGN KEY(site_id,version_id) REFERENCES versions(site_id,id) ON DELETE CASCADE, FOREIGN KEY(site_id,share_id) REFERENCES site_shares(site_id,id) ON DELETE CASCADE, CHECK((kind='main' AND share_id IS NULL) OR (kind='share' AND share_id IS NOT NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_main_space ON comment_spaces(site_id,version_id) WHERE kind='main'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_share_space ON comment_spaces(share_id,version_id) WHERE kind='share'`,
  `CREATE TABLE IF NOT EXISTS comment_threads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES comment_spaces(id) ON DELETE CASCADE, created_by TEXT NOT NULL REFERENCES users(id), anchor JSONB NOT NULL, context_snapshot JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), resolved_by TEXT REFERENCES users(id), resolved_at BIGINT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, CHECK((status='open' AND resolved_by IS NULL AND resolved_at IS NULL) OR (status='resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)))`,
  `CREATE INDEX IF NOT EXISTS idx_comment_activity ON comment_threads(space_id,updated_at DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_status ON comment_threads(space_id,status,updated_at DESC,id DESC)`,
  `CREATE TABLE IF NOT EXISTS comment_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE, author_user_id TEXT NOT NULL REFERENCES users(id), is_root INTEGER NOT NULL CHECK(is_root IN (0,1)), body TEXT, client_request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at BIGINT NOT NULL, edited_at BIGINT, deleted_at BIGINT, deleted_by TEXT REFERENCES users(id), UNIQUE(author_user_id,client_request_id), CHECK((deleted_at IS NULL AND deleted_by IS NULL AND body IS NOT NULL AND length(trim(body))>0) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND body IS NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_root ON comment_messages(thread_id) WHERE is_root=1`,
  `CREATE INDEX IF NOT EXISTS idx_comment_messages ON comment_messages(thread_id,created_at,id)`,
  `CREATE TABLE IF NOT EXISTS comment_context_assets (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('region_image','page_image')), storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')), byte_size BIGINT NOT NULL CHECK(byte_size>0), pixel_width INTEGER NOT NULL CHECK(pixel_width>0), pixel_height INTEGER NOT NULL CHECK(pixel_height>0), sha256 TEXT NOT NULL, created_at BIGINT NOT NULL, deleted_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_assets_message ON comment_context_assets(message_id)`,
  `CREATE TABLE IF NOT EXISTS reactions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, message_id TEXT REFERENCES comment_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind='like'), user_id TEXT REFERENCES users(id), anonymous_actor_hash TEXT, created_at BIGINT NOT NULL, CHECK((user_id IS NOT NULL AND anonymous_actor_hash IS NULL) OR (user_id IS NULL AND anonymous_actor_hash IS NOT NULL AND message_id IS NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_like_user ON reactions(site_id,user_id) WHERE message_id IS NULL AND user_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_like_anon ON reactions(site_id,anonymous_actor_hash) WHERE message_id IS NULL AND anonymous_actor_hash IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_like_user ON reactions(message_id,user_id) WHERE message_id IS NOT NULL`,
];
