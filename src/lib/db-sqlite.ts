import { AsyncLocalStorage } from "node:async_hooks";
import { searchTenantUsers, migrateRbac, initializeUserTenant, type RbacQuery } from "@/lib/rbac-store";
import { isDeepStrictEqual } from "node:util";
// SQLite metadata backend (node:sqlite). Node-local, single-writer — the default. Methods are
// async to satisfy the MetadataStore interface, but the underlying calls are synchronous.
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath } from "@/lib/config";
import type {
  AuditEntry, EditPolicy, InsertShareInput, Session, Share, ShareGrant, SharePolicy, ShareRow, ShareView,
  Site, SiteCollaborator, SiteOpen, SiteSummary, SiteView, SiteViewStats, User, Version, Visibility,
  AdminAction, AdminLogEntry, AdminOverview, AdminSiteRow, AdminUserRow, SettingRow, SettingWrite,
  OauthAuthorization, OauthClientRecord, OauthConnection, OauthToken,
} from "@/lib/types";
import {
  adminUserOrder,
  likeContains,
  toAdminLog,
  toAdminOverview,
  toSettingRow,
  toSiteText,
  SITE_TEXT_EXTRACTOR_VERSION,
  toSearchHit,
  type SiteTextWrite,
  type SiteTextRow,
  type SearchHit,
  type SearchToken,
  toAdminSiteRow,
  toAdminUserRow,
  type AdminSiteQuery,
  type AdminUserQuery,
  type QuotaOwner,
  createEditToken,
  createId,
  SlugConflictError,
  UserCodeConflictError,
  toAudit,
  toShare,
  toShareRow,
  toShareView,
  toSiteOpen,
  toSite,
  toSummary,
  toUploadSession,
  type UploadSessionRow,
  toCollaborator,
  toSession,
  toUser,
  toVersion,
  type InsertAuditInput,
  type InsertSiteInput,
  type InsertVersionInput,
  type CreateOidcFlowInput,
  type CreateSessionInput,
  type UpsertUserInput,
  toPublishToken,
  toDeviceGrant,
  toOauthAuthorization,
  toOauthClient,
  toOauthConnection,
  toOauthToken,
  type DeviceGrant,
  type ListViewer,
  type MetadataStore,
  type PublishToken,
  type VersionCommit,
  type Row,
  toUserFolder, type UserFolder, type FolderAssignment,
} from "@/lib/db";

/**
 * Exactly one of userId / email, as share_grants' CHECK constraint demands. Validated here rather
 * than left to the database because the two drivers do NOT fail alike: Postgres raises a CHECK
 * violation, while SQLite's `INSERT OR IGNORE` treats a violated CHECK as just another row to skip
 * and returns success. A bad target must be the same loud error on both backends.
 *
 * Falsy-to-null (not `?? null`): an empty string is not an identity, and letting `""` through would
 * put a row in share_grants that no lookup can ever match.
 *
 * Twin of the identical function in db-postgres.ts — the two must be changed together.
 */
function shareGrantTarget(target: { userId?: string | null; email?: string | null }): { userId: string | null; email: string | null } {
  const userId = target.userId || null;
  const email = target.email || null;
  if ((userId == null) === (email == null)) throw new Error("share grant needs exactly one of userId / email");
  return { userId, email };
}

/**
 * Row → ShareGrant. The Share/ShareRow/ShareView mappers live in db.ts precisely so the backends
 * cannot drift on shape; this one cannot join them there because it maps a JOINed projection
 * (share_grants + users.display_name) rather than a table row. Written twice, identically —
 * twin in db-postgres.ts.
 */
