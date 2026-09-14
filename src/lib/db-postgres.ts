// Postgres metadata backend. Enables multiple app replicas (no node-local state) once files are
// also on S3. Timestamps are BIGINT ms-epoch (same numbers as the SQLite backend); a BIGSERIAL
// `seq` gives a stable tiebreaker for version ordering.
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import pg from "pg";
import { config } from "@/lib/config";
import type {
  AuditEntry, EditPolicy, InsertShareInput, Session, Share, ShareGrant, SharePolicy, ShareRow, ShareView,
  Site, SiteCollaborator, SiteOpen, SiteSummary, SiteView, SiteViewStats, User, Version, Visibility,
  AdminAction, AdminLogEntry, AdminOverview, AdminSiteRow, AdminUserRow, SettingRow, SettingWrite,
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
  toPublishToken,
  toDeviceGrant,
  type InsertAuditInput,
  type InsertSiteInput,
  type InsertVersionInput,
  type CreateOidcFlowInput,
  type CreateSessionInput,
  type UpsertUserInput,
  type DeviceGrant,
  type ListViewer,
  type MetadataStore,
  type PublishToken,
  type VersionCommit,
  type Row,
  toUserFolder, type UserFolder, type FolderAssignment,
} from "@/lib/db";

// BIGINT (oid 20) comes back as a string by default to avoid precision loss; parse to Number
// (ms timestamps and our counts are safely < 2^53). Set once at module load.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));

const MIGRATION_LOCK_KEY = 4127713; // arbitrary constant; serializes DDL across replicas

