-- Frozen startup SQL from release 0.2.0, commit 19f9c3b.
-- db-postgres.ts initialization, migrateRbac, and numbered migrations 0001–0006.
-- Includes original CHECK/FK constraints and migration checksums; no current bootstrap calls.

CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          current_version_id TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          deleted_at BIGINT,
          edit_token TEXT
        );
        CREATE TABLE IF NOT EXISTS versions (
          seq BIGSERIAL,
          id TEXT PRIMARY KEY,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          entry TEXT NOT NULL,
          file_count BIGINT NOT NULL,
          byte_size BIGINT NOT NULL,
          source TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_versions_site ON versions(site_id, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS users (
     id               TEXT PRIMARY KEY,
     tenant_id        TEXT,
     auth_provider    TEXT NOT NULL,
     provider_subject TEXT NOT NULL,
     email            TEXT,
     email_verified   BOOLEAN NOT NULL DEFAULT false,
     display_name     TEXT,
     avatar_url       TEXT,
     created_at       BIGINT NOT NULL,
     updated_at       BIGINT NOT NULL,
     last_login_at    BIGINT
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_provider ON users (auth_provider, provider_subject);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
     id                  TEXT PRIMARY KEY,
     user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     oidc_sid            TEXT,
     created_at          BIGINT NOT NULL,
     expires_at          BIGINT NOT NULL,
     absolute_expires_at BIGINT NOT NULL,
     last_seen_at        BIGINT,
     revoked_at          BIGINT,
     ip                  TEXT,
     user_agent          TEXT
   );

DROP INDEX IF EXISTS idx_sessions_active;

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_sid ON sessions (oidc_sid) WHERE oidc_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS oidc_flows (
     flow_id     TEXT PRIMARY KEY,
     verifier    TEXT NOT NULL,
     nonce       TEXT NOT NULL,
     return_to   TEXT NOT NULL,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     consumed_at BIGINT
   );

CREATE INDEX IF NOT EXISTS idx_oidc_flows_expiry ON oidc_flows (expires_at);

CREATE TABLE IF NOT EXISTS publish_tokens (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name         TEXT NOT NULL,
     created_at   BIGINT NOT NULL,
     last_used_at BIGINT,
     revoked_at   BIGINT
   );

CREATE INDEX IF NOT EXISTS idx_publish_tokens_user ON publish_tokens (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_grants (
     device_code TEXT PRIMARY KEY,
     user_code   TEXT NOT NULL UNIQUE,
     status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','consumed')),
     user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     consumed_at BIGINT
   );

CREATE TABLE IF NOT EXISTS upload_sessions (
     version_id  TEXT PRIMARY KEY,
     site_id     TEXT NOT NULL,
     target_slug TEXT,
     title       TEXT,
     owner_key   TEXT NOT NULL,
     files       TEXT NOT NULL DEFAULT '[]',
     created_at  BIGINT NOT NULL
   );

ALTER TABLE sites ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

ALTER TABLE sites ADD COLUMN IF NOT EXISTS edit_policy TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE sites ADD COLUMN IF NOT EXISTS claim_token TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS anon_owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sites_anon_owner ON sites (anon_owner_id) WHERE anon_owner_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE versions ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS site_collaborators (
     site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
     granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
     granted_at BIGINT NOT NULL,
     PRIMARY KEY (site_id, user_id)
   );

CREATE INDEX IF NOT EXISTS idx_collab_user ON site_collaborators (user_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS site_invites (
     id          TEXT PRIMARY KEY,
     site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     email       TEXT NOT NULL,
     role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
     invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     accepted_at BIGINT
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_site_invites_email ON site_invites (site_id, lower(email));

CREATE TABLE IF NOT EXISTS site_shares (
     id            TEXT PRIMARY KEY,
     site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     token_hash    TEXT NOT NULL UNIQUE,
     policy        TEXT NOT NULL CHECK (policy IN ('public','login','people','passcode')),
     passcode_hash TEXT,
     label         TEXT,
     created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_anon  TEXT,
     created_at    BIGINT NOT NULL,
     expires_at    BIGINT,
     revoked_at    BIGINT
   );

CREATE INDEX IF NOT EXISTS idx_shares_site ON site_shares (site_id, created_at DESC);

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS allow_ai BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS share_grants (
     share_id   TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
     user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
     email      TEXT,
     granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
     granted_at BIGINT NOT NULL,
     CHECK ((user_id IS NULL) <> (email IS NULL))
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_user ON share_grants (share_id, user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_email ON share_grants (share_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_views (
     share_id   TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
     site_id    TEXT NOT NULL,
     user_id    TEXT,
     anon_id    TEXT,
     ip         TEXT,
     user_agent TEXT,
     viewed_at  BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_share_views_site ON share_views (site_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_views_prune ON share_views (viewed_at);

CREATE TABLE IF NOT EXISTS site_views (
     site_id    TEXT NOT NULL,
     user_id    TEXT,
     anon_id    TEXT,
     ip         TEXT,
     user_agent TEXT,
     viewed_at  BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_site_views_site ON site_views (site_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_views_prune ON site_views (viewed_at);

CREATE TABLE IF NOT EXISTS archived_view_counts (site_id TEXT PRIMARY KEY, opens BIGINT NOT NULL DEFAULT 0);

CREATE INDEX IF NOT EXISTS idx_site_views_reader ON site_views (site_id, (COALESCE('u:' || user_id, 'a:' || anon_id, 'i:' || ip)), viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_views_reader ON share_views (site_id, (COALESCE('u:' || user_id, 'a:' || anon_id, 'i:' || ip)), viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_views_link ON share_views (share_id, viewed_at DESC);

CREATE TABLE IF NOT EXISTS builds (
     id                  TEXT PRIMARY KEY,
     site_id             TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     source_key          TEXT NOT NULL,
     expected_version_id TEXT,
     status              TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','superseded','cancelled')),
     detected_kind       TEXT,
     log                 TEXT NOT NULL DEFAULT '',
     degradations        TEXT NOT NULL DEFAULT '[]',
     lease_owner         TEXT,
     lease_expires_at    BIGINT,
     attempts            INTEGER NOT NULL DEFAULT 0,
     created_at          BIGINT NOT NULL,
     updated_at          BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_builds_claimable ON builds (status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_builds_site ON builds (site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
     id            TEXT PRIMARY KEY,
     site_id       TEXT NOT NULL,
     version_id    TEXT,
     action        TEXT NOT NULL,
     editor_kind   TEXT NOT NULL,
     actor_user_id TEXT,
     actor_anon_id TEXT,
     method        TEXT,
     ip            TEXT,
     user_agent    TEXT,
     created_at    BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log (site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id, created_at DESC);

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE TABLE IF NOT EXISTS folders (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name       TEXT NOT NULL,
     sort       INTEGER NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id, sort, created_at);

CREATE TABLE IF NOT EXISTS folder_assignments (
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (user_id, site_id)
   );

CREATE INDEX IF NOT EXISTS idx_folder_assignments_folder ON folder_assignments (folder_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at BIGINT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS taken_down_at BIGINT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS taken_down_reason TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS purged_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_sites_deleted_unpurged ON sites (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_log (
     id            TEXT PRIMARY KEY,
     actor_kind    TEXT NOT NULL,
     actor_user_id TEXT,
     action        TEXT NOT NULL,
     target_kind   TEXT NOT NULL,
     target_id     TEXT NOT NULL,
     reason        TEXT,
     ip            TEXT,
     created_at    BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_log_target ON admin_log (target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
     scope      TEXT NOT NULL,
     key        TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at BIGINT NOT NULL,
     updated_by TEXT,
     PRIMARY KEY (scope, key)
   );

CREATE TABLE IF NOT EXISTS oauth_clients (
     id                         TEXT PRIMARY KEY,
     secret_hash                TEXT,
     name                       TEXT NOT NULL,
     redirect_uris              TEXT NOT NULL,
     token_endpoint_auth_method TEXT NOT NULL,
     created_at                 BIGINT NOT NULL,
     last_used_at               BIGINT
   );

CREATE TABLE IF NOT EXISTS oauth_authorizations (
     id             TEXT PRIMARY KEY,
     client_id      TEXT NOT NULL,
     client_name    TEXT NOT NULL,
     redirect_uri   TEXT NOT NULL,
     scope          TEXT NOT NULL,
     state          TEXT,
     code_challenge TEXT NOT NULL,
     resource       TEXT NOT NULL,
     user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     code_hash      TEXT,
     grant_id       TEXT,
     created_at     BIGINT NOT NULL,
     expires_at     BIGINT NOT NULL,
     approved_at    BIGINT,
     consumed_at    BIGINT
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_authorizations_code ON oauth_authorizations (code_hash) WHERE code_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_expiry ON oauth_authorizations (expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
     id                  TEXT PRIMARY KEY,
     kind                TEXT NOT NULL CHECK (kind IN ('access','refresh')),
     grant_id            TEXT NOT NULL,
     user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     client_id           TEXT NOT NULL,
     client_name         TEXT NOT NULL,
     scope               TEXT NOT NULL,
     resource            TEXT NOT NULL,
     grant_created_at    BIGINT NOT NULL,
     created_at          BIGINT NOT NULL,
     expires_at          BIGINT NOT NULL,
     absolute_expires_at BIGINT NOT NULL,
     last_used_at        BIGINT,
     revoked_at          BIGINT
   );

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens (grant_id);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens (expires_at);

CREATE TABLE IF NOT EXISTS site_texts (
     site_id      TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
     version_id   TEXT NOT NULL,
     title        TEXT NOT NULL,
     body         TEXT NOT NULL,
     chars        INTEGER NOT NULL,
     tokens       TSVECTOR NOT NULL,
     extracted_at BIGINT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_site_texts_tokens ON site_texts USING GIN (tokens);

ALTER TABLE site_texts ADD COLUMN IF NOT EXISTS extractor_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'anonymous';

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'view' CHECK (mode IN ('view','comment','edit'));

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES versions(id);

ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS official_version_id TEXT;

DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='sites'::regclass AND conname='sites_official_version_fk') THEN
          ALTER TABLE sites ADD CONSTRAINT sites_official_version_fk FOREIGN KEY (official_version_id) REFERENCES versions(id) ON DELETE SET NULL;
        END IF;
      END $$;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS official_set_at BIGINT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS official_set_by TEXT;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS official_revision BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS publish_operations (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    lease TEXT NOT NULL,
    lease_until BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    result TEXT,
    http_status INTEGER,
    client_fingerprint TEXT
  );

CREATE INDEX IF NOT EXISTS idx_publish_operations_expiry ON publish_operations(expires_at);

CREATE TABLE IF NOT EXISTS preview_secret (
    id TEXT PRIMARY KEY CHECK (id='active'),
    secret TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    disabled_at BIGINT
  );

INSERT INTO tenants (id,name) VALUES ('init','init'),('anonymous','anonymous') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_members (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','member')), PRIMARY KEY(tenant_id,user_id)
  );

CREATE TABLE IF NOT EXISTS site_members (
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','editor')),
    granted_by TEXT,
    granted_at BIGINT NOT NULL, PRIMARY KEY(site_id,user_id)
  );

CREATE TABLE IF NOT EXISTS rbac_audit (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_audit_log_retention ON audit_log(created_at,id);

CREATE INDEX IF NOT EXISTS idx_admin_log_retention ON admin_log(created_at,id);

CREATE INDEX IF NOT EXISTS idx_rbac_audit_retention ON rbac_audit(created_at,id);

CREATE TABLE IF NOT EXISTS rbac_migrations (
    id TEXT PRIMARY KEY
  );

UPDATE users SET tenant_id='init';

INSERT INTO tenant_members (tenant_id,user_id,role) SELECT 'init',id,'member' FROM users WHERE 1=1 ON CONFLICT DO NOTHING;

UPDATE sites SET tenant_id=CASE WHEN owner_id IS NULL THEN 'anonymous' ELSE 'init' END;

INSERT INTO site_members (site_id,user_id,role,granted_by,granted_at) SELECT site_id,user_id,'editor',granted_by,granted_at FROM site_collaborators WHERE 1=1 ON CONFLICT DO NOTHING;

UPDATE sites SET edit_policy='owner';

INSERT INTO rbac_migrations (id) VALUES ('initial');

CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id,updated_at);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id,tenant_id);

CREATE INDEX IF NOT EXISTS idx_site_members_user ON site_members(user_id,site_id);

UPDATE sites SET edit_token='',claim_token=NULL WHERE owner_id IS NOT NULL;

INSERT INTO rbac_migrations(id) VALUES('retire-owned-edit-tokens');

CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_site_identity ON versions(site_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_site_identity ON site_shares(site_id,id);

CREATE TABLE IF NOT EXISTS comment_secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS site_comment_settings (site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, main_policy TEXT NOT NULL DEFAULT 'login' CHECK(main_policy IN ('off','login','members')), updated_by TEXT REFERENCES users(id), updated_at BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS comment_spaces (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, version_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('main','share')), share_id TEXT, created_at BIGINT NOT NULL, FOREIGN KEY(site_id,version_id) REFERENCES versions(site_id,id) ON DELETE CASCADE, FOREIGN KEY(site_id,share_id) REFERENCES site_shares(site_id,id) ON DELETE CASCADE, CHECK((kind='main' AND share_id IS NULL) OR (kind='share' AND share_id IS NOT NULL)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_main_space ON comment_spaces(site_id,version_id) WHERE kind='main';

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_share_space ON comment_spaces(share_id,version_id) WHERE kind='share';

CREATE TABLE IF NOT EXISTS comment_threads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES comment_spaces(id) ON DELETE CASCADE, created_by TEXT NOT NULL REFERENCES users(id), anchor JSONB NOT NULL, context_snapshot JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), resolved_by TEXT REFERENCES users(id), resolved_at BIGINT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, CHECK((status='open' AND resolved_by IS NULL AND resolved_at IS NULL) OR (status='resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)));

CREATE INDEX IF NOT EXISTS idx_comment_activity ON comment_threads(space_id,updated_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_comment_status ON comment_threads(space_id,status,updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS comment_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE, author_user_id TEXT NOT NULL REFERENCES users(id), is_root INTEGER NOT NULL CHECK(is_root IN (0,1)), body TEXT, client_request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at BIGINT NOT NULL, edited_at BIGINT, deleted_at BIGINT, deleted_by TEXT REFERENCES users(id), UNIQUE(author_user_id,client_request_id), CHECK((deleted_at IS NULL AND deleted_by IS NULL AND body IS NOT NULL AND length(trim(body))>0) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND body IS NULL)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_root ON comment_messages(thread_id) WHERE is_root=1;

CREATE INDEX IF NOT EXISTS idx_comment_messages ON comment_messages(thread_id,created_at,id);

CREATE TABLE IF NOT EXISTS comment_context_assets (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('region_image','page_image')), storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')), byte_size BIGINT NOT NULL CHECK(byte_size>0), pixel_width INTEGER NOT NULL CHECK(pixel_width>0), pixel_height INTEGER NOT NULL CHECK(pixel_height>0), sha256 TEXT NOT NULL, created_at BIGINT NOT NULL, deleted_at BIGINT);

CREATE INDEX IF NOT EXISTS idx_comment_assets_message ON comment_context_assets(message_id);

CREATE TABLE IF NOT EXISTS reactions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, message_id TEXT REFERENCES comment_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind='like'), user_id TEXT REFERENCES users(id), anonymous_actor_hash TEXT, created_at BIGINT NOT NULL, CHECK((user_id IS NOT NULL AND anonymous_actor_hash IS NULL) OR (user_id IS NULL AND anonymous_actor_hash IS NOT NULL AND message_id IS NULL)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_like_user ON reactions(site_id,user_id) WHERE message_id IS NULL AND user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_like_anon ON reactions(site_id,anonymous_actor_hash) WHERE message_id IS NULL AND anonymous_actor_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_like_user ON reactions(message_id,user_id) WHERE message_id IS NOT NULL;

INSERT INTO schema_migrations VALUES ('0001-comments','f47d1beb6aa48ef701afb6b7ebb9d8e3b39977ce670078836932fb4a89f0e6d6',1);

ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS result_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS comment_threads_creation ON comment_threads(space_id,created_at,id);

CREATE INDEX IF NOT EXISTS comment_threads_author ON comment_threads(created_by,space_id,created_at,id);

INSERT INTO schema_migrations VALUES ('0002-comment-review-indexes','b3b99884a39ec1c8fe71eb948733c5cb04b0b19cb4dd4463286560dd16b799a1',1);

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS token TEXT;

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS source TEXT;

INSERT INTO schema_migrations VALUES ('0003-share-token-source','4319c61b5e7999505df22d67abc532ca07ff3cf6e8e10fe84d0c7b8e36d591bf',1);

ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;

INSERT INTO schema_migrations VALUES ('0004-share-revision','880d08307e3116d549c6428bf200a2aa95e18acef1f417ed016cef2606cc62b0',1);

ALTER TABLE sites ADD CONSTRAINT sites_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;

ALTER TABLE site_shares ADD CONSTRAINT shares_site_version_fk FOREIGN KEY (site_id,version_id) REFERENCES versions(site_id,id) ON DELETE CASCADE NOT VALID;

ALTER TABLE sites ADD CONSTRAINT official_site_version_fk FOREIGN KEY (id,official_version_id) REFERENCES versions(site_id,id) ON DELETE SET NULL (official_version_id) NOT VALID;

INSERT INTO schema_migrations VALUES ('0005-rbac-constraints','8d4c9b45e9b0f5c58f644e442b351a759c337bc0f1bb324b9950ef4032fc9c8c',1);

CREATE TABLE IF NOT EXISTS comment_reactions (message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 128), created_at BIGINT NOT NULL, PRIMARY KEY(message_id,user_id,emoji));

CREATE TABLE IF NOT EXISTS comment_read_scopes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, scope_key TEXT NOT NULL, read_through BIGINT NOT NULL, PRIMARY KEY(user_id,site_id,scope_key));

CREATE TABLE IF NOT EXISTS comment_read_messages (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES comment_messages(id) ON DELETE CASCADE, PRIMARY KEY(user_id,message_id));

CREATE INDEX IF NOT EXISTS idx_comment_receipt_message ON comment_read_messages(message_id,user_id);

CREATE INDEX IF NOT EXISTS idx_comment_unread_time ON comment_messages(created_at,id);

INSERT INTO schema_migrations VALUES ('0006-comment-engagement','93bcab66b3c93bd317414d96be0b8f8eab28f4fd4b0a8de7f4d153d6dde92907',1);