function toShareGrantRow(row: Row): ShareGrant {
  return {
    shareId: row.share_id as string,
    userId: (row.user_id as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    grantedAt: Number(row.granted_at),
  };
}

export class SqliteStore implements MetadataStore {
  private operationContext = new AsyncLocalStorage<{ active: boolean }>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  constructor() {
    // SQLite has one connection. An async transaction owns it across every await;
    // unrelated reads and writes must wait, while nested store calls may re-enter.
    for (const name of [...Object.getOwnPropertyNames(SqliteStore.prototype), "rbacQuery"]) {
      if (name === "constructor") continue;
      const method = Reflect.get(this, name);
      if (typeof method !== "function" || method.constructor.name !== "AsyncFunction") continue;
      Reflect.set(this, name, (...args: unknown[]) => {
        if (this.operationContext.getStore()?.active) return method.apply(this, args);
        const run = this.operationQueue.then(() => {
          const context = { active: true };
          return this.operationContext.run(context, async () => {
            try { return await method.apply(this, args); }
            finally { context.active = false; }
          });
        });
        this.operationQueue = run.catch(() => undefined);
        return run;
      });
    }
  }
  private db!: DatabaseSync;
  rbacQuery: RbacQuery = async (sql, params = []) => {
    const values: (string | number | null)[] = [];
    const query = sql.replace(/\$(\d+)/g, (_, n: string) => { values.push(params[Number(n) - 1]); return "?"; });
    return this.db.prepare(query).all(...values) as Row[];
  };
  /** Never await network/request I/O inside work: it owns the entire connection. */
  async rbacTransaction<T>(work: (q: RbacQuery) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = await work(this.rbacQuery); this.db.exec("COMMIT"); return value; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  async init(): Promise<void> {
    const dbFile = dataPath("sites.sqlite");
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        current_version_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        edit_token TEXT
      );

      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entry TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_versions_site ON versions(site_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(deleted_at, updated_at DESC);

      -- identity: mirrors the Postgres MIGRATIONS array (see db-postgres.ts). BOOLEAN round-trips
      -- as 0/1 here, which toUser() coerces; everything else maps 1:1.
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        auth_provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        display_name TEXT,
        avatar_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_provider ON users(auth_provider, provider_subject);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        oidc_sid TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_sid ON sessions(oidc_sid) WHERE oidc_sid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS oidc_flows (
        flow_id TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        return_to TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_oidc_flows_expiry ON oidc_flows(expires_at);

      CREATE TABLE IF NOT EXISTS publish_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_publish_tokens_user ON publish_tokens(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS device_grants (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','consumed')),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        secret_hash TEXT,
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_authorizations (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT,
        grant_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_at INTEGER,
        consumed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_authorizations_code ON oauth_authorizations(code_hash) WHERE code_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_expiry ON oauth_authorizations(expires_at);
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
        grant_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        grant_created_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS upload_sessions (
        version_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        target_slug TEXT,
        title TEXT,
        owner_key TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_log (
        id TEXT PRIMARY KEY,
        actor_kind TEXT NOT NULL,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reason TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_log_target ON admin_log(target_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS site_texts (
        site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        chars INTEGER NOT NULL,
        extracted_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS site_texts_fts USING fts5(site_id UNINDEXED, title_tokens, body_tokens);
      -- The virtual table takes no part in the foreign-key cascade; whichever path removes the
      -- site_texts row (a hard delete of the site included), its index row goes with it.
      CREATE TRIGGER IF NOT EXISTS site_texts_fts_del AFTER DELETE ON site_texts
      BEGIN
        DELETE FROM site_texts_fts WHERE site_id = OLD.site_id;
      END;

      CREATE TABLE IF NOT EXISTS site_collaborators (
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (site_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_collab_user ON site_collaborators(user_id, granted_at DESC);

      CREATE TABLE IF NOT EXISTS site_invites (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
        invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_site_invites_email ON site_invites(site_id, lower(email));

      -- Share links. Mirrors the Postgres side statement for statement; see the comments there for
      -- why a share is an object rather than a column, and why only token_hash is stored.
      CREATE TABLE IF NOT EXISTS site_shares (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        policy TEXT NOT NULL CHECK (policy IN ('public','login','people','passcode')),
        passcode_hash TEXT,
        label TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_anon TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        allow_ai INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_shares_site ON site_shares(site_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS share_grants (
        share_id TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        granted_at INTEGER NOT NULL,
        CHECK ((user_id IS NULL) <> (email IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_user ON share_grants(share_id, user_id) WHERE user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_email ON share_grants(share_id, lower(email)) WHERE email IS NOT NULL;

      CREATE TABLE IF NOT EXISTS share_views (
        share_id TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
        site_id TEXT NOT NULL,
        user_id TEXT,
        anon_id TEXT,
        ip TEXT,
        user_agent TEXT,
        viewed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_share_views_site ON share_views(site_id, viewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_share_views_prune ON share_views(viewed_at);

      -- Direct openings of /s/<slug>. Mirrors the Postgres migration; see the comment there for
      -- why this is its own table rather than a nullable share_id on share_views.
      CREATE TABLE IF NOT EXISTS site_views (
        site_id TEXT NOT NULL,
        user_id TEXT,
        anon_id TEXT,
        ip TEXT,
        user_agent TEXT,
        viewed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_site_views_site ON site_views(site_id, viewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_site_views_prune ON site_views(viewed_at);

      -- Server-side build of dropped source projects. Mirrors the Postgres migration; see the
      -- comment there for why source lives under its own storage namespace instead of a version
      -- row, and what expected_version_id protects against.
      CREATE TABLE IF NOT EXISTS builds (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        expected_version_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','superseded','cancelled')),
        detected_kind TEXT,
        log TEXT NOT NULL DEFAULT '',
        degradations TEXT NOT NULL DEFAULT '[]',
        lease_owner TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_builds_claimable ON builds(status, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_builds_site ON builds(site_id, created_at DESC);

      -- Append-only audit trail. Deliberately NOT a FK to sites/users: it must outlive both, so a
      -- deleted user or purged site cannot erase who did what. Rows are only ever inserted, never
      -- updated — that is what keeps "it was anonymous at the time" true after a later claim.
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        version_id TEXT,
        action TEXT NOT NULL,
        editor_kind TEXT NOT NULL,
        actor_user_id TEXT,
        actor_anon_id TEXT,
        method TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log(site_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, sort, created_at);
      CREATE TABLE IF NOT EXISTS folder_assignments (
        user_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, site_id)
      );
      CREATE INDEX IF NOT EXISTS idx_folder_assignments_folder ON folder_assignments(folder_id);
    `);
    // Legacy DBs predating the edit-token feature: add the column, then mint tokens for old rows.
    // SQLite has no ADD COLUMN IF NOT EXISTS, hence the table_info probe (also used below).
    const columns = new Set((this.db.prepare("PRAGMA table_info(sites)").all() as Row[]).map((c) => c.name as string));
    if (!columns.has("edit_token")) this.db.exec("ALTER TABLE sites ADD COLUMN edit_token TEXT");
    this.addColumnIfMissing("sites", "owner_id", "TEXT REFERENCES users(id)");
    this.addColumnIfMissing("sites", "visibility", "TEXT NOT NULL DEFAULT 'public'");
    this.addColumnIfMissing("sites", "edit_policy", "TEXT NOT NULL DEFAULT 'owner'");
    this.addColumnIfMissing("sites", "claim_token", "TEXT");
    this.addColumnIfMissing("sites", "anon_owner_id", "TEXT");
    this.addColumnIfMissing("versions", "created_by", "TEXT REFERENCES users(id)");
    this.addColumnIfMissing("site_shares", "allow_ai", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("users", "disabled_at", "INTEGER");
    this.addColumnIfMissing("users", "disabled_reason", "TEXT");
    this.addColumnIfMissing("sites", "taken_down_at", "INTEGER");
    this.addColumnIfMissing("sites", "taken_down_reason", "TEXT");
    this.addColumnIfMissing("sites", "purged_at", "INTEGER");
    this.addColumnIfMissing("site_texts", "extractor_version", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_id, updated_at DESC) WHERE deleted_at IS NULL");
    this.db.exec("DROP INDEX IF EXISTS idx_sessions_active");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sites_anon_owner ON sites(anon_owner_id) WHERE anon_owner_id IS NOT NULL AND deleted_at IS NULL");
    this.addColumnIfMissing("sites", "tenant_id", "TEXT NOT NULL DEFAULT 'anonymous'");
    this.addColumnIfMissing("site_shares", "mode", "TEXT NOT NULL DEFAULT 'view' CHECK (mode IN ('view','comment','edit'))");
    this.addColumnIfMissing("site_shares", "version_id", "TEXT REFERENCES versions(id)");
    this.addColumnIfMissing("upload_sessions", "tenant_id", "TEXT");
    await this.rbacTransaction(migrateRbac);
    await this.backfillEditTokens();
  }

  /** SQLite lacks ADD COLUMN IF NOT EXISTS — probe the schema so init() stays idempotent. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name as string));
    if (!cols.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** One INSERT into audit_log at timestamp `now`. Called inside a version-commit transaction so
   *  the trail and the version it describes land together or not at all. */
  private writeAuditRow(a: InsertAuditInput, now: number): void {
    this.db.prepare(
      "INSERT INTO audit_log (id, site_id, version_id, action, editor_kind, actor_user_id, actor_anon_id, method, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(a.id, a.siteId, a.versionId, a.action, a.editorKind, a.actorUserId, a.actorAnonId, a.method, a.ip, a.userAgent, now);
  }

  async insertSite(input: InsertSiteInput): Promise<void> {
    const now = Date.now();
    this.db.prepare("INSERT INTO sites (id, slug, title, kind, current_version_id, created_at, updated_at, deleted_at, edit_token, claim_token, anon_owner_id, visibility) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)")
      .run(input.id, input.slug, input.title, input.kind, now, now, input.editToken, input.claimToken ?? null, input.anonOwnerId ?? null, input.visibility);
  }

  async insertSiteWithVersion(site: InsertSiteInput, version: InsertVersionInput, audit?: InsertAuditInput): Promise<void> {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO sites (id, slug, title, kind, current_version_id, created_at, updated_at, deleted_at, edit_token, claim_token, anon_owner_id, owner_id, visibility, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)")
        .run(site.id, site.slug, site.title, site.kind, version.id, now, now, site.editToken, site.claimToken ?? null, site.anonOwnerId ?? null, site.ownerId ?? null, site.visibility, site.tenantId ?? (site.ownerId ? "init" : "anonymous"));
      this.db.prepare("INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now);
      if (audit) this.writeAuditRow(audit, now);
      this.db.exec("COMMIT");
    } catch (error) {
      // Swallow a failing ROLLBACK — it can throw in exactly the situations that got us here (the
      // BEGIN never took, the handle is unusable), and if it does, its exception would replace the
      // one that actually explains the failure. Mirrors the Postgres backend's `.catch(() => {})`.
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      if (String((error as Error)?.message).includes("UNIQUE constraint failed: sites.slug")) throw new SlugConflictError();
      throw error;
    }
  }

  async addVersionAsCurrent(siteId: string, version: InsertVersionInput, audit?: InsertAuditInput): Promise<boolean> {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare("SELECT deleted_at FROM sites WHERE id=?").get(siteId) as { deleted_at: number | null } | undefined;
      if (!row || row.deleted_at != null) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now);
      this.db.prepare("UPDATE sites SET current_version_id=?, updated_at=? WHERE id=?").run(version.id, now, siteId);
      if (audit) this.writeAuditRow(audit, now);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      // Swallow a failing ROLLBACK — it can throw in exactly the situations that got us here (the
      // BEGIN never took, the handle is unusable), and if it does, its exception would replace the
      // one that actually explains the failure. Mirrors the Postgres backend's `.catch(() => {})`.
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async addVersionAsCurrentIfCurrentIs(
    siteId: string,
    expectedCurrentVersionId: string,
    version: InsertVersionInput,
    audit?: InsertAuditInput,
  ): Promise<VersionCommit> {
    const now = Date.now();
    // BEGIN IMMEDIATE, not the bare BEGIN used above: this transaction reads a row and then writes
    // based on what it read. Under a deferred transaction SQLite starts read-only and can only
    // discover the conflict at upgrade time, failing with SQLITE_BUSY_SNAPSHOT (517) — which no
    // busy handler retries. Taking the write lock up front is the shape that actually serializes.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT deleted_at, current_version_id FROM sites WHERE id=?").get(siteId) as
        | { deleted_at: number | null; current_version_id: string | null }
        | undefined;
      if (!row || row.deleted_at != null) {
        this.db.exec("ROLLBACK");
        return "gone";
      }
      if ((row.current_version_id ?? "") !== expectedCurrentVersionId) {
        this.db.exec("ROLLBACK");
        return "stale";
      }
      this.db.prepare("INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now);
      this.db.prepare("UPDATE sites SET current_version_id=?, updated_at=? WHERE id=?").run(version.id, now, siteId);
      if (audit) this.writeAuditRow(audit, now);
      this.db.exec("COMMIT");
      return "applied";
    } catch (error) {
      // Swallow a failing ROLLBACK — it can throw in exactly the situations that got us here (the
      // BEGIN never took, the handle is unusable), and if it does, its exception would replace the
      // one that actually explains the failure. Mirrors the Postgres backend's `.catch(() => {})`.
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async insertAudit(input: InsertAuditInput): Promise<void> {
    this.writeAuditRow(input, Date.now());
  }

  async listAudit(siteId: string, limit = 200): Promise<AuditEntry[]> {
    // rowid DESC is the created_at tiebreaker — created_at is a millisecond app clock and a burst
    // of actions routinely shares one millisecond, so ordering by it alone is unstable. rowid is
    // the SQLite half of a cross-backend contract: it must order the same way as the Postgres
    // backend's audit_log.seq, which is why the tiebreaker is NOT `id` (that column is
    // `aud_<randomUUID>` — stable to sort by, but an arbitrary order that matches neither the real
    // edit sequence nor what the other backend returns). audit_log is append-only — nothing ever
    // deletes from it — so no rowid is ever recycled and the counter stays monotonic.
    const rows = this.db.prepare("SELECT * FROM audit_log WHERE site_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(siteId, limit) as Row[];
    return rows.map(toAudit);
  }

  async getSiteBySlug(slug: string): Promise<Site | null> {
    const row = this.db.prepare("SELECT * FROM sites WHERE slug=?").get(slug) as Row | undefined;
    return row ? toSite(row) : null;
  }

  async getSite(id: string): Promise<Site | null> {
    const row = this.db.prepare("SELECT * FROM sites WHERE id=?").get(id) as Row | undefined;
    return row ? toSite(row) : null;
  }

  async setCurrentVersion(siteId: string, versionId: string): Promise<void> {
    // deleted_at guard: a mutation racing a concurrent delete must not resurrect a deleted site's pointer.
    this.db.prepare("UPDATE sites SET current_version_id=?, updated_at=? WHERE id=? AND deleted_at IS NULL").run(versionId, Date.now(), siteId);
  }

  async updateSiteTitle(id: string, title: string): Promise<void> {
    this.db.prepare("UPDATE sites SET title=?, updated_at=? WHERE id=?").run(title, Date.now(), id);
  }

  async setEditToken(id: string, token: string): Promise<void> {
    this.db.prepare("UPDATE sites SET edit_token=? WHERE id=?").run(token, id);
  }

  async softDeleteSite(id: string): Promise<void> {
    const now = Date.now();
    this.db.prepare("UPDATE sites SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, id);
  }

  async listSiteSummaries(viewer?: ListViewer): Promise<SiteSummary[]> {
    // Same predicate as the Postgres side, same reasons — see the comment there. Only the
    // placeholders differ, and node:sqlite binds a JS null as SQL NULL, so the no-viewer call
    // degrades to public-only exactly like $1/$2 do.
    const rows = this.db.prepare(`
      SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s
      LEFT JOIN versions v ON v.id = s.current_version_id
      WHERE EXISTS (SELECT 1 FROM tenants rt WHERE rt.id=s.tenant_id AND rt.disabled_at IS NULL) AND s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
        AND ((COALESCE(s.visibility, 'public') = 'public' AND s.taken_down_at IS NULL)
             OR (s.owner_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=s.owner_id))
             OR (s.owner_id IS NULL AND s.anon_owner_id = ?)
             OR EXISTS (SELECT 1 FROM site_members c
                         WHERE c.site_id = s.id AND c.user_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=c.user_id)))
      ORDER BY s.updated_at DESC
    `).all(viewer?.userId ?? null, viewer?.anonId ?? null, viewer?.userId ?? null) as Row[];
    return rows.map(toSummary);
  }

  async countVersions(siteId: string): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE site_id=?").get(siteId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  async insertVersion(input: InsertVersionInput): Promise<void> {
    this.db.prepare("INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.siteId, input.entry, input.fileCount, input.byteSize, input.source, Date.now());
  }

  async getVersion(id: string): Promise<Version | null> {
    const row = this.db.prepare("SELECT * FROM versions WHERE id=?").get(id) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  async listVersions(siteId: string): Promise<Version[]> {
    const rows = this.db.prepare("SELECT * FROM versions WHERE site_id=? ORDER BY created_at DESC, rowid DESC").all(siteId) as Row[];
    return rows.map(toVersion);
  }

  async backfillEditTokens(): Promise<number> {
    const rows = this.db.prepare("SELECT id FROM sites WHERE edit_token IS NULL OR edit_token = ''").all() as Row[];
    const stmt = this.db.prepare("UPDATE sites SET edit_token=? WHERE id=?");
    for (const row of rows) stmt.run(createEditToken(), row.id as string);
    return rows.length;
  }

  async upsertUser(input: UpsertUserInput): Promise<User> {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO users (id, auth_provider, provider_subject, email, email_verified, display_name, avatar_url, created_at, updated_at, last_login_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (auth_provider, provider_subject) DO UPDATE SET
         email=excluded.email, email_verified=excluded.email_verified,
         display_name=excluded.display_name, avatar_url=excluded.avatar_url,
         updated_at=excluded.updated_at, last_login_at=excluded.last_login_at`,
    ).run(createId("usr"), input.authProvider, input.providerSubject, input.email ?? null,
          input.emailVerified ? 1 : 0, input.displayName ?? null, input.avatarUrl ?? null, now, now, now);
    const row = this.db.prepare("SELECT * FROM users WHERE auth_provider=? AND provider_subject=?")
      .get(input.authProvider, input.providerSubject) as Row;
    await this.rbacTransaction((q) => initializeUserTenant(q, row.id as string));
    return (await this.getUser(row.id as string))!;
  }

  async getUser(id: string): Promise<User | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  async getUserByVerifiedEmail(email: string): Promise<User | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND email_verified = 1").get(email) as Row | undefined;
    return row ? toUser(row) : null;
  }

  async searchUsers(q: string, viewerId: string, limit: number): Promise<User[]> {
    return (await searchTenantUsers(this.rbacQuery, q, viewerId, limit)).map(toUser);
  }

  async removeCollaborator(siteId: string, userId: string): Promise<void> {
    this.db.prepare("DELETE FROM site_members WHERE site_id=? AND user_id=?").run(siteId, userId);
  }

  async updateSiteSharing(siteId: string, visibility: Visibility, editPolicy: EditPolicy): Promise<void> {
    this.db.prepare("UPDATE sites SET visibility=?, edit_policy=?, updated_at=? WHERE id=? AND deleted_at IS NULL")
      .run(visibility, editPolicy, Date.now(), siteId);
  }

  async listCollaborators(siteId: string): Promise<SiteCollaborator[]> {
    return (this.db.prepare("SELECT * FROM site_members WHERE site_id=? ORDER BY granted_at").all(siteId) as Row[]).map(toCollaborator);
  }

  // --- share links -------------------------------------------------------------
  // Every statement below matches db-postgres.ts predicate for predicate, ORDER BY for ORDER BY;
  // see the comments there for why each is shaped the way it is. This is the side the test suite
  // runs, so it is also the side where a drift is invisible — the other one is production.

  async createShare(input: InsertShareInput): Promise<Share> {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO site_shares (id, site_id, token_hash, policy, passcode_hash, label, created_by, created_anon, created_at, expires_at, revoked_at, allow_ai, mode, version_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
    ).run(input.id, input.siteId, input.tokenHash, input.policy, input.passcodeHash ?? null, input.label ?? null,
          input.createdBy ?? null, input.createdAnonId ?? null, now, input.expiresAt ?? null, input.allowAi ? 1 : 0, input.mode ?? "view", input.versionId ?? null);
    // Read back rather than reconstruct, so the returned object is the stored row (the Postgres side
    // gets this from RETURNING *). toShare, never toShareRow: the two hashes stay in the store.
    const row = this.db.prepare("SELECT * FROM site_shares WHERE id=?").get(input.id) as Row;
    return toShare(row);
  }

  async getShareByTokenHash(tokenHash: string): Promise<ShareRow | null> {
    const row = this.db.prepare("SELECT * FROM site_shares WHERE token_hash=?").get(tokenHash) as Row | undefined;
    return row ? toShareRow(row) : null;
  }

  async getShare(id: string): Promise<ShareRow | null> {
    const row = this.db.prepare("SELECT * FROM site_shares WHERE id=?").get(id) as Row | undefined;
    return row ? toShareRow(row) : null;
  }

  async listShares(siteId: string): Promise<Share[]> {
    // Unfiltered — the owner's management list, revoked and expired rows included. The gate's
    // filtered view is listLiveShares. `id DESC` breaks created_at ties; NOT rowid DESC, which would
    // be the natural SQLite choice but has no Postgres counterpart on this table.
    return (this.db.prepare("SELECT * FROM site_shares WHERE site_id=? ORDER BY created_at DESC, id DESC")
      .all(siteId) as Row[]).map(toShare);
  }

  async revokeShare(id: string, at: number): Promise<void> {
    this.db.prepare("UPDATE site_shares SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(at, id);
  }

  async updateSharePolicy(id: string, policy: SharePolicy, passcodeHash: string | null, expiresAt: number | null): Promise<void> {
    this.db.prepare("UPDATE site_shares SET policy=?, passcode_hash=?, expires_at=? WHERE id=?")
      .run(policy, passcodeHash, expiresAt, id);
  }

  async setShareAllowAi(id: string, allowAi: boolean): Promise<void> {
    this.db.prepare("UPDATE site_shares SET allow_ai=? WHERE id=?").run(allowAi ? 1 : 0, id);
  }

  async listLiveShares(siteId: string, now: number): Promise<ShareRow[]> {
    // The read gate's input. `expires_at > now` is strict; the IS NULL arm is what keeps a
    // never-expiring link alive (`NULL > now` is NULL, which would drop it).
    return (this.db.prepare(
      `SELECT * FROM site_shares
        WHERE site_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC, id DESC`).all(siteId, now) as Row[]).map(toShareRow);
  }

  async addShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }, grantedBy: string | null): Promise<void> {
    const { userId, email } = shareGrantTarget(target);
    const now = Date.now();
    if (userId != null) {
      // OR IGNORE is the SQLite half of the Postgres ON CONFLICT DO NOTHING: re-adding the same
      // person is a no-op. Both partial unique indexes are honoured automatically here — SQLite
      // picks whichever the row actually violates, so no arbiter has to be named.
      this.db.prepare("INSERT OR IGNORE INTO share_grants (share_id, user_id, email, granted_by, granted_at) VALUES (?,?,NULL,?,?)")
        .run(shareId, userId, grantedBy, now);
      return;
    }
    // Stored as typed, deduplicated on lower(email) by uq_share_grants_email.
    this.db.prepare("INSERT OR IGNORE INTO share_grants (share_id, user_id, email, granted_by, granted_at) VALUES (?,NULL,?,?,?)")
      .run(shareId, email, grantedBy, now);
  }

  async removeShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }): Promise<void> {
    const { userId, email } = shareGrantTarget(target);
    if (userId != null) {
      this.db.prepare("DELETE FROM share_grants WHERE share_id=? AND user_id=?").run(shareId, userId);
      return;
    }
    this.db.prepare("DELETE FROM share_grants WHERE share_id=? AND lower(email)=lower(?)").run(shareId, email);
  }

  async listShareGrants(shareId: string): Promise<ShareGrant[]> {
    // LEFT JOIN so e-mail grants (no user row yet) survive the join with display_name NULL, and
    // COALESCE in the tiebreaker because SQLite sorts NULLs first while Postgres sorts them last.
    return (this.db.prepare(
      `SELECT g.share_id, g.user_id, g.email, g.granted_at, u.display_name
         FROM share_grants g LEFT JOIN users u ON u.id = g.user_id
        WHERE g.share_id=?
        ORDER BY g.granted_at, COALESCE(g.user_id, g.email)`).all(shareId) as Row[]).map(toShareGrantRow);
  }

  async shareAdmits(shareId: string, userId: string, verifiedEmail: string | null): Promise<boolean> {
    // `|| null` so an empty string cannot stand in for a verified address. The e-mail arm is gated
    // on the PARAMETER being non-null: no verified address admits nobody, stated rather than left to
    // be inferred from SQL's NULL semantics. An e-mail row cannot slip through the account arm
    // either — its user_id is NULL, and `NULL = ?` is NULL.
    const email = verifiedEmail || null;
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM share_grants
        WHERE share_id=?
          AND (user_id = ? OR (? IS NOT NULL AND email IS NOT NULL AND lower(email) = lower(?)))
        LIMIT 1`).get(shareId, userId, email, email);
    return row != null;
  }

  async recordShareView(view: ShareView): Promise<void> {
    this.db.prepare("INSERT INTO share_views (share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at) VALUES (?,?,?,?,?,?,?)")
      .run(view.shareId, view.siteId, view.userId, view.anonId, view.ip, view.userAgent, view.viewedAt);
  }

  async hasRecentShareView(shareId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean> {
    // Identity is a strict ladder, not a union: account, else browser, else IP. A reader with none
    // of the three matches nothing (`ip = NULL` is NULL) rather than folding together with every
    // other anonymous hit.
    const u = userId || null;
    const a = anonId || null;
    const i = ip || null;
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM share_views
        WHERE share_id=? AND viewed_at >= ?
          AND ( (? IS NOT NULL AND user_id = ?)
             OR (? IS NULL AND ? IS NOT NULL AND anon_id = ?)
             OR (? IS NULL AND ? IS NULL AND ip = ?) )
        LIMIT 1`).get(shareId, since, u, u, u, a, a, u, a, i);
    return row != null;
  }

  async listShareViews(siteId: string, limit: number): Promise<ShareView[]> {
    // Newest first, no tiebreaker — share_views has nothing both backends could order ties by.
    return (this.db.prepare("SELECT * FROM share_views WHERE site_id=? ORDER BY viewed_at DESC LIMIT ?")
      .all(siteId, limit) as Row[]).map(toShareView);
  }

  async pruneShareViews(before: number): Promise<number> {
    // Strictly `<`: a row landing exactly on the retention boundary is kept.
    const r = this.db.prepare("DELETE FROM share_views WHERE viewed_at < ?").run(before);
    return Number(r.changes ?? 0);
  }

  async recordSiteView(view: SiteView): Promise<void> {
    this.db.prepare("INSERT INTO site_views (site_id, user_id, anon_id, ip, user_agent, viewed_at) VALUES (?,?,?,?,?,?)")
      .run(view.siteId, view.userId, view.anonId, view.ip, view.userAgent, view.viewedAt);
  }

  async hasRecentSiteView(siteId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean> {
    // Same strict identity ladder as hasRecentShareView: account, else browser, else IP —
    // and a reader with none of the three matches nothing.
    const u = userId || null;
    const a = anonId || null;
    const i = ip || null;
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM site_views
        WHERE site_id=? AND viewed_at >= ?
          AND ( (? IS NOT NULL AND user_id = ?)
             OR (? IS NULL AND ? IS NOT NULL AND anon_id = ?)
             OR (? IS NULL AND ? IS NULL AND ip = ?) )
        LIMIT 1`).get(siteId, since, u, u, u, a, a, u, a, i);
    return row != null;
  }

  async listSiteOpens(siteId: string, limit: number): Promise<SiteOpen[]> {
    // One list, both doors. Newest first, same no-tiebreaker stance as listShareViews.
    return (this.db.prepare(
      `SELECT share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at FROM share_views WHERE site_id=?
       UNION ALL
       SELECT NULL AS share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at FROM site_views WHERE site_id=?
       ORDER BY viewed_at DESC LIMIT ?`)
      .all(siteId, siteId, limit) as Row[]).map(toSiteOpen);
  }

  async getSiteViewStats(siteId: string, since: number, exclude: { userIds: readonly string[]; anonIds: readonly string[] }): Promise<SiteViewStats> {
    // The exclusion lists are interpolated as placeholders (SQLite has no array parameters); an
    // empty list must not emit `IN ()`, which SQLite rejects.
    const userExcl = exclude.userIds.length
      ? `AND (user_id IS NULL OR user_id NOT IN (${exclude.userIds.map(() => "?").join(",")}))`
      : "";
    const anonExcl = exclude.anonIds.length
      ? `AND (anon_id IS NULL OR anon_id NOT IN (${exclude.anonIds.map(() => "?").join(",")}))`
      : "";
    const perTable = [siteId, ...exclude.userIds, ...exclude.anonIds];
    const row = this.db.prepare(
      `WITH opens AS (
         SELECT user_id, anon_id, ip, viewed_at FROM share_views WHERE site_id=? ${userExcl} ${anonExcl}
         UNION ALL
         SELECT user_id, anon_id, ip, viewed_at FROM site_views WHERE site_id=? ${userExcl} ${anonExcl}
       )
       SELECT
         (SELECT COUNT(*) FROM opens WHERE viewed_at >= ?) AS opens,
         (SELECT COUNT(DISTINCT COALESCE(user_id, anon_id, ip)) FROM opens WHERE viewed_at >= ?) AS uniq,
         (SELECT MAX(viewed_at) FROM opens) AS last`)
      .get(...perTable, ...perTable, since, since) as Row;
    return {
      opens: Number(row.opens ?? 0),
      uniqueViewers: Number(row.uniq ?? 0),
      lastViewedAt: row.last == null ? null : Number(row.last),
    };
  }

  async pruneSiteViews(before: number): Promise<number> {
    // Strictly `<`, mirroring pruneShareViews.
    const r = this.db.prepare("DELETE FROM site_views WHERE viewed_at < ?").run(before);
    return Number(r.changes ?? 0);
  }

  async claimSiteAudited(siteId: string, ownerId: string, audit: InsertAuditInput, adminLog?: AdminLogEntry): Promise<boolean> {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare("UPDATE sites SET owner_id=?, tenant_id=CASE WHEN tenant_id='anonymous' THEN 'init' ELSE tenant_id END, updated_at=? WHERE id=? AND owner_id IS NULL AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM tenant_members tm JOIN users u ON u.id=tm.user_id JOIN tenants t ON t.id=tm.tenant_id WHERE tm.user_id=? AND tm.tenant_id=CASE WHEN sites.tenant_id='anonymous' THEN 'init' ELSE sites.tenant_id END AND u.disabled_at IS NULL AND t.disabled_at IS NULL)")
        .run(ownerId, now, siteId, ownerId);
      if (Number(r.changes ?? 0) === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.writeAuditRow(audit, now);
      if (adminLog) {
        const e = adminLog;
        this.db.prepare("INSERT INTO admin_log (id, actor_kind, actor_user_id, action, target_kind, target_id, reason, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(e.id, e.actorKind, e.actorUserId, e.action, e.targetKind, e.targetId, e.reason, e.ip, e.createdAt);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async attributeUnattributedVersions(siteId: string, userId: string): Promise<number> {
    const r = this.db.prepare("UPDATE versions SET created_by=? WHERE site_id=? AND created_by IS NULL").run(userId, siteId);
    return Number(r.changes ?? 0);
  }

  async clearSiteOwner(siteId: string): Promise<void> {
  // Reset edit_policy alongside the owner. Leaving 'login' on an unowned site would keep it
  // writable by every authenticated user with nobody left who can change that back — the owner
  // was the only role permitted to touch sharing settings.
    this.db.prepare("UPDATE sites SET owner_id=NULL, edit_policy='owner', updated_at=? WHERE id=?").run(Date.now(), siteId);
  }

  async listSitesByOwner(ownerId: string): Promise<SiteSummary[]> {
    return (this.db.prepare(`SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id
      WHERE EXISTS (SELECT 1 FROM tenants rt WHERE rt.id=s.tenant_id AND rt.disabled_at IS NULL) AND s.deleted_at IS NULL AND s.current_version_id IS NOT NULL AND s.owner_id = ? AND EXISTS (SELECT 1 FROM tenant_members m WHERE m.tenant_id=s.tenant_id AND m.user_id=s.owner_id)
      ORDER BY s.updated_at DESC`).all(ownerId) as Row[]).map(toSummary);
  }

  async listSitesForCollaborator(userId: string): Promise<SiteSummary[]> {
    return (this.db.prepare(`SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id
      JOIN site_members c ON c.site_id = s.id AND c.user_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=c.user_id)
      WHERE EXISTS (SELECT 1 FROM tenants rt WHERE rt.id=s.tenant_id AND rt.disabled_at IS NULL) AND s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
      ORDER BY s.updated_at DESC`).all(userId) as Row[]).map(toSummary);
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    const now = Date.now();
    this.db.prepare("INSERT INTO sessions (id, user_id, oidc_sid, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.userId, input.oidcSid ?? null, now, input.expiresAt, input.absoluteExpiresAt, now, input.ip ?? null, input.userAgent ?? null);
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Row | undefined;
    return row ? toSession(row) : null;
  }

  async insertPublishToken(t: { id: string; userId: string; name: string; createdAt: number }): Promise<void> {
    this.db.prepare("INSERT INTO publish_tokens (id, user_id, name, created_at) VALUES (?,?,?,?)")
      .run(t.id, t.userId, t.name, t.createdAt);
  }

  async getPublishToken(id: string): Promise<PublishToken | null> {
    const row = this.db.prepare("SELECT * FROM publish_tokens WHERE id=?").get(id) as Row | undefined;
    return row ? toPublishToken(row) : null;
  }

  async touchPublishToken(id: string, lastUsedAt: number): Promise<void> {
    this.db.prepare("UPDATE publish_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL").run(lastUsedAt, id);
  }

  async listPublishTokens(userId: string): Promise<PublishToken[]> {
    const rows = this.db.prepare("SELECT * FROM publish_tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as Row[];
    return rows.map(toPublishToken);
  }

  async revokePublishToken(id: string, userId: string): Promise<boolean> {
    const res = this.db.prepare("UPDATE publish_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL")
      .run(Date.now(), id, userId);
    return res.changes > 0;
  }

  // --- OAuth (lib/oauth) -------------------------------------------------------------------

  async insertOauthClient(c: OauthClientRecord): Promise<void> {
    this.db.prepare("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, token_endpoint_auth_method, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)")
      .run(c.id, c.secretHash, c.name, JSON.stringify(c.redirectUris), c.tokenEndpointAuthMethod, c.createdAt, c.lastUsedAt);
  }

  async getOauthClient(id: string): Promise<OauthClientRecord | null> {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(id) as Row | undefined;
    return row ? toOauthClient(row) : null;
  }

  async touchOauthClient(id: string, now: number): Promise<void> {
    this.db.prepare("UPDATE oauth_clients SET last_used_at=? WHERE id=?").run(now, id);
  }

  async insertOauthAuthorization(a: OauthAuthorization): Promise<void> {
    this.db.prepare(
      `INSERT INTO oauth_authorizations (id, client_id, client_name, redirect_uri, scope, state, code_challenge, resource, user_id, code_hash, grant_id, created_at, expires_at, approved_at, consumed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(a.id, a.clientId, a.clientName, a.redirectUri, a.scope, a.state, a.codeChallenge, a.resource, a.userId, a.codeHash, a.grantId, a.createdAt, a.expiresAt, a.approvedAt, a.consumedAt);
  }

  async getOauthAuthorization(id: string): Promise<OauthAuthorization | null> {
    const row = this.db.prepare("SELECT * FROM oauth_authorizations WHERE id=?").get(id) as Row | undefined;
    return row ? toOauthAuthorization(row) : null;
  }

  async approveOauthAuthorization(id: string, userId: string, code: { codeHash: string; grantId: string; expiresAt: number }, now: number): Promise<boolean> {
    const res = this.db.prepare(
      "UPDATE oauth_authorizations SET approved_at=?, code_hash=?, grant_id=?, expires_at=? WHERE id=? AND user_id=? AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ?",
    ).run(now, code.codeHash, code.grantId, code.expiresAt, id, userId, now);
    return Number(res.changes ?? 0) > 0;
  }

  async consumeOauthAuthorization(id: string, now: number): Promise<boolean> {
    const res = this.db.prepare("UPDATE oauth_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now, id);
    return Number(res.changes ?? 0) > 0;
  }

  async redeemOauthCode(codeHash: string, now: number): Promise<{ authorization: OauthAuthorization; reused: boolean } | null> {
    // Consume first, then read — the same order as the Postgres backend, for the same reason.
    const row = this.db.prepare(
      "UPDATE oauth_authorizations SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at > ? RETURNING *",
    ).get(now, codeHash, now) as Row | undefined;
    if (row) return { authorization: toOauthAuthorization(row), reused: false };
    const seen = this.db.prepare("SELECT * FROM oauth_authorizations WHERE code_hash=?").get(codeHash) as Row | undefined;
    return seen && seen.consumed_at != null ? { authorization: toOauthAuthorization(seen), reused: true } : null;
  }

  async insertOauthTokens(tokens: OauthToken[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(
        `INSERT INTO oauth_tokens (id, kind, grant_id, user_id, client_id, client_name, scope, resource, grant_created_at, created_at, expires_at, absolute_expires_at, last_used_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const t of tokens) {
        insert.run(t.id, t.kind, t.grantId, t.userId, t.clientId, t.clientName, t.scope, t.resource, t.grantCreatedAt, t.createdAt, t.expiresAt, t.absoluteExpiresAt, t.lastUsedAt, t.revokedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async getOauthToken(id: string): Promise<OauthToken | null> {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE id=?").get(id) as Row | undefined;
    return row ? toOauthToken(row) : null;
  }

  async touchOauthToken(id: string, now: number): Promise<void> {
    this.db.prepare("UPDATE oauth_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL").run(now, id);
  }

  async consumeOauthRefreshToken(id: string, now: number): Promise<{ token: OauthToken; reused: boolean } | null> {
    const row = this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE id=? AND kind='refresh' AND revoked_at IS NULL AND expires_at > ? RETURNING *").get(now, id, now) as Row | undefined;
    if (row) return { token: toOauthToken(row), reused: false };
    const seen = this.db.prepare("SELECT * FROM oauth_tokens WHERE id=? AND kind='refresh'").get(id) as Row | undefined;
    return seen && seen.revoked_at != null ? { token: toOauthToken(seen), reused: true } : null;
  }

  async revokeOauthToken(id: string, now: number): Promise<boolean> {
    return Number(this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, id).changes ?? 0) > 0;
  }

  async revokeOauthGrant(grantId: string, now: number, userId: string | null = null): Promise<number> {
    const res = userId == null
      ? this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL").run(now, grantId)
      : this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND user_id=? AND revoked_at IS NULL").run(now, grantId, userId);
    return Number(res.changes ?? 0);
  }

  async revokeOauthGrantsForClient(userId: string, clientId: string, now: number, exceptGrantId: string): Promise<number> {
    return Number(this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE user_id=? AND client_id=? AND grant_id<>? AND revoked_at IS NULL").run(now, userId, clientId, exceptGrantId).changes ?? 0);
  }

  async listOauthConnections(userId: string, now: number): Promise<OauthConnection[]> {
    const rows = this.db.prepare(
      `SELECT r.grant_id, r.client_id, r.client_name, r.scope, r.grant_created_at AS connected_at,
              (SELECT MAX(t.last_used_at) FROM oauth_tokens t WHERE t.grant_id = r.grant_id) AS last_used_at
       FROM oauth_tokens r WHERE r.user_id=? AND r.kind='refresh' AND r.revoked_at IS NULL AND r.expires_at > ?
       ORDER BY r.grant_created_at DESC`,
    ).all(userId, now) as Row[];
    return rows.map(toOauthConnection);
  }

  async revokeOauthTokensForUser(userId: string, now: number): Promise<number> {
    return Number(this.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, userId).changes ?? 0);
  }

  async pruneOauth(now: number): Promise<number> {
    const day = 24 * 60 * 60 * 1000;
    const requests = this.db.prepare("DELETE FROM oauth_authorizations WHERE expires_at < ?").run(now - day);
    const tokens = this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(now - day, now - 7 * day);
    const clients = this.db.prepare(
      "DELETE FROM oauth_clients WHERE (last_used_at IS NULL AND created_at < ?) OR (COALESCE(last_used_at, created_at) < ? AND id NOT IN (SELECT client_id FROM oauth_tokens))",
    ).run(now - day, now - 90 * day);
    return Number(requests.changes ?? 0) + Number(tokens.changes ?? 0) + Number(clients.changes ?? 0);
  }

  async listFolders(userId: string): Promise<UserFolder[]> {
    const rows = this.db.prepare("SELECT * FROM folders WHERE user_id=? ORDER BY sort ASC, created_at ASC").all(userId) as Row[];
    return rows.map(toUserFolder);
  }

  async insertFolder(f: { id: string; userId: string; name: string; createdAt: number }, maxFolders: number): Promise<boolean> {
    const res = this.db.prepare(
      `INSERT INTO folders (id, user_id, name, sort, created_at, updated_at)
       SELECT ?, ?, ?, COALESCE(MAX(sort) + 1, 0), ?, ? FROM folders WHERE user_id = ?
       HAVING COUNT(*) < ?`).run(f.id, f.userId, f.name, f.createdAt, f.createdAt, f.userId, maxFolders);
    return res.changes > 0;
  }

  async renameFolder(id: string, userId: string, name: string, now: number): Promise<boolean> {
    return this.db.prepare("UPDATE folders SET name=?, updated_at=? WHERE id=? AND user_id=?").run(name, now, id, userId).changes > 0;
  }

  async deleteFolder(id: string, userId: string): Promise<boolean> {
    const tx = this.db.prepare("BEGIN"); tx.run();
    try {
      this.db.prepare("DELETE FROM folder_assignments WHERE folder_id=? AND user_id=?").run(id, userId);
      const changes = this.db.prepare("DELETE FROM folders WHERE id=? AND user_id=?").run(id, userId).changes;
      this.db.prepare("COMMIT").run();
      return changes > 0;
    } catch (error) {
      this.db.prepare("ROLLBACK").run();
      throw error;
    }
  }

  async listFolderAssignments(userId: string): Promise<FolderAssignment[]> {
    const rows = this.db.prepare(
      `SELECT a.site_id, a.folder_id, s.slug FROM folder_assignments a
         JOIN sites s ON s.id = a.site_id
        WHERE a.user_id=? AND s.deleted_at IS NULL`).all(userId) as Row[];
    return rows.map((r) => ({ siteId: r.site_id as string, slug: r.slug as string, folderId: r.folder_id as string }));
  }

  async setFolderAssignment(userId: string, siteId: string, folderId: string | null, now: number): Promise<boolean> {
    if (folderId === null) {
      this.db.prepare("DELETE FROM folder_assignments WHERE user_id=? AND site_id=?").run(userId, siteId);
      return true;
    }
    const owned = this.db.prepare("SELECT 1 FROM folders WHERE id=? AND user_id=?").get(folderId, userId);
    if (!owned) return false;
    this.db.prepare(
      `INSERT INTO folder_assignments (user_id, site_id, folder_id, updated_at) VALUES (?,?,?,?)
       ON CONFLICT (user_id, site_id) DO UPDATE SET folder_id=excluded.folder_id, updated_at=excluded.updated_at`)
      .run(userId, siteId, folderId, now);
    return true;
  }

  async insertUploadSession(u: UploadSessionRow): Promise<void> {
    this.db.prepare("INSERT INTO upload_sessions (version_id, site_id, target_slug, title, owner_key, files, created_at, tenant_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(u.versionId, u.siteId, u.targetSlug ?? null, u.title ?? null, u.ownerKey, JSON.stringify(u.files), u.createdAt, u.tenantId ?? null);
  }
  async getUploadSession(versionId: string): Promise<UploadSessionRow | null> {
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE version_id=?").get(versionId) as Row | undefined;
    return row ? toUploadSession(row) : null;
  }
  async compareUploadSessionFiles(versionId: string, before: UploadSessionRow["files"], after: UploadSessionRow["files"]): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT files FROM upload_sessions WHERE version_id=?").get(versionId) as { files: string } | undefined;
      const matches = !!row && isDeepStrictEqual(JSON.parse(row.files), before);
      if (matches) this.db.prepare("UPDATE upload_sessions SET files=? WHERE version_id=?").run(JSON.stringify(after), versionId);
      this.db.exec("COMMIT");
      return matches;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  async setUploadSessionFiles(versionId: string, files: UploadSessionRow["files"]): Promise<void> {
    this.db.prepare("UPDATE upload_sessions SET files=? WHERE version_id=?").run(JSON.stringify(files), versionId);
  }
  async deleteUploadSession(versionId: string): Promise<void> {
    this.db.prepare("DELETE FROM upload_sessions WHERE version_id=?").run(versionId);
  }
  async listUploadSessionsForTarget(ownerKey: string, targetSlug: string): Promise<UploadSessionRow[]> {
    return (this.db.prepare("SELECT * FROM upload_sessions WHERE owner_key=? AND target_slug=?").all(ownerKey, targetSlug) as Row[]).map(toUploadSession);
  }
  async listUploadSessionsBefore(createdBefore: number): Promise<UploadSessionRow[]> {
    return (this.db.prepare("SELECT * FROM upload_sessions WHERE created_at < ?").all(createdBefore) as Row[]).map(toUploadSession);
  }

  async insertDeviceGrant(g: { deviceCode: string; userCode: string; createdAt: number; expiresAt: number }): Promise<void> {
    try {
      this.db.prepare("INSERT INTO device_grants (device_code, user_code, created_at, expires_at) VALUES (?,?,?,?)")
        .run(g.deviceCode, g.userCode, g.createdAt, g.expiresAt);
    } catch (error) {
      if (String((error as Error)?.message).includes("UNIQUE constraint failed: device_grants.user_code")) throw new UserCodeConflictError();
      throw error;
    }
  }

  async getDeviceGrant(deviceCode: string): Promise<DeviceGrant | null> {
    const row = this.db.prepare("SELECT * FROM device_grants WHERE device_code=?").get(deviceCode) as Row | undefined;
    return row ? toDeviceGrant(row) : null;
  }

  async approveDeviceGrant(userCode: string, userId: string, now: number): Promise<boolean> {
    const res = this.db.prepare("UPDATE device_grants SET status='approved', user_id=? WHERE user_code=? AND status='pending' AND expires_at>?")
      .run(userId, userCode, now);
    return res.changes > 0;
  }

  async redeemDeviceGrant(deviceCode: string, token: { id: string; name: string }, now: number): Promise<string | null> {
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare(
        "UPDATE device_grants SET status='consumed', consumed_at=? WHERE device_code=? AND status='approved' AND expires_at>? RETURNING user_id",
      ).get(now, deviceCode, now) as Row | undefined;
      const userId = row ? ((row.user_id as string | null) ?? null) : null;
      if (!userId) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare("INSERT INTO publish_tokens (id, user_id, name, created_at) VALUES (?,?,?,?)")
        .run(token.id, userId, token.name, now);
      this.db.exec("COMMIT");
      return userId;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async touchSession(id: string, expiresAt: number, lastSeenAt: number): Promise<void> {
    this.db.prepare("UPDATE sessions SET expires_at=?, last_seen_at=? WHERE id=? AND revoked_at IS NULL").run(expiresAt, lastSeenAt, id);
  }

  async revokeSession(id: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(Date.now(), id);
  }

  async revokeUserSessions(userId: string, exceptId: string | null = null): Promise<number> {
    const r = this.db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)")
      .run(Date.now(), userId, exceptId, exceptId);
    return Number(r.changes ?? 0);
  }

  async revokeSessionsByOidcSid(sid: string): Promise<number> {
    const r = this.db.prepare("UPDATE sessions SET revoked_at=? WHERE oidc_sid=? AND revoked_at IS NULL").run(Date.now(), sid);
    return Number(r.changes ?? 0);
  }

  async createOidcFlow(input: CreateOidcFlowInput): Promise<void> {
    // Sweep on write rather than adding a cron — see the Postgres backend for the reasoning.
    this.db.prepare("DELETE FROM oidc_flows WHERE expires_at < ?").run(Date.now() - 24 * 60 * 60 * 1000);
    this.db.prepare("INSERT INTO oidc_flows (flow_id, verifier, nonce, return_to, created_at, expires_at) VALUES (?,?,?,?,?,?)")
      .run(input.flowId, input.verifier, input.nonce, input.returnTo, Date.now(), input.expiresAt);
  }

  async consumeOidcFlow(flowId: string, now: number): Promise<CreateOidcFlowInput | null> {
    const r = this.db.prepare("UPDATE oidc_flows SET consumed_at=? WHERE flow_id=? AND consumed_at IS NULL AND expires_at > ?")
      .run(now, flowId, now);
    if (Number(r.changes ?? 0) === 0) return null;
    const row = this.db.prepare("SELECT * FROM oidc_flows WHERE flow_id=?").get(flowId) as Row;
    return { flowId: row.flow_id as string, verifier: row.verifier as string, nonce: row.nonce as string,
             returnTo: row.return_to as string, expiresAt: Number(row.expires_at) };
  }

  // --- administration -----------------------------------------------------------

  async setUserDisabled(id: string, at: number | null, reason: string | null): Promise<boolean> {
    const r = at == null
      ? this.db.prepare("UPDATE users SET disabled_at=NULL, disabled_reason=NULL, updated_at=? WHERE id=? AND disabled_at IS NOT NULL").run(Date.now(), id)
      : this.db.prepare("UPDATE users SET disabled_at=?, disabled_reason=?, updated_at=? WHERE id=? AND disabled_at IS NULL").run(at, reason, at, id);
    return Number(r.changes ?? 0) > 0;
  }

  async revokePublishTokensForUser(userId: string): Promise<number> {
    const r = this.db.prepare("UPDATE publish_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(Date.now(), userId);
    return Number(r.changes ?? 0);
  }

  async setSiteTakenDown(id: string, at: number | null, reason: string | null): Promise<boolean> {
    const r = at == null
      ? this.db.prepare("UPDATE sites SET taken_down_at=NULL, taken_down_reason=NULL, updated_at=? WHERE id=? AND taken_down_at IS NOT NULL").run(Date.now(), id)
      : this.db.prepare("UPDATE sites SET taken_down_at=?, taken_down_reason=?, updated_at=? WHERE id=? AND taken_down_at IS NULL AND deleted_at IS NULL").run(at, reason, at, id);
    return Number(r.changes ?? 0) > 0;
  }

  async restoreDeletedSite(id: string): Promise<boolean> {
    const r = this.db.prepare("UPDATE sites SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL AND purged_at IS NULL").run(Date.now(), id);
    return Number(r.changes ?? 0) > 0;
  }

  async setSitePurged(id: string, at: number): Promise<void> {
    this.db.prepare("UPDATE sites SET purged_at=? WHERE id=? AND purged_at IS NULL AND deleted_at IS NOT NULL").run(at, id);
    this.db.prepare("DELETE FROM site_texts WHERE site_id=?").run(id);
    this.db.prepare("DELETE FROM site_texts_fts WHERE site_id=?").run(id);
  }

  async listDeletedSitesBefore(before: number, limit: number): Promise<Site[]> {
    const rows = this.db.prepare("SELECT * FROM sites WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND purged_at IS NULL ORDER BY deleted_at ASC LIMIT ?").all(before, limit) as Row[];
    return rows.map(toSite);
  }

  async insertAdminLog(e: AdminLogEntry): Promise<void> {
    this.db.prepare("INSERT INTO admin_log (id, actor_kind, actor_user_id, action, target_kind, target_id, reason, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(e.id, e.actorKind, e.actorUserId, e.action, e.targetKind, e.targetId, e.reason, e.ip, e.createdAt);
  }

  async listAdminLog(opts: { targetId?: string | null; limit: number }): Promise<AdminLogEntry[]> {
    const t = opts.targetId ?? null;
    const rows = this.db.prepare("SELECT * FROM admin_log WHERE (? IS NULL OR target_id = ?) ORDER BY created_at DESC, id LIMIT ?").all(t, t, opts.limit) as Row[];
    return rows.map(toAdminLog);
  }

  async hasRecentAdminLog(actorUserId: string, action: AdminAction, targetId: string, since: number): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 AS x FROM admin_log WHERE actor_user_id=? AND action=? AND target_id=? AND created_at >= ? LIMIT 1").get(actorUserId, action, targetId, since);
    return row != null;
  }

  async upsertSiteText(w: SiteTextWrite): Promise<boolean> {
    this.db.exec("BEGIN");
    try {
      // The EXISTS guard is the race protection — see the Postgres side.
      const { changes } = this.db.prepare(`INSERT INTO site_texts (site_id, version_id, title, body, chars, extracted_at, extractor_version)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sites WHERE id = ? AND current_version_id = ?)
        ON CONFLICT (site_id) DO UPDATE SET version_id=excluded.version_id, title=excluded.title, body=excluded.body, chars=excluded.chars, extracted_at=excluded.extracted_at, extractor_version=excluded.extractor_version`)
        .run(w.siteId, w.versionId, w.title, w.body, w.body.length, w.extractedAt, w.extractorVersion, w.siteId, w.versionId);
      if (Number(changes) > 0) {
        this.db.prepare("DELETE FROM site_texts_fts WHERE site_id=?").run(w.siteId);
        this.db.prepare("INSERT INTO site_texts_fts (site_id, title_tokens, body_tokens) VALUES (?,?,?)").run(w.siteId, w.titleTokens, w.bodyTokens);
      }
      this.db.exec("COMMIT");
      return Number(changes) > 0;
    } catch (error) {
      // Swallow a failing ROLLBACK — see insertSiteWithVersion.
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async updateSiteTextTitle(siteId: string, title: string, titleTokens: string): Promise<boolean> {
    this.db.exec("BEGIN");
    try {
      const { changes } = this.db.prepare("UPDATE site_texts SET title=? WHERE site_id=?").run(title, siteId);
      if (Number(changes) > 0) this.db.prepare("UPDATE site_texts_fts SET title_tokens=? WHERE site_id=?").run(titleTokens, siteId);
      this.db.exec("COMMIT");
      return Number(changes) > 0;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async getSiteText(siteId: string): Promise<SiteTextRow | null> {
    const row = this.db.prepare("SELECT site_id, version_id, title, body, chars, extracted_at, extractor_version FROM site_texts WHERE site_id=?").get(siteId) as Row | undefined;
    return row ? toSiteText(row) : null;
  }

  async searchSiteTexts(viewer: ListViewer | undefined, tokens: SearchToken[], limit: number): Promise<SearchHit[]> {
    if (!tokens.length) return [];
    // FTS5: quoted terms are ANDed, a trailing * is a prefix; bm25 is "lower is better", the title column weighted up.
    const match = tokens.map((t) => `"${t.text}"${t.prefix ? "*" : ""}`).join(" ");
    const rows = this.db.prepare(`
      SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.updated_at, substr(t.body, 1, 30000) AS body
      FROM site_texts_fts f
      JOIN site_texts t ON t.site_id = f.site_id
      JOIN sites s ON s.id = t.site_id AND s.current_version_id = t.version_id
      WHERE site_texts_fts MATCH ? AND s.deleted_at IS NULL
        AND ((COALESCE(s.visibility, 'public') = 'public' AND s.taken_down_at IS NULL)
             OR (s.owner_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=s.owner_id))
             OR (s.owner_id IS NULL AND s.anon_owner_id = ?)
             OR EXISTS (SELECT 1 FROM site_members c WHERE c.site_id = s.id AND c.user_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=c.user_id)))
      ORDER BY bm25(site_texts_fts, 0, 10.0, 1.0) ASC, s.updated_at DESC
      LIMIT ?`).all(match, viewer?.userId ?? null, viewer?.anonId ?? null, viewer?.userId ?? null, limit) as Row[];
    return rows.map(toSearchHit);
  }

  async listSitesNeedingText(limit: number): Promise<{ siteId: string; versionId: string }[]> {
    const rows = this.db.prepare(`
      SELECT s.id, s.current_version_id FROM sites s
      LEFT JOIN site_texts t ON t.site_id = s.id
      WHERE EXISTS (SELECT 1 FROM tenants rt WHERE rt.id=s.tenant_id AND rt.disabled_at IS NULL) AND s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
        AND (t.site_id IS NULL OR t.version_id <> s.current_version_id OR t.extractor_version < ?)
      ORDER BY s.updated_at DESC LIMIT ?`).all(SITE_TEXT_EXTRACTOR_VERSION, limit) as Row[];
    return rows.map((r) => ({ siteId: String(r.id), versionId: String(r.current_version_id) }));
  }

  async listSettings(scope: string): Promise<SettingRow[]> {
    const rows = this.db.prepare("SELECT * FROM settings WHERE scope=? ORDER BY key").all(scope) as Row[];
    return rows.map(toSettingRow);
  }

  async writeSettings(scope: string, writes: SettingWrite[], updatedBy: string | null, now: number): Promise<void> {
    this.db.exec("BEGIN");
    try {
      for (const w of writes) {
        if (w.value === null) this.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(scope, w.key);
        else this.db.prepare("INSERT INTO settings (scope, key, value, updated_at, updated_by) VALUES (?,?,?,?,?) ON CONFLICT (scope, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
          .run(scope, w.key, w.value, now, updatedBy);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }

  async adminOverview(): Promise<AdminOverview> {
    const row = this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled_users,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL) AS sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL AND owner_id IS NULL) AS anonymous_sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL AND taken_down_at IS NOT NULL) AS taken_down_sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NOT NULL AND purged_at IS NULL) AS deleted_sites,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM versions v JOIN sites s ON s.id = v.site_id WHERE s.purged_at IS NULL) AS byte_total`).get() as Row | undefined;
    return toAdminOverview(row ?? {});
  }

  async listUsersAdmin(opts: AdminUserQuery): Promise<{ rows: AdminUserRow[]; total: number }> {
    const order = adminUserOrder(opts.sort);
    const like = likeContains(opts.q);
    const rows = this.db.prepare(`
      SELECT u.*, COUNT(*) OVER() AS total,
             (SELECT COUNT(*) FROM sites s WHERE s.owner_id = u.id AND s.deleted_at IS NULL) AS site_count,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM sites s JOIN versions v ON v.site_id = s.id
               WHERE s.owner_id = u.id AND s.purged_at IS NULL) AS byte_total
      FROM users u
      WHERE (? = '' OR lower(COALESCE(u.email, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.display_name, '')) LIKE ? ESCAPE '\\')
        AND (? = 0 OR u.disabled_at IS NOT NULL)
      ORDER BY ${order}, u.id
      LIMIT ? OFFSET ?`).all(opts.q, like, like, opts.disabledOnly ? 1 : 0, opts.limit, opts.offset) as Row[];
    return { rows: rows.map(toAdminUserRow), total: Number(rows[0]?.total ?? 0) };
  }

  async listSitesAdmin(opts: AdminSiteQuery): Promise<{ rows: AdminSiteRow[]; total: number }> {
    const like = likeContains(opts.q);
    const rows = this.db.prepare(`
      SELECT s.*, u.email AS owner_email, u.display_name AS owner_name, COUNT(*) OVER() AS total,
             (SELECT COUNT(*) FROM versions v WHERE v.site_id = s.id) AS version_count,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM versions v WHERE v.site_id = s.id) AS byte_total
      FROM sites s LEFT JOIN users u ON u.id = s.owner_id
      WHERE (? = '' OR lower(s.title) LIKE ? ESCAPE '\\' OR lower(s.slug) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.email, '')) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR (s.owner_id = ? AND EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=s.tenant_id AND tm.user_id=s.owner_id)))
        AND (? = 0 OR s.owner_id IS NULL)
        AND CASE ? WHEN 'deleted' THEN (s.deleted_at IS NOT NULL AND s.purged_at IS NULL)
                    WHEN 'taken_down' THEN (s.deleted_at IS NULL AND s.taken_down_at IS NOT NULL)
                    ELSE s.deleted_at IS NULL END
      ORDER BY s.updated_at DESC, s.id
      LIMIT ? OFFSET ?`)
      .all(opts.q, like, like, like, opts.ownerId, opts.ownerId, opts.anonymousOnly ? 1 : 0, opts.state, opts.limit, opts.offset) as Row[];
    return { rows: rows.map(toAdminSiteRow), total: Number(rows[0]?.total ?? 0) };
  }

  // --- quotas and expiry --------------------------------------------------------

  async ownerUsage(owner: QuotaOwner): Promise<{ sites: number; bytes: number }> {
    const where = owner.userId ? "s.owner_id = ?" : "s.owner_id IS NULL AND s.anon_owner_id = ?";
    const key = owner.userId ?? owner.anonId;
    const row = this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM sites s WHERE ${where} AND s.deleted_at IS NULL) AS sites,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM sites s JOIN versions v ON v.site_id = s.id WHERE ${where} AND s.purged_at IS NULL) AS bytes`).get(key, key) as Row | undefined;
    return { sites: Number(row?.sites ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  async expireAnonymousSites(before: number, now: number, limit: number): Promise<Site[]> {
    const rows = this.db.prepare(`
      UPDATE sites SET deleted_at = ?, updated_at = ?
       WHERE id IN (SELECT id FROM sites
                     WHERE owner_id IS NULL AND anon_owner_id IS NOT NULL AND deleted_at IS NULL AND updated_at < ?
                     ORDER BY updated_at ASC LIMIT ?)
       RETURNING *`).all(now, now, before, limit) as Row[];
    return rows.map(toSite);
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