// Idempotent forward migrations, applied in order inside the migration lock. To add a column to an
// EXISTING deployment, append `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` here — do NOT edit the
// base CREATE TABLE (IF NOT EXISTS would skip it on a DB that already has the table). Each statement
// must be idempotent (safe to run every startup).
const MIGRATIONS: readonly string[] = [
  // --- identity (users, sessions, OIDC flows; see ARCHITECTURE.md, "Identity") ---
  // NOTE on two shapes used throughout: every CREATE gets IF NOT EXISTS (init runs on EVERY
  // startup, so a bare CREATE INDEX would throw "already exists" on the second boot and roll the
  // whole migration transaction back — a crash loop that only shows up on the first restart);
  // and uniqueness over an expression MUST be a separate CREATE UNIQUE INDEX, because a
  // table-level UNIQUE(...) constraint only accepts bare column names in Postgres.
  `CREATE TABLE IF NOT EXISTS users (
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
   )`,
  // The ONLY join key to the IdP. Never the email — matching on email would let an attacker
  // pre-register a victim's address and inherit their grants at first login.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_provider ON users (auth_provider, provider_subject)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email))`,

  // id = sha256(cookie secret): a read-only dump of this table yields no usable credential.
  `CREATE TABLE IF NOT EXISTS sessions (
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
   )`,
  // NOT indexed on (id, ...): id is the primary key, so the planner would never pick a partial
  // index over the PK for the auth hot path. What actually needs an index is the expiry sweep.
  `DROP INDEX IF EXISTS idx_sessions_active`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at) WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_sid ON sessions (oidc_sid) WHERE oidc_sid IS NOT NULL`,

  // Short-lived OIDC handshake state. Lives in the DB (not a signed blob) so `consumed_at` can be
  // flipped atomically — that is what makes an authorization-code replay impossible across replicas.
  `CREATE TABLE IF NOT EXISTS oidc_flows (
     flow_id     TEXT PRIMARY KEY,
     verifier    TEXT NOT NULL,
     nonce       TEXT NOT NULL,
     return_to   TEXT NOT NULL,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     consumed_at BIGINT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oidc_flows_expiry ON oidc_flows (expires_at)`,

  // Agent identity: long-lived publish tokens (hash-only, like sessions) plus the short-lived
  // device-authorization grants that mint them.
  `CREATE TABLE IF NOT EXISTS publish_tokens (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name         TEXT NOT NULL,
     created_at   BIGINT NOT NULL,
     last_used_at BIGINT,
     revoked_at   BIGINT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_publish_tokens_user ON publish_tokens (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS device_grants (
     device_code TEXT PRIMARY KEY,
     user_code   TEXT NOT NULL UNIQUE,
     status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','consumed')),
     user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     consumed_at BIGINT
   )`,

  // Chunked-upload sessions. **Must live in the database, not in process memory**: production runs
  // multiple replicas, the request that opens a session lands on replica A, the next PUT is balanced
  // to replica B, and B's memory has never heard of it — so "upload session does not exist" shows up
  // intermittently depending on where a request lands, the hardest class of failure to diagnose.
  // files is stored as JSON: the frontend uploads serially, whole-value replacement is enough, and a
  // separate table is not worth it.
  `CREATE TABLE IF NOT EXISTS upload_sessions (
     version_id  TEXT PRIMARY KEY,
     site_id     TEXT NOT NULL,
     target_slug TEXT,
     title       TEXT,
     owner_key   TEXT NOT NULL,
     files       TEXT NOT NULL DEFAULT '[]',
     created_at  BIGINT NOT NULL
   )`,

  // --- site ownership + sharing ------------------------------------------------
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'`,
  // Defaults to the most restrictive tier. An anonymously-created site therefore starts read-only
  // to everyone until its creator signs in and claims it — a safe resting state, not a bug.
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS edit_policy TEXT NOT NULL DEFAULT 'owner'`,
  // Claim receipt for anonymous creation: minted at upload, stored only in the creator's browser,
  // redeemed on first sign-in. Never rendered into a link, which is what makes it usable as
  // ownership proof (the older edit_token was broadcast by design, so it could not be).
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS claim_token TEXT`,
  // Anonymous owner: a random id held in a browser cookie. Deliberately NOT the client IP -- behind
  // a gateway every visitor shares one address, so an IP-keyed identity would let colleagues edit
  // each other's sites (and would evaporate on a network change). On sign-in every row carrying the
  // browser's id is migrated to the real account in one statement.
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS anon_owner_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_sites_anon_owner ON sites (anon_owner_id) WHERE anon_owner_id IS NOT NULL AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites (owner_id, updated_at DESC) WHERE deleted_at IS NULL`,

  // Version authorship is the one fact that cannot be backfilled later — add it now even though
  // nothing reads it until the identity routes land.
  `ALTER TABLE versions ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id) ON DELETE SET NULL`,

  `CREATE TABLE IF NOT EXISTS site_collaborators (
     site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
     granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
     granted_at BIGINT NOT NULL,
     PRIMARY KEY (site_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_collab_user ON site_collaborators (user_id, granted_at DESC)`,

  // `id` is itself the invite credential (high entropy) — the email is display-only, so an
  // unverified or attacker-registered address can never redeem someone else's invite.
  `CREATE TABLE IF NOT EXISTS site_invites (
     id          TEXT PRIMARY KEY,
     site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     email       TEXT NOT NULL,
     role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
     invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_at  BIGINT NOT NULL,
     expires_at  BIGINT NOT NULL,
     accepted_at BIGINT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_site_invites_email ON site_invites (site_id, lower(email))`,

  // --- share links -------------------------------------------------------------
  // A share is an object, not a column on sites: one artifact can carry several links with
  // different audiences, a link can be revoked without touching the site, and a view can be
  // attributed to the link it arrived through. Distinct from site_invites, which grants EDIT on a
  // whole site — this grants READ on one link, and the two lists differ per link.
  //
  // Only token_hash is stored. The token itself lives in the URL the owner hands out, so a
  // read-only dump of this table cannot reconstruct a working link (same shape as sessions).
  `CREATE TABLE IF NOT EXISTS site_shares (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_site ON site_shares (site_id, created_at DESC)`,
  // Q&A-mode flag — appended per this array's convention so existing deployments get it too.
  `ALTER TABLE site_shares ADD COLUMN IF NOT EXISTS allow_ai BOOLEAN NOT NULL DEFAULT false`,

  // Exactly one of user_id / email per row. `email` is for someone who has never signed in here:
  // it is matched against their VERIFIED address at sign-in, never trusted as an identity on its
  // own. Two unique indexes rather than one composite key because SQL cannot express "unique on
  // whichever column is non-null" directly.
  `CREATE TABLE IF NOT EXISTS share_grants (
     share_id   TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
     user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
     email      TEXT,
     granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
     granted_at BIGINT NOT NULL,
     CHECK ((user_id IS NULL) <> (email IS NULL))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_user ON share_grants (share_id, user_id) WHERE user_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_share_grants_email ON share_grants (share_id, lower(email)) WHERE email IS NOT NULL`,

  // Views are far higher volume than audit_log (which records writes), so they get their own table
  // — mixing them would drown the audit trail. site_id is denormalised so "who read this artifact"
  // does not need a join across every share. Retention is enforced by pruneShareViews.
  `CREATE TABLE IF NOT EXISTS share_views (
     share_id   TEXT NOT NULL REFERENCES site_shares(id) ON DELETE CASCADE,
     site_id    TEXT NOT NULL,
     user_id    TEXT,
     anon_id    TEXT,
     ip         TEXT,
     user_agent TEXT,
     viewed_at  BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_share_views_site ON share_views (site_id, viewed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_share_views_prune ON share_views (viewed_at)`,

  // Direct openings of /s/<slug> — the counterpart of share_views for readers who never touched a
  // share link. Its own table rather than a nullable share_id on share_views: that column is
  // NOT NULL with an FK, so widening it would rewrite an existing high-volume table and blur what
  // share_views is (the access log of a credential). The two are only ever read together, via
  // listSiteOpens/getSiteViewStats. site_id carries no FK for the same reason share_views' doesn't.
  `CREATE TABLE IF NOT EXISTS site_views (
     site_id    TEXT NOT NULL,
     user_id    TEXT,
     anon_id    TEXT,
     ip         TEXT,
     user_agent TEXT,
     viewed_at  BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_site_views_site ON site_views (site_id, viewed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_site_views_prune ON site_views (viewed_at)`,

  // --- server-side build of dropped source projects ---------------------------
  // One row per build attempt. `source_key` names a tree under the build-source namespace in
  // storage, NOT a versions row: a version is publicly readable (the version list API is
  // unauthenticated and preview honours any ?v= of the site), so recording source there would
  // publish the uploader's code to anyone holding the slug.
  //
  // `expected_version_id` is the site's current version when the job was queued. The worker
  // commits only if it still matches, so an edit made while the build ran is not silently
  // overwritten — the build lands as `superseded` instead and the user chooses.
  `CREATE TABLE IF NOT EXISTS builds (
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
   )`,
  // The claim query: oldest queued job whose lease (if any) has lapsed.
  `CREATE INDEX IF NOT EXISTS idx_builds_claimable ON builds (status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_builds_site ON builds (site_id, created_at DESC)`,

  // Append-only audit trail. No FK to sites/users on purpose: it must outlive both so a deleted
  // user or purged site cannot erase who did what. Insert-only — never updated — so "it was
  // anonymous at the time" stays true after a later claim (unlike versions.created_by, which claim
  // backfills). This is the only place attribution is authoritative.
  `CREATE TABLE IF NOT EXISTS audit_log (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log (site_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id, created_at DESC)`,

  // Insert counter for audit_log, mirroring versions.seq — it exists ONLY to break created_at ties.
  // created_at is a millisecond app clock, and a create+edit+rollback burst routinely lands several
  // rows in the SAME millisecond, so `ORDER BY created_at DESC` alone leaves their relative order to
  // the planner: unstable between two runs of the same query, and different from what SQLite
  // returns. `id` cannot fix that — it is `aud_<randomUUID>`, so `id DESC` is a *stable* order but
  // an arbitrary one, and it would actively destroy the true edit sequence the SQLite side already
  // gets from its implicit rowid. seq is the Postgres counterpart of that rowid: monotonic per
  // insert, so both backends tiebreak on real insert order and agree row for row.
  // Appended as an ALTER (not folded into the CREATE above) per this array's convention, so an
  // existing deployment gets the column too; on such a deployment BIGSERIAL rewrites the table
  // under an ACCESS EXCLUSIVE lock and numbers the existing rows in physical order — which for an
  // insert-only table is their insert order.
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,

  // Account-level folders for "My sites" (issue #35). Owner-perspective: the shelf belongs to the
  // user, not to the site, so `sites` is untouched and two people can file the same site differently.
  `CREATE TABLE IF NOT EXISTS folders (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name       TEXT NOT NULL,
     sort       INTEGER NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id, sort, created_at)`,
  `CREATE TABLE IF NOT EXISTS folder_assignments (
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (user_id, site_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_folder_assignments_folder ON folder_assignments (folder_id)`,
  // --- administration -----------------------------------------------------------
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT`,
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS taken_down_at BIGINT`,
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS taken_down_reason TEXT`,
  // Deleted sites keep their files for a retention window (restorable); purged_at records the
  // moment the files were actually removed, after which the row is a pure tombstone.
  `ALTER TABLE sites ADD COLUMN IF NOT EXISTS purged_at BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_sites_deleted_unpurged ON sites (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL`,
  // Administrative acts. Not folded into audit_log, whose rows are keyed by site: disabling an
  // account or running maintenance has no site to hang on.
  `CREATE TABLE IF NOT EXISTS admin_log (
     id            TEXT PRIMARY KEY,
     actor_kind    TEXT NOT NULL,
     actor_user_id TEXT,
     action        TEXT NOT NULL,
     target_kind   TEXT NOT NULL,
     target_id     TEXT NOT NULL,
     reason        TEXT,
     ip            TEXT,
     created_at    BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_log_created ON admin_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_log_target ON admin_log (target_id, created_at DESC)`,
  // Console-set policy. `scope` is 'global' today and is the seat reserved for tenants: a tenant
  // row of the same key will override the global one once tenants exist (see lib/settings).
  `CREATE TABLE IF NOT EXISTS settings (
     scope      TEXT NOT NULL,
     key        TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at BIGINT NOT NULL,
     updated_by TEXT,
     PRIMARY KEY (scope, key)
   )`,
  // The searchable text of each site's current version (lib/site-text). `tokens` is built from
  // the pre-tokenised strings the app hands over — the 'simple' configuration only lowercases,
  // and every token is ASCII by construction, so no locale or dictionary is involved.
  `CREATE TABLE IF NOT EXISTS site_texts (
     site_id      TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
     version_id   TEXT NOT NULL,
     title        TEXT NOT NULL,
     body         TEXT NOT NULL,
     chars        INTEGER NOT NULL,
     tokens       TSVECTOR NOT NULL,
     extracted_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_site_texts_tokens ON site_texts USING GIN (tokens)`,
  `ALTER TABLE site_texts ADD COLUMN IF NOT EXISTS extractor_version INTEGER NOT NULL DEFAULT 0`,
];
/**
 * Exactly one of userId / email, as share_grants' CHECK constraint demands. Validated here rather
 * than left to the database because the two drivers do NOT fail alike: Postgres raises a CHECK
 * violation, while SQLite's `INSERT OR IGNORE` treats a violated CHECK as just another row to skip
 * and returns success. A bad target must be the same loud error on both backends.
 *
 * Falsy-to-null (not `?? null`): an empty string is not an identity, and letting `""` through would
 * put a row in share_grants that no lookup can ever match.
 *
 * Twin of the identical function in db-sqlite.ts — the two must be changed together.
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
 * twin in db-sqlite.ts.
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

export class PostgresStore implements MetadataStore {
  private pool!: pg.Pool;

  async init(): Promise<void> {
    if (!config.databaseUrl) throw new Error("postgres driver needs ARTIFACT_DATABASE_URL");
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Transaction-scoped lock: auto-released on COMMIT/ROLLBACK, so a failed migration can never
      // wedge other replicas' startup (a session-level pg_advisory_lock would leak on a DDL error).
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      await client.query(`
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
      `);
      for (const migration of MIGRATIONS) await client.query(migration);
      // Backfill edit tokens for any legacy rows (e.g. data imported from a SQLite dump). No-op on a
      // fresh DB. Done inside the lock so concurrent replicas can't double-mint.
      const legacy = await client.query("SELECT id FROM sites WHERE edit_token IS NULL OR edit_token = ''");
      for (const row of legacy.rows as Row[]) {
        await client.query("UPDATE sites SET edit_token=$1 WHERE id=$2", [createEditToken(), row.id as string]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async one(sql: string, params: unknown[]): Promise<Row | null> {
    const { rows } = await this.pool.query(sql, params);
    return (rows[0] as Row | undefined) ?? null;
  }

  /** One audit INSERT on the given client at `now` — so it commits with the version it describes. */
  private async writeAuditRow(client: pg.PoolClient, a: InsertAuditInput, now: number): Promise<void> {
    await client.query(
      "INSERT INTO audit_log (id, site_id, version_id, action, editor_kind, actor_user_id, actor_anon_id, method, ip, user_agent, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [a.id, a.siteId, a.versionId, a.action, a.editorKind, a.actorUserId, a.actorAnonId, a.method, a.ip, a.userAgent, now],
    );
  }

  async insertSite(input: InsertSiteInput): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      "INSERT INTO sites (id, slug, title, kind, current_version_id, created_at, updated_at, deleted_at, edit_token, claim_token, anon_owner_id, visibility) VALUES ($1,$2,$3,$4,NULL,$5,$5,NULL,$6,$7,$8,$9)",
      [input.id, input.slug, input.title, input.kind, now, input.editToken, input.claimToken ?? null, input.anonOwnerId ?? null, input.visibility],
    );
  }

  async insertSiteWithVersion(site: InsertSiteInput, version: InsertVersionInput, audit?: InsertAuditInput): Promise<void> {
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO sites (id, slug, title, kind, current_version_id, created_at, updated_at, deleted_at, edit_token, claim_token, anon_owner_id, owner_id, visibility) VALUES ($1,$2,$3,$4,$5,$6,$6,NULL,$7,$8,$9,$10,$11)",
        [site.id, site.slug, site.title, site.kind, version.id, now, site.editToken, site.claimToken ?? null, site.anonOwnerId ?? null, site.ownerId ?? null, site.visibility],
      );
      await client.query(
        "INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now],
      );
      if (audit) await this.writeAuditRow(client, audit, now);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Only the slug UNIQUE constraint is retryable; a PK conflict (astronomically unlikely with
      // UUID ids) must surface as itself, not be mistaken for a slug collision and retried uselessly.
      const e = error as { code?: string; constraint?: string };
      if (e?.code === "23505" && e.constraint === "sites_slug_key") throw new SlugConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  async addVersionAsCurrent(siteId: string, version: InsertVersionInput, audit?: InsertAuditInput): Promise<boolean> {
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE row-locks the site so this metadata transaction is serialized against a
      // concurrent deleteSite. It serializes the METADATA only — file writes happen outside the lock,
      // so an edit racing a delete can still leave version files with no live owner; those transient
      // orphans are expected and swept by reconcileOrphans.
      const { rows } = await client.query("SELECT deleted_at FROM sites WHERE id=$1 FOR UPDATE", [siteId]);
      if (rows.length === 0 || rows[0].deleted_at != null) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now],
      );
      await client.query("UPDATE sites SET current_version_id=$1, updated_at=$2 WHERE id=$3", [version.id, now, siteId]);
      if (audit) await this.writeAuditRow(client, audit, now);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async addVersionAsCurrentIfCurrentIs(
    siteId: string,
    expectedCurrentVersionId: string,
    version: InsertVersionInput,
    audit?: InsertAuditInput,
  ): Promise<VersionCommit> {
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same FOR UPDATE row lock as addVersionAsCurrent, reading current_version_id under it so the
      // compare and the set cannot straddle another writer's commit.
      const { rows } = await client.query(
        "SELECT deleted_at, current_version_id FROM sites WHERE id=$1 FOR UPDATE",
        [siteId],
      );
      if (rows.length === 0 || rows[0].deleted_at != null) {
        await client.query("ROLLBACK");
        return "gone";
      }
      if ((rows[0].current_version_id ?? "") !== expectedCurrentVersionId) {
        await client.query("ROLLBACK");
        return "stale";
      }
      await client.query(
        "INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [version.id, version.siteId, version.entry, version.fileCount, version.byteSize, version.source, now],
      );
      await client.query("UPDATE sites SET current_version_id=$1, updated_at=$2 WHERE id=$3", [version.id, now, siteId]);
      if (audit) await this.writeAuditRow(client, audit, now);
      await client.query("COMMIT");
      return "applied";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async insertAudit(input: InsertAuditInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.writeAuditRow(client, input, Date.now());
    } finally {
      client.release();
    }
  }

  async listAudit(siteId: string, limit = 200): Promise<AuditEntry[]> {
    // seq DESC is the tiebreaker, not the sort: created_at stays leading so idx_audit_site
    // (site_id, created_at DESC) still drives the scan and the LIMIT still stops early (Postgres
    // reads the index in order and only re-sorts within each created_at group — an incremental
    // sort). MUST stay byte-for-byte equivalent to the SQLite backend's rowid tiebreak; see the
    // seq migration above and the parity test in test/audit.test.ts.
    const { rows } = await this.pool.query(
      "SELECT * FROM audit_log WHERE site_id=$1 ORDER BY created_at DESC, seq DESC LIMIT $2",
      [siteId, limit],
    );
    return (rows as Row[]).map(toAudit);
  }

  async getSiteBySlug(slug: string): Promise<Site | null> {
    const row = await this.one("SELECT * FROM sites WHERE slug=$1", [slug]);
    return row ? toSite(row) : null;
  }

  async getSite(id: string): Promise<Site | null> {
    const row = await this.one("SELECT * FROM sites WHERE id=$1", [id]);
    return row ? toSite(row) : null;
  }

  async setCurrentVersion(siteId: string, versionId: string): Promise<void> {
    // deleted_at guard: a mutation racing a concurrent delete must not resurrect a deleted site's pointer.
    await this.pool.query("UPDATE sites SET current_version_id=$1, updated_at=$2 WHERE id=$3 AND deleted_at IS NULL", [versionId, Date.now(), siteId]);
  }

  async updateSiteTitle(id: string, title: string): Promise<void> {
    await this.pool.query("UPDATE sites SET title=$1, updated_at=$2 WHERE id=$3", [title, Date.now(), id]);
  }

  async setEditToken(id: string, token: string): Promise<void> {
    await this.pool.query("UPDATE sites SET edit_token=$1 WHERE id=$2", [token, id]);
  }

  async softDeleteSite(id: string): Promise<void> {
    const now = Date.now();
    await this.pool.query("UPDATE sites SET deleted_at=$1, updated_at=$1 WHERE id=$2 AND deleted_at IS NULL", [now, id]);
  }

  async listSiteSummaries(viewer?: ListViewer): Promise<SiteSummary[]> {
    // COALESCE, not a bare `= 'public'`: the column arrived by migration and a restored dump that
    // predates it (or was taken while it was still nullable) would otherwise read as "not public"
    // and silently empty the directory. The default is spelled the same way in toSummary().
    // The OR arms are the "it's mine" escape hatch; `owner_id IS NULL` on the anon arm mirrors
    // resolveCapability — once an account claims a site, the creating browser is no longer it.
    //
    // The collaborator arm is not cosmetic. This list is also what the home page treats as the set
    // of sites that still EXIST (pruneRecent / pruneAssignments drop anything missing from it), so
    // a collaborator who is excluded here silently loses their recent-shelf entry and folder
    // assignment for a site they can still open and edit. Their "My sites" tab is unaffected — it
    // comes from listSitesForCollaborator — which is exactly what makes the loss confusing.
    const { rows } = await this.pool.query(`
      SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s
      LEFT JOIN versions v ON v.id = s.current_version_id
      WHERE s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
        AND ((COALESCE(s.visibility, 'public') = 'public' AND s.taken_down_at IS NULL)
             OR s.owner_id = $1
             OR (s.owner_id IS NULL AND s.anon_owner_id = $2)
             OR EXISTS (SELECT 1 FROM site_collaborators c
                         WHERE c.site_id = s.id AND c.user_id = $1))
      ORDER BY s.updated_at DESC
    `, [viewer?.userId ?? null, viewer?.anonId ?? null]);
    return (rows as Row[]).map(toSummary);
  }

  async countVersions(siteId: string): Promise<number> {
    const row = await this.one("SELECT COUNT(*) AS n FROM versions WHERE site_id=$1", [siteId]);
    return Number(row?.n ?? 0);
  }

  async insertVersion(input: InsertVersionInput): Promise<void> {
    await this.pool.query(
      "INSERT INTO versions (id, site_id, entry, file_count, byte_size, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [input.id, input.siteId, input.entry, input.fileCount, input.byteSize, input.source, Date.now()],
    );
  }

  async getVersion(id: string): Promise<Version | null> {
    const row = await this.one("SELECT * FROM versions WHERE id=$1", [id]);
    return row ? toVersion(row) : null;
  }

  async listVersions(siteId: string): Promise<Version[]> {
    // seq (BIGSERIAL) is the authoritative insert order — immune to app-clock skew across replicas.
    const { rows } = await this.pool.query("SELECT * FROM versions WHERE site_id=$1 ORDER BY seq DESC", [siteId]);
    return (rows as Row[]).map(toVersion);
  }

  async backfillEditTokens(): Promise<number> {
    const { rows } = await this.pool.query("SELECT id FROM sites WHERE edit_token IS NULL OR edit_token = ''");
    for (const row of rows as Row[]) {
      await this.pool.query("UPDATE sites SET edit_token=$1 WHERE id=$2", [createEditToken(), row.id as string]);
    }
    return rows.length;
  }

  async upsertUser(input: UpsertUserInput): Promise<User> {
    const now = Date.now();
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, auth_provider, provider_subject, email, email_verified, display_name, avatar_url, created_at, updated_at, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
       ON CONFLICT (auth_provider, provider_subject) DO UPDATE
         SET email=EXCLUDED.email, email_verified=EXCLUDED.email_verified,
             display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url,
             updated_at=EXCLUDED.updated_at, last_login_at=EXCLUDED.last_login_at
       RETURNING *`,
      [createId("usr"), input.authProvider, input.providerSubject, input.email ?? null,
       input.emailVerified ?? false, input.displayName ?? null, input.avatarUrl ?? null, now],
    );
    return toUser(rows[0] as Row);
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.one("SELECT * FROM users WHERE id=$1", [id]);
    return row ? toUser(row) : null;
  }

  async getUserByVerifiedEmail(email: string): Promise<User | null> {
    const row = await this.one("SELECT * FROM users WHERE lower(email)=lower($1) AND email_verified = true", [email]);
    return row ? toUser(row) : null;
  }

  async searchUsers(q: string, limit: number): Promise<User[]> {
    // Same escaping + same ordering as the SQLite side, deliberately: `%`/`_` are LIKE wildcards,
    // so an unescaped query stops being a prefix search and a lone `%` returns everyone. COALESCE
    // rather than `NULLS LAST` because SQLite has no such clause and the two must agree on which
    // never-logged-in account sorts where.
    const pattern = `${q.replace(/[\\%_]/g, "\\$&")}%`;
    const { rows } = await this.pool.query(
      `SELECT * FROM users
        WHERE lower(display_name) LIKE lower($1) ESCAPE '\\'
           OR (email_verified = true AND lower(email) LIKE lower($1) ESCAPE '\\')
        ORDER BY COALESCE(last_login_at, 0) DESC, id
        LIMIT $2`,
      [pattern, limit],
    );
    return (rows as Row[]).map(toUser);
  }

  async addCollaborator(siteId: string, userId: string, grantedBy: string | null): Promise<void> {
    await this.pool.query(
      "INSERT INTO site_collaborators (site_id, user_id, role, granted_by, granted_at) VALUES ($1,$2,'editor',$3,$4) ON CONFLICT (site_id, user_id) DO NOTHING",
      [siteId, userId, grantedBy, Date.now()],
    );
  }

  async removeCollaborator(siteId: string, userId: string): Promise<void> {
    await this.pool.query("DELETE FROM site_collaborators WHERE site_id=$1 AND user_id=$2", [siteId, userId]);
  }

  async updateSiteSharing(siteId: string, visibility: Visibility, editPolicy: EditPolicy): Promise<void> {
    await this.pool.query("UPDATE sites SET visibility=$1, edit_policy=$2, updated_at=$3 WHERE id=$4 AND deleted_at IS NULL",
      [visibility, editPolicy, Date.now(), siteId]);
  }

  async listCollaborators(siteId: string): Promise<SiteCollaborator[]> {
    const { rows } = await this.pool.query("SELECT * FROM site_collaborators WHERE site_id=$1 ORDER BY granted_at", [siteId]);
    return (rows as Row[]).map(toCollaborator);
  }

  // --- share links -------------------------------------------------------------
  // Every statement below is written to match db-sqlite.ts predicate for predicate, ORDER BY for
  // ORDER BY. listLiveShares and shareAdmits are the read gate: a divergence between the two
  // backends is not a cosmetic drift, it is someone reading an artifact they were never admitted to
  // — and only in production, since the suite runs on SQLite.

  async createShare(input: InsertShareInput): Promise<Share> {
    const { rows } = await this.pool.query(
      `INSERT INTO site_shares (id, site_id, token_hash, policy, passcode_hash, label, created_by, created_anon, created_at, expires_at, revoked_at, allow_ai)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11) RETURNING *`,
      [input.id, input.siteId, input.tokenHash, input.policy, input.passcodeHash ?? null, input.label ?? null,
       input.createdBy ?? null, input.createdAnonId ?? null, Date.now(), input.expiresAt ?? null, input.allowAi ?? false],
    );
    // toShare, never toShareRow: the two hashes must not leave the storage layer.
    return toShare(rows[0] as Row);
  }

  async getShareByTokenHash(tokenHash: string): Promise<ShareRow | null> {
    const row = await this.one("SELECT * FROM site_shares WHERE token_hash=$1", [tokenHash]);
    return row ? toShareRow(row) : null;
  }

  async getShare(id: string): Promise<ShareRow | null> {
    const row = await this.one("SELECT * FROM site_shares WHERE id=$1", [id]);
    return row ? toShareRow(row) : null;
  }

  async listShares(siteId: string): Promise<Share[]> {
    // Unfiltered on purpose — every link the site ever minted, revoked and expired included. This is
    // the owner's management list, which has to be able to say "that link is dead"; the gate's
    // filtered view is listLiveShares.
    //
    // `id DESC` is the tiebreaker. created_at is a millisecond app clock, so two links minted in one
    // burst share it and `created_at DESC` alone leaves their order to the planner — unstable within
    // a backend and different BETWEEN the two. site_shares has no seq column and SQLite's rowid has
    // no Postgres counterpart, so the id is the only key both sides can agree on: stable, and
    // arbitrary only among rows that were already tied.
    const { rows } = await this.pool.query(
      "SELECT * FROM site_shares WHERE site_id=$1 ORDER BY created_at DESC, id DESC", [siteId]);
    return (rows as Row[]).map(toShare);
  }

  async revokeShare(id: string, at: number): Promise<void> {
    // `AND revoked_at IS NULL` keeps the FIRST revocation's timestamp: revoking twice is a no-op,
    // not a rewrite of when the link actually died.
    await this.pool.query("UPDATE site_shares SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL", [at, id]);
  }

  async updateSharePolicy(id: string, policy: SharePolicy, passcodeHash: string | null, expiresAt: number | null): Promise<void> {
    // A full assignment of all three columns: null CLEARS the passcode / the expiry, which is what
    // "switch this link back to Signed-in users, no expiry" has to mean.
    await this.pool.query("UPDATE site_shares SET policy=$1, passcode_hash=$2, expires_at=$3 WHERE id=$4",
      [policy, passcodeHash, expiresAt, id]);
  }

  async setShareAllowAi(id: string, allowAi: boolean): Promise<void> {
    await this.pool.query("UPDATE site_shares SET allow_ai=$1 WHERE id=$2", [allowAi, id]);
  }

  async listLiveShares(siteId: string, now: number): Promise<ShareRow[]> {
    // The read gate's input. `expires_at > now` is strict: a link whose expiry is exactly now has
    // expired. A NULL expiry never expires — hence the explicit IS NULL arm, since `NULL > now` is
    // NULL and would drop those rows.
    const { rows } = await this.pool.query(
      `SELECT * FROM site_shares
        WHERE site_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY created_at DESC, id DESC`, [siteId, now]);
    return (rows as Row[]).map(toShareRow);
  }

  async addShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }, grantedBy: string | null): Promise<void> {
    const { userId, email } = shareGrantTarget(target);
    const now = Date.now();
    if (userId != null) {
      // The arbiter is a PARTIAL unique index, so its WHERE predicate has to be repeated here —
      // without it Postgres cannot infer the index and raises "no unique or exclusion constraint
      // matching the ON CONFLICT specification". Same for the email index below, whose key is the
      // EXPRESSION lower(email).
      await this.pool.query(
        `INSERT INTO share_grants (share_id, user_id, email, granted_by, granted_at) VALUES ($1,$2,NULL,$3,$4)
         ON CONFLICT (share_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`,
        [shareId, userId, grantedBy, now]);
      return;
    }
    // Stored as typed, matched case-insensitively: the display value is the owner's, the key is
    // lower(email).
    await this.pool.query(
      `INSERT INTO share_grants (share_id, user_id, email, granted_by, granted_at) VALUES ($1,NULL,$2,$3,$4)
       ON CONFLICT (share_id, lower(email)) WHERE email IS NOT NULL DO NOTHING`,
      [shareId, email, grantedBy, now]);
  }

  async removeShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }): Promise<void> {
    const { userId, email } = shareGrantTarget(target);
    if (userId != null) {
      await this.pool.query("DELETE FROM share_grants WHERE share_id=$1 AND user_id=$2", [shareId, userId]);
      return;
    }
    // lower() on both sides — the same key addShareGrant collapsed the row onto, so removing 'A@b.c'
    // removes the row stored as 'a@B.C'.
    await this.pool.query("DELETE FROM share_grants WHERE share_id=$1 AND lower(email)=lower($2)", [shareId, email]);
  }

  async listShareGrants(shareId: string): Promise<ShareGrant[]> {
    // LEFT JOIN, not JOIN: an e-mail grant has no user row yet (that is the whole point of e-mail
    // grants), and an inner join would silently drop exactly those entries from the owner's list.
    // Its display_name comes back NULL, which is the contract for that arm.
    //
    // COALESCE in the tiebreaker rather than a bare nullable column: Postgres sorts NULLs LAST by
    // default and SQLite sorts them FIRST, so ordering on user_id/email directly is precisely the
    // kind of drift this pair must not have. The CHECK constraint makes the COALESCE total.
    const { rows } = await this.pool.query(
      `SELECT g.share_id, g.user_id, g.email, g.granted_at, u.display_name
         FROM share_grants g LEFT JOIN users u ON u.id = g.user_id
        WHERE g.share_id=$1
        ORDER BY g.granted_at, COALESCE(g.user_id, g.email)`, [shareId]);
    return (rows as Row[]).map(toShareGrantRow);
  }

  async shareAdmits(shareId: string, userId: string, verifiedEmail: string | null): Promise<boolean> {
    // `|| null` so an empty string cannot stand in for a verified address.
    const email = verifiedEmail || null;
    // Two arms, and the e-mail arm is explicitly gated on the PARAMETER being non-null. SQL's own
    // NULL semantics would already refuse to match (`lower(email) = lower(NULL)` is NULL, not true),
    // but this is the one predicate in the file where "no verified address admits nobody" must be
    // legible rather than inferred — a later edit that reaches for COALESCE would otherwise turn
    // every e-mail grant into a wildcard.
    // An e-mail row can never be admitted by the account arm either: its user_id is NULL, and
    // `NULL = $2` is NULL.
    const row = await this.one(
      `SELECT 1 AS ok FROM share_grants
        WHERE share_id=$1
          AND (user_id = $2 OR ($3::text IS NOT NULL AND email IS NOT NULL AND lower(email) = lower($3)))
        LIMIT 1`,
      [shareId, userId, email]);
    return row != null;
  }

  async recordShareView(view: ShareView): Promise<void> {
    await this.pool.query(
      "INSERT INTO share_views (share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [view.shareId, view.siteId, view.userId, view.anonId, view.ip, view.userAgent, view.viewedAt]);
  }

  async hasRecentShareView(shareId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean> {
    // Identity is a strict ladder, not a union: an account is matched by account only, a signed-out
    // browser by its anon id only, and only a reader with neither falls back to the IP. Widening any
    // arm to an OR would collapse everyone behind one office gateway into a single "view".
    const u = userId || null;
    const a = anonId || null;
    const i = ip || null;
    // A reader with no identity at all matches nothing: `ip = NULL` is NULL, so the last arm simply
    // fails rather than folding every anonymous hit together.
    const row = await this.one(
      `SELECT 1 AS ok FROM share_views
        WHERE share_id=$1 AND viewed_at >= $5
          AND ( ($2::text IS NOT NULL AND user_id = $2)
             OR ($2::text IS NULL AND $3::text IS NOT NULL AND anon_id = $3)
             OR ($2::text IS NULL AND $3::text IS NULL AND ip = $4) )
        LIMIT 1`,
      [shareId, u, a, i, since]);
    return row != null;
  }

  async listShareViews(siteId: string, limit: number): Promise<ShareView[]> {
    // Newest first. No tiebreaker: share_views has neither a seq column nor anything SQLite's rowid
    // maps onto, so same-millisecond views have no order both backends could agree on — better an
    // honestly unspecified tie than two backends confidently disagreeing.
    const { rows } = await this.pool.query(
      "SELECT * FROM share_views WHERE site_id=$1 ORDER BY viewed_at DESC LIMIT $2", [siteId, limit]);
    return (rows as Row[]).map(toShareView);
  }

  async pruneShareViews(before: number): Promise<number> {
    // Strictly `<`: a row landing exactly on the retention boundary is kept.
    const res = await this.pool.query("DELETE FROM share_views WHERE viewed_at < $1", [before]);
    return res.rowCount ?? 0;
  }

  async recordSiteView(view: SiteView): Promise<void> {
    await this.pool.query(
      "INSERT INTO site_views (site_id, user_id, anon_id, ip, user_agent, viewed_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [view.siteId, view.userId, view.anonId, view.ip, view.userAgent, view.viewedAt]);
  }

  async hasRecentSiteView(siteId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean> {
    // Same strict identity ladder as hasRecentShareView — account, else browser, else IP; a reader
    // with none of the three matches nothing (`ip = NULL` is NULL).
    const u = userId || null;
    const a = anonId || null;
    const i = ip || null;
    const row = await this.one(
      `SELECT 1 AS ok FROM site_views
        WHERE site_id=$1 AND viewed_at >= $5
          AND ( ($2::text IS NOT NULL AND user_id = $2)
             OR ($2::text IS NULL AND $3::text IS NOT NULL AND anon_id = $3)
             OR ($2::text IS NULL AND $3::text IS NULL AND ip = $4) )
        LIMIT 1`,
      [siteId, u, a, i, since]);
    return row != null;
  }

  async listSiteOpens(siteId: string, limit: number): Promise<SiteOpen[]> {
    // One list, both doors. Newest first, same no-tiebreaker stance as listShareViews.
    const { rows } = await this.pool.query(
      `SELECT share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at FROM share_views WHERE site_id=$1
       UNION ALL
       SELECT NULL AS share_id, site_id, user_id, anon_id, ip, user_agent, viewed_at FROM site_views WHERE site_id=$1
       ORDER BY viewed_at DESC LIMIT $2`,
      [siteId, limit]);
    return (rows as Row[]).map(toSiteOpen);
  }

  async getSiteViewStats(siteId: string, since: number, exclude: { userIds: readonly string[]; anonIds: readonly string[] }): Promise<SiteViewStats> {
    // `user_id <> ALL($2)` alone would be NULL for anonymous rows and filter them out — the
    // IS NULL arms keep them. An empty array is fine: `x <> ALL('{}')` is TRUE.
    const row = await this.one(
      `WITH opens AS (
         SELECT user_id, anon_id, ip, viewed_at FROM share_views
          WHERE site_id=$1 AND (user_id IS NULL OR user_id <> ALL($2::text[]))
            AND (anon_id IS NULL OR anon_id <> ALL($3::text[]))
         UNION ALL
         SELECT user_id, anon_id, ip, viewed_at FROM site_views
          WHERE site_id=$1 AND (user_id IS NULL OR user_id <> ALL($2::text[]))
            AND (anon_id IS NULL OR anon_id <> ALL($3::text[]))
       )
       SELECT
         (SELECT COUNT(*) FROM opens WHERE viewed_at >= $4)                                     AS opens,
         (SELECT COUNT(DISTINCT COALESCE(user_id, anon_id, ip)) FROM opens WHERE viewed_at >= $4) AS uniq,
         (SELECT MAX(viewed_at) FROM opens)                                                     AS last`,
      [siteId, [...exclude.userIds], [...exclude.anonIds], since]);
    return {
      opens: Number(row?.opens ?? 0),
      uniqueViewers: Number(row?.uniq ?? 0),
      lastViewedAt: row?.last == null ? null : Number(row.last),
    };
  }

  async pruneSiteViews(before: number): Promise<number> {
    // Strictly `<`, mirroring pruneShareViews.
    const res = await this.pool.query("DELETE FROM site_views WHERE viewed_at < $1", [before]);
    return res.rowCount ?? 0;
  }

  async setSiteOwnerIfUnowned(siteId: string, ownerId: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE sites SET owner_id=$1, updated_at=$2 WHERE id=$3 AND owner_id IS NULL AND deleted_at IS NULL",
      [ownerId, Date.now(), siteId]);
    return (res.rowCount ?? 0) > 0;
  }

  async claimSiteAudited(siteId: string, ownerId: string, audit: InsertAuditInput, adminLog?: AdminLogEntry): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        "UPDATE sites SET owner_id=$1, updated_at=$2 WHERE id=$3 AND owner_id IS NULL AND deleted_at IS NULL",
        [ownerId, Date.now(), siteId]);
      if ((res.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await this.writeAuditRow(client, audit, Date.now());
      if (adminLog) {
        const e = adminLog;
        await client.query("INSERT INTO admin_log (id, actor_kind, actor_user_id, action, target_kind, target_id, reason, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [e.id, e.actorKind, e.actorUserId, e.action, e.targetKind, e.targetId, e.reason, e.ip, e.createdAt]);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async attributeUnattributedVersions(siteId: string, userId: string): Promise<number> {
    const res = await this.pool.query("UPDATE versions SET created_by=$1 WHERE site_id=$2 AND created_by IS NULL", [userId, siteId]);
    return res.rowCount ?? 0;
  }

  async adoptAnonymousSites(anonOwnerId: string, userId: string): Promise<number> {
    // Only rows still unowned: a site already claimed by an account is never pulled away from it.
    const res = await this.pool.query(
      "UPDATE sites SET owner_id=$1, anon_owner_id=NULL, updated_at=$2 WHERE anon_owner_id=$3 AND owner_id IS NULL AND deleted_at IS NULL",
      [userId, Date.now(), anonOwnerId],
    );
    return res.rowCount ?? 0;
  }

  async clearSiteOwner(siteId: string): Promise<void> {
  // Reset edit_policy alongside the owner. Leaving 'login' on an unowned site would keep it
  // writable by every authenticated user with nobody left who can change that back — the owner
  // was the only role permitted to touch sharing settings.
    await this.pool.query("UPDATE sites SET owner_id=NULL, edit_policy='owner', updated_at=$1 WHERE id=$2", [Date.now(), siteId]);
  }

  async transferSiteOwner(siteId: string, toUserId: string): Promise<void> {
    await this.pool.query("UPDATE sites SET owner_id=$1, updated_at=$2 WHERE id=$3 AND deleted_at IS NULL", [toUserId, Date.now(), siteId]);
  }

  async listSitesByOwner(ownerId: string): Promise<SiteSummary[]> {
    const { rows } = await this.pool.query(`SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id
      WHERE s.deleted_at IS NULL AND s.current_version_id IS NOT NULL AND s.owner_id = $1
      ORDER BY s.updated_at DESC`, [ownerId]);
    return (rows as Row[]).map(toSummary);
  }

  async listSitesForCollaborator(userId: string): Promise<SiteSummary[]> {
    const { rows } = await this.pool.query(`SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.created_at, s.updated_at,
             v.entry AS entry,
             (SELECT COUNT(*) FROM versions vc WHERE vc.site_id = s.id) AS version_count
      FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id
      JOIN site_collaborators c ON c.site_id = s.id AND c.user_id = $1
      WHERE s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
      ORDER BY s.updated_at DESC`, [userId]);
    return (rows as Row[]).map(toSummary);
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      "INSERT INTO sessions (id, user_id, oidc_sid, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$4,$7,$8)",
      [input.id, input.userId, input.oidcSid ?? null, now, input.expiresAt, input.absoluteExpiresAt, input.ip ?? null, input.userAgent ?? null],
    );
  }

  async getSession(id: string): Promise<Session | null> {
    const row = await this.one("SELECT * FROM sessions WHERE id=$1", [id]);
    return row ? toSession(row) : null;
  }

  async insertPublishToken(t: { id: string; userId: string; name: string; createdAt: number }): Promise<void> {
    await this.pool.query("INSERT INTO publish_tokens (id, user_id, name, created_at) VALUES ($1,$2,$3,$4)",
      [t.id, t.userId, t.name, t.createdAt]);
  }

  async getPublishToken(id: string): Promise<PublishToken | null> {
    const row = await this.one("SELECT * FROM publish_tokens WHERE id=$1", [id]);
    return row ? toPublishToken(row) : null;
  }

  async touchPublishToken(id: string, lastUsedAt: number): Promise<void> {
    await this.pool.query("UPDATE publish_tokens SET last_used_at=$1 WHERE id=$2 AND revoked_at IS NULL", [lastUsedAt, id]);
  }

  async listPublishTokens(userId: string): Promise<PublishToken[]> {
    const res = await this.pool.query("SELECT * FROM publish_tokens WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC", [userId]);
    return res.rows.map(toPublishToken);
  }

  async revokePublishToken(id: string, userId: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE publish_tokens SET revoked_at=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL",
      [Date.now(), id, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listFolders(userId: string): Promise<UserFolder[]> {
    const res = await this.pool.query("SELECT * FROM folders WHERE user_id=$1 ORDER BY sort ASC, created_at ASC", [userId]);
    return res.rows.map(toUserFolder);
  }

  async insertFolder(f: { id: string; userId: string; name: string; createdAt: number }, maxFolders: number): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO folders (id, user_id, name, sort, created_at, updated_at)
       SELECT $1, $2, $3, COALESCE(MAX(sort) + 1, 0), $4, $4 FROM folders WHERE user_id = $2
       HAVING COUNT(*) < $5`,
      [f.id, f.userId, f.name, f.createdAt, maxFolders]);
    return (res.rowCount ?? 0) > 0;
  }

  async renameFolder(id: string, userId: string, name: string, now: number): Promise<boolean> {
    const res = await this.pool.query("UPDATE folders SET name=$1, updated_at=$2 WHERE id=$3 AND user_id=$4", [name, now, id, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteFolder(id: string, userId: string): Promise<boolean> {
    // Assignments go with the folder (the FK cascades too; the explicit DELETE keeps SQLite parity).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM folder_assignments WHERE folder_id=$1 AND user_id=$2", [id, userId]);
      const res = await client.query("DELETE FROM folders WHERE id=$1 AND user_id=$2", [id, userId]);
      await client.query("COMMIT");
      return (res.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listFolderAssignments(userId: string): Promise<FolderAssignment[]> {
    const res = await this.pool.query(
      `SELECT a.site_id, a.folder_id, s.slug FROM folder_assignments a
         JOIN sites s ON s.id = a.site_id
        WHERE a.user_id=$1 AND s.deleted_at IS NULL`, [userId]);
    return res.rows.map((r) => ({ siteId: r.site_id as string, slug: r.slug as string, folderId: r.folder_id as string }));
  }

  async setFolderAssignment(userId: string, siteId: string, folderId: string | null, now: number): Promise<boolean> {
    if (folderId === null) {
      await this.pool.query("DELETE FROM folder_assignments WHERE user_id=$1 AND site_id=$2", [userId, siteId]);
      return true;
    }
    // One statement: the ownership check and the write cannot be separated by a concurrent folder
    // delete. If that delete still races the FK check, the violation is answered as "not your
    // folder" — the same false the caller gets when the folder never existed — rather than a 500.
    try {
      const res = await this.pool.query(
        `INSERT INTO folder_assignments (user_id, site_id, folder_id, updated_at)
         SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM folders WHERE id=$3 AND user_id=$1)
         ON CONFLICT (user_id, site_id) DO UPDATE SET folder_id=EXCLUDED.folder_id, updated_at=EXCLUDED.updated_at`,
        [userId, siteId, folderId, now]);
      return (res.rowCount ?? 0) > 0;
    } catch (error) {
      if ((error as { code?: string }).code === "23503") return false; // foreign_key_violation
      throw error;
    }
  }

  async insertUploadSession(u: UploadSessionRow): Promise<void> {
    await this.pool.query("INSERT INTO upload_sessions (version_id, site_id, target_slug, title, owner_key, files, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [u.versionId, u.siteId, u.targetSlug ?? null, u.title ?? null, u.ownerKey, JSON.stringify(u.files), u.createdAt]);
  }
  async getUploadSession(versionId: string): Promise<UploadSessionRow | null> {
    const row = await this.one("SELECT * FROM upload_sessions WHERE version_id=$1", [versionId]);
    return row ? toUploadSession(row) : null;
  }
  async compareUploadSessionFiles(versionId: string, before: UploadSessionRow["files"], after: UploadSessionRow["files"]): Promise<boolean> {
    const result = await this.pool.query("UPDATE upload_sessions SET files=$3 WHERE version_id=$1 AND files::jsonb=$2::jsonb", [versionId, JSON.stringify(before), JSON.stringify(after)]);
    return result.rowCount === 1;
  }
  async setUploadSessionFiles(versionId: string, files: UploadSessionRow["files"]): Promise<void> {
    await this.pool.query("UPDATE upload_sessions SET files=$2 WHERE version_id=$1", [versionId, JSON.stringify(files)]);
  }
  async deleteUploadSession(versionId: string): Promise<void> {
    await this.pool.query("DELETE FROM upload_sessions WHERE version_id=$1", [versionId]);
  }
  async listUploadSessionsForTarget(ownerKey: string, targetSlug: string): Promise<UploadSessionRow[]> {
    const { rows } = await this.pool.query("SELECT * FROM upload_sessions WHERE owner_key=$1 AND target_slug=$2", [ownerKey, targetSlug]);
    return (rows as Row[]).map(toUploadSession);
  }
  async listUploadSessionsBefore(createdBefore: number): Promise<UploadSessionRow[]> {
    const { rows } = await this.pool.query("SELECT * FROM upload_sessions WHERE created_at < $1", [createdBefore]);
    return (rows as Row[]).map(toUploadSession);
  }

  async insertDeviceGrant(g: { deviceCode: string; userCode: string; createdAt: number; expiresAt: number }): Promise<void> {
    try {
      await this.pool.query("INSERT INTO device_grants (device_code, user_code, created_at, expires_at) VALUES ($1,$2,$3,$4)",
        [g.deviceCode, g.userCode, g.createdAt, g.expiresAt]);
    } catch (error) {
      const e = error as { code?: string; constraint?: string };
      if (e?.code === "23505" && e.constraint === "device_grants_user_code_key") throw new UserCodeConflictError();
      throw error;
    }
  }

  async getDeviceGrant(deviceCode: string): Promise<DeviceGrant | null> {
    const row = await this.one("SELECT * FROM device_grants WHERE device_code=$1", [deviceCode]);
    return row ? toDeviceGrant(row) : null;
  }

  async approveDeviceGrant(userCode: string, userId: string, now: number): Promise<boolean> {
    const res = await this.pool.query(
      "UPDATE device_grants SET status='approved', user_id=$1 WHERE user_code=$2 AND status='pending' AND expires_at>$3",
      [userId, userCode, now]);
    return (res.rowCount ?? 0) > 0;
  }

  async redeemDeviceGrant(deviceCode: string, token: { id: string; name: string }, now: number): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        "UPDATE device_grants SET status='consumed', consumed_at=$1 WHERE device_code=$2 AND status='approved' AND expires_at>$3 RETURNING user_id",
        [now, deviceCode, now]);
      const userId = res.rows.length ? ((res.rows[0].user_id as string | null) ?? null) : null;
      if (!userId) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("INSERT INTO publish_tokens (id, user_id, name, created_at) VALUES ($1,$2,$3,$4)",
        [token.id, userId, token.name, now]);
      await client.query("COMMIT");
      return userId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async touchSession(id: string, expiresAt: number, lastSeenAt: number): Promise<void> {
    await this.pool.query("UPDATE sessions SET expires_at=$1, last_seen_at=$2 WHERE id=$3 AND revoked_at IS NULL", [expiresAt, lastSeenAt, id]);
  }

  async revokeSession(id: string): Promise<void> {
    await this.pool.query("UPDATE sessions SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL", [Date.now(), id]);
  }

  async revokeUserSessions(userId: string, exceptId: string | null = null): Promise<number> {
    const res = await this.pool.query(
      "UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)",
      [Date.now(), userId, exceptId],
    );
    return res.rowCount ?? 0;
  }

  async revokeSessionsByOidcSid(sid: string): Promise<number> {
    const res = await this.pool.query("UPDATE sessions SET revoked_at=$1 WHERE oidc_sid=$2 AND revoked_at IS NULL", [Date.now(), sid]);
    return res.rowCount ?? 0;
  }

  async createOidcFlow(input: CreateOidcFlowInput): Promise<void> {
    // Sweep on write rather than adding a cron: these rows are short-lived and only ever created
    // here, so the table stays bounded without another moving part to deploy and monitor.
    await this.pool.query("DELETE FROM oidc_flows WHERE expires_at < $1", [Date.now() - 24 * 60 * 60 * 1000]);
    await this.pool.query(
      "INSERT INTO oidc_flows (flow_id, verifier, nonce, return_to, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [input.flowId, input.verifier, input.nonce, input.returnTo, Date.now(), input.expiresAt],
    );
  }

  async consumeOidcFlow(flowId: string, now: number): Promise<CreateOidcFlowInput | null> {
    // Single UPDATE ... RETURNING: the row can only transition to consumed once, so two replicas
    // racing the same callback cannot both proceed.
    const { rows } = await this.pool.query(
      "UPDATE oidc_flows SET consumed_at=$1 WHERE flow_id=$2 AND consumed_at IS NULL AND expires_at > $1 RETURNING *",
      [now, flowId],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Row;
    return { flowId: r.flow_id as string, verifier: r.verifier as string, nonce: r.nonce as string,
             returnTo: r.return_to as string, expiresAt: Number(r.expires_at) };
  }

  async isCollaborator(siteId: string, userId: string): Promise<boolean> {
    const row = await this.one("SELECT 1 AS ok FROM site_collaborators WHERE site_id=$1 AND user_id=$2", [siteId, userId]);
    return row != null;
  }


  // --- administration -----------------------------------------------------------

  async setUserDisabled(id: string, at: number | null, reason: string | null): Promise<boolean> {
    const res = at == null
      ? await this.pool.query("UPDATE users SET disabled_at=NULL, disabled_reason=NULL, updated_at=$1 WHERE id=$2 AND disabled_at IS NOT NULL", [Date.now(), id])
      : await this.pool.query("UPDATE users SET disabled_at=$1, disabled_reason=$2, updated_at=$1 WHERE id=$3 AND disabled_at IS NULL", [at, reason, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async revokePublishTokensForUser(userId: string): Promise<number> {
    const res = await this.pool.query("UPDATE publish_tokens SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL", [Date.now(), userId]);
    return res.rowCount ?? 0;
  }

  async setSiteTakenDown(id: string, at: number | null, reason: string | null): Promise<boolean> {
    const res = at == null
      ? await this.pool.query("UPDATE sites SET taken_down_at=NULL, taken_down_reason=NULL, updated_at=$1 WHERE id=$2 AND taken_down_at IS NOT NULL", [Date.now(), id])
      : await this.pool.query("UPDATE sites SET taken_down_at=$1, taken_down_reason=$2, updated_at=$1 WHERE id=$3 AND taken_down_at IS NULL AND deleted_at IS NULL", [at, reason, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async restoreDeletedSite(id: string): Promise<boolean> {
    const res = await this.pool.query("UPDATE sites SET deleted_at=NULL, updated_at=$1 WHERE id=$2 AND deleted_at IS NOT NULL AND purged_at IS NULL", [Date.now(), id]);
    return (res.rowCount ?? 0) > 0;
  }

  async setSitePurged(id: string, at: number): Promise<void> {
    await this.pool.query("UPDATE sites SET purged_at=$1 WHERE id=$2 AND purged_at IS NULL AND deleted_at IS NOT NULL", [at, id]);
    await this.pool.query("DELETE FROM site_texts WHERE site_id=$1", [id]);
  }

  async listDeletedSitesBefore(before: number, limit: number): Promise<Site[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM sites WHERE deleted_at IS NOT NULL AND deleted_at <= $1 AND purged_at IS NULL ORDER BY deleted_at ASC LIMIT $2", [before, limit]);
    return (rows as Row[]).map(toSite);
  }

  async insertAdminLog(e: AdminLogEntry): Promise<void> {
    await this.pool.query(
      "INSERT INTO admin_log (id, actor_kind, actor_user_id, action, target_kind, target_id, reason, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [e.id, e.actorKind, e.actorUserId, e.action, e.targetKind, e.targetId, e.reason, e.ip, e.createdAt]);
  }

  async listAdminLog(opts: { targetId?: string | null; limit: number }): Promise<AdminLogEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM admin_log WHERE ($1::text IS NULL OR target_id = $1) ORDER BY created_at DESC, id LIMIT $2", [opts.targetId ?? null, opts.limit]);
    return (rows as Row[]).map(toAdminLog);
  }

  async hasRecentAdminLog(actorUserId: string, action: AdminAction, targetId: string, since: number): Promise<boolean> {
    const row = await this.one("SELECT 1 AS x FROM admin_log WHERE actor_user_id=$1 AND action=$2 AND target_id=$3 AND created_at >= $4 LIMIT 1", [actorUserId, action, targetId, since]);
    return row != null;
  }

  async upsertSiteText(w: SiteTextWrite): Promise<boolean> {
    // The EXISTS guard is the race protection: two commits in quick succession extract in
    // parallel, and the older one may finish last — its row must not replace the newer one.
    const { rowCount } = await this.pool.query(`
      INSERT INTO site_texts (site_id, version_id, title, body, chars, tokens, extracted_at, extractor_version)
      SELECT $1, $2, $3, $4, $5, setweight(to_tsvector('simple', $6), 'A') || setweight(to_tsvector('simple', $7), 'B'), $8, $9
      WHERE EXISTS (SELECT 1 FROM sites WHERE id = $1 AND current_version_id = $2)
      ON CONFLICT (site_id) DO UPDATE SET version_id = EXCLUDED.version_id, title = EXCLUDED.title, body = EXCLUDED.body,
        chars = EXCLUDED.chars, tokens = EXCLUDED.tokens, extracted_at = EXCLUDED.extracted_at, extractor_version = EXCLUDED.extractor_version`,
      [w.siteId, w.versionId, w.title, w.body, w.body.length, w.titleTokens, w.bodyTokens, w.extractedAt, w.extractorVersion]);
    return (rowCount ?? 0) > 0;
  }

  async updateSiteTextTitle(siteId: string, title: string, titleTokens: string): Promise<boolean> {
    // ts_filter keeps the body's (weight B) lexemes; only the title's (weight A) are rebuilt.
    const { rowCount } = await this.pool.query(
      "UPDATE site_texts SET title = $2, tokens = setweight(to_tsvector('simple', $3), 'A') || ts_filter(tokens, '{b}') WHERE site_id = $1",
      [siteId, title, titleTokens]);
    return (rowCount ?? 0) > 0;
  }

  async getSiteText(siteId: string): Promise<SiteTextRow | null> {
    const row = await this.one("SELECT site_id, version_id, title, body, chars, extracted_at, extractor_version FROM site_texts WHERE site_id=$1", [siteId]);
    return row ? toSiteText(row) : null;
  }

  async searchSiteTexts(viewer: ListViewer | undefined, tokens: SearchToken[], limit: number): Promise<SearchHit[]> {
    if (!tokens.length) return [];
    // Same visibility predicate as listSiteSummaries; only the current version's text counts.
    // The body's opening is enough for a snippet; a later match falls back to the opening anyway.
    const query = tokens.map((t) => (t.prefix ? `${t.text}:*` : t.text)).join(" & ");
    const { rows } = await this.pool.query(`
      SELECT s.slug, s.title, s.kind, s.visibility, s.taken_down_at, s.updated_at, left(t.body, 30000) AS body,
             ts_rank(t.tokens, q) AS rank
      FROM site_texts t
      JOIN sites s ON s.id = t.site_id AND s.current_version_id = t.version_id,
           to_tsquery('simple', $3) q
      WHERE s.deleted_at IS NULL AND t.tokens @@ q
        AND ((COALESCE(s.visibility, 'public') = 'public' AND s.taken_down_at IS NULL)
             OR s.owner_id = $1
             OR (s.owner_id IS NULL AND s.anon_owner_id = $2)
             OR EXISTS (SELECT 1 FROM site_collaborators c WHERE c.site_id = s.id AND c.user_id = $1))
      ORDER BY rank DESC, s.updated_at DESC
      LIMIT $4`, [viewer?.userId ?? null, viewer?.anonId ?? null, query, limit]);
    return (rows as Row[]).map(toSearchHit);
  }

  async listSitesNeedingText(limit: number): Promise<{ siteId: string; versionId: string }[]> {
    const { rows } = await this.pool.query(`
      SELECT s.id, s.current_version_id FROM sites s
      LEFT JOIN site_texts t ON t.site_id = s.id
      WHERE s.deleted_at IS NULL AND s.current_version_id IS NOT NULL
        AND (t.site_id IS NULL OR t.version_id <> s.current_version_id OR t.extractor_version < $2)
      ORDER BY s.updated_at DESC LIMIT $1`, [limit, SITE_TEXT_EXTRACTOR_VERSION]);
    return (rows as Row[]).map((r) => ({ siteId: String(r.id), versionId: String(r.current_version_id) }));
  }

  async listSettings(scope: string): Promise<SettingRow[]> {
    const { rows } = await this.pool.query("SELECT * FROM settings WHERE scope=$1 ORDER BY key", [scope]);
    return (rows as Row[]).map(toSettingRow);
  }

  async writeSettings(scope: string, writes: SettingWrite[], updatedBy: string | null, now: number): Promise<void> {
    // One transaction: a batch from the console lands whole or not at all.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const w of writes) {
        if (w.value === null) await client.query("DELETE FROM settings WHERE scope=$1 AND key=$2", [scope, w.key]);
        else await client.query(
          "INSERT INTO settings (scope, key, value, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope, key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by",
          [scope, w.key, w.value, now, updatedBy]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async adminOverview(): Promise<AdminOverview> {
    const row = await this.one(`
      SELECT (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled_users,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL) AS sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL AND owner_id IS NULL) AS anonymous_sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NULL AND taken_down_at IS NOT NULL) AS taken_down_sites,
             (SELECT COUNT(*) FROM sites WHERE deleted_at IS NOT NULL AND purged_at IS NULL) AS deleted_sites,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM versions v JOIN sites s ON s.id = v.site_id WHERE s.purged_at IS NULL) AS byte_total`, []);
    return toAdminOverview(row ?? {});
  }

  async listUsersAdmin(opts: AdminUserQuery): Promise<{ rows: AdminUserRow[]; total: number }> {
    const order = adminUserOrder(opts.sort);
    const { rows } = await this.pool.query(`
      SELECT u.*, COUNT(*) OVER() AS total,
             (SELECT COUNT(*) FROM sites s WHERE s.owner_id = u.id AND s.deleted_at IS NULL) AS site_count,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM sites s JOIN versions v ON v.site_id = s.id
               WHERE s.owner_id = u.id AND s.purged_at IS NULL) AS byte_total
      FROM users u
      WHERE ($1 = '' OR lower(COALESCE(u.email, '')) LIKE $2 ESCAPE '\\' OR lower(COALESCE(u.display_name, '')) LIKE $2 ESCAPE '\\')
        AND ($3 = false OR u.disabled_at IS NOT NULL)
      ORDER BY ${order}, u.id
      LIMIT $4 OFFSET $5`, [opts.q, likeContains(opts.q), opts.disabledOnly, opts.limit, opts.offset]);
    return { rows: (rows as Row[]).map(toAdminUserRow), total: Number((rows[0] as Row | undefined)?.total ?? 0) };
  }

  async listSitesAdmin(opts: AdminSiteQuery): Promise<{ rows: AdminSiteRow[]; total: number }> {
    const { rows } = await this.pool.query(`
      SELECT s.*, u.email AS owner_email, u.display_name AS owner_name, COUNT(*) OVER() AS total,
             (SELECT COUNT(*) FROM versions v WHERE v.site_id = s.id) AS version_count,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM versions v WHERE v.site_id = s.id) AS byte_total
      FROM sites s LEFT JOIN users u ON u.id = s.owner_id
      WHERE ($1 = '' OR lower(s.title) LIKE $2 ESCAPE '\\' OR lower(s.slug) LIKE $2 ESCAPE '\\' OR lower(COALESCE(u.email, '')) LIKE $2 ESCAPE '\\')
        AND ($3::text IS NULL OR s.owner_id = $3)
        AND ($4 = false OR s.owner_id IS NULL)
        AND CASE $5 WHEN 'deleted' THEN (s.deleted_at IS NOT NULL AND s.purged_at IS NULL)
                    WHEN 'taken_down' THEN (s.deleted_at IS NULL AND s.taken_down_at IS NOT NULL)
                    ELSE s.deleted_at IS NULL END
      ORDER BY s.updated_at DESC, s.id
      LIMIT $6 OFFSET $7`,
      [opts.q, likeContains(opts.q), opts.ownerId, opts.anonymousOnly, opts.state, opts.limit, opts.offset]);
    return { rows: (rows as Row[]).map(toAdminSiteRow), total: Number((rows[0] as Row | undefined)?.total ?? 0) };
  }


  // --- quotas and expiry --------------------------------------------------------

  async ownerUsage(owner: QuotaOwner): Promise<{ sites: number; bytes: number }> {
    // One predicate for both numbers: an account owns by owner_id; an anonymous browser only while
    // the row is still unowned (a claimed site moved to the account, and counts there).
    const where = owner.userId ? "s.owner_id = $1" : "s.owner_id IS NULL AND s.anon_owner_id = $1";
    const key = owner.userId ?? owner.anonId;
    const row = await this.one(`
      SELECT (SELECT COUNT(*) FROM sites s WHERE ${where} AND s.deleted_at IS NULL) AS sites,
             (SELECT COALESCE(SUM(v.byte_size), 0) FROM sites s JOIN versions v ON v.site_id = s.id WHERE ${where} AND s.purged_at IS NULL) AS bytes`, [key]);
    return { sites: Number(row?.sites ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  async expireAnonymousSites(before: number, now: number, limit: number): Promise<Site[]> {
    const { rows } = await this.pool.query(`
      UPDATE sites SET deleted_at = $1, updated_at = $1
       WHERE id IN (SELECT id FROM sites
                     WHERE owner_id IS NULL AND anon_owner_id IS NOT NULL AND deleted_at IS NULL AND updated_at < $2
                     ORDER BY updated_at ASC LIMIT $3)
       RETURNING *`, [now, before, limit]);
    return (rows as Row[]).map(toSite);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
