import { traceUploadStore } from "@/lib/upload-timing";
// Metadata access facade: PostgreSQL in production, SQLite only in tests.
// Publication orchestration belongs above this layer in publication-service.
import { listSharesQuery } from "@/lib/share-queries";
import "server-only";
import { config } from "@/lib/config";
import type {
  AuditEntry,
  InsertShareInput,
  Share,
  ShareGrant,
  SharePolicy,
  ShareRow,
  ShareView,
  Session,
  Site,
  SiteOpen,
  SiteSummary,
  SiteView,
  SiteViewStats,
  User,
  Version,
  Visibility,
  AdminAction,
  AdminLogEntry,
  AdminOverview,
  AdminSiteRow,
  AdminUserRow,
  SettingRow,
  SettingWrite,
  OauthAuthorization,
  OauthClientRecord,
  OauthConnection,
  OauthToken,
} from "@/lib/types";
import { flushAfterResponseForTests } from "@/lib/after-response";
import { SqliteStore } from "@/lib/db-sqlite";
import { PostgresStore } from "@/lib/db-postgres";
import type { RbacQuery, RbacTransaction } from "@/lib/rbac-store";
import {
  type UploadSessionRow,
  type InsertSiteInput,
  type ListViewer,
  type UpsertUserInput,
  type CreateSessionInput,
  type CreateOidcFlowInput,
  type InsertVersionInput,
  type InsertAuditInput,
  type QuotaOwner,
  type AdminUserQuery,
  type AdminSiteQuery,
  type SiteTextWrite,
  type SiteTextRow,
  type SearchToken,
  type SearchHit,
  toShareRow,
  type UserFolder,
  type FolderAssignment,
  type PublishToken,
  type DeviceGrant,
} from "@/lib/metadata-model";
export * from "@/lib/metadata-model";

export interface MetadataStore {
  rbacQuery: RbacQuery;
  rbacTransaction: RbacTransaction;
  init(): Promise<void>;
  insertSite(input: InsertSiteInput): Promise<void>;
  /** Append an audit row outside a publication transaction (for metadata-only actions). */
  insertAudit(input: InsertAuditInput): Promise<void>;
  /** A site's audit trail, newest first — for the history/audit UI. */
  listAudit(siteId: string, limit?: number): Promise<AuditEntry[]>;
  getSiteBySlug(slug: string): Promise<Site | null>;
  getSite(id: string): Promise<Site | null>;
  setCurrentVersion(siteId: string, versionId: string): Promise<void>;
  updateSiteTitle(id: string, title: string): Promise<void>;
  setEditToken(id: string, token: string): Promise<void>;
  softDeleteSite(id: string): Promise<void>;
  /**
   * The site directory. `visibility` is honoured here and ONLY here: an `unlisted` (or `private`)
   * site is never listed to a stranger, which is the entire promise of "Unlisted". `viewer`
   * carves out the one exception — your own sites stay in your own list whatever you set them to,
   * because a switch that hides a site from its author is worse than no switch at all.
   *
   * Omit `viewer` (or pass blanks) for the anonymous case: public rows only. Owner-scoped lists
   * (`listSitesByOwner` / `listSitesForCollaborator`) do NOT filter — see their doc comments.
   */
  listSiteSummaries(viewer?: ListViewer, options?: { withViews?: boolean; ownedOnly?: boolean; limit?: number }): Promise<SiteSummary[]>;
  countVersions(siteId: string): Promise<number>;
  insertVersion(input: InsertVersionInput): Promise<void>;
  getVersion(id: string): Promise<Version | null>;
  listVersions(siteId: string): Promise<Version[]>;
  backfillEditTokens(): Promise<number>;
  /** Create-or-refresh an account by provider subject, with an explicitly enabled, verified-email
   *  migration bridge for the OIDC cutover. Returns the row. */
  upsertUser(input: UpsertUserInput): Promise<User & { created: boolean }>;
  getUser(id: string): Promise<User | null>;
  /** Look up by VERIFIED email only — an unverified address is attacker-controllable. */
  getUserByVerifiedEmail(email: string): Promise<User | null>;
  /**
   * People-picker search, PREFIX match on display name or e-mail, newest-active first.
   *
   * Scoped to accounts that have signed in HERE simply by reading the users table: a row is only
   * ever written by upsertUser at login, so there is no directory of strangers to leak. `q` is a
   * literal — the backends escape LIKE's wildcards, or a lone `%` would match every account.
   *
   * An e-mail only matches while it is VERIFIED, for exactly the reason getUserByVerifiedEmail
   * exists: an unverified address is attacker-controllable, so anyone could put a colleague's
   * address on their own account and be picked out of this list in that colleague's place.
   */
  searchUsers(q: string, viewerId: string, limit: number): Promise<User[]>;
  updateSiteVisibility(siteId: string, visibility: Visibility): Promise<void>;
  listAudienceExcludedUserIds(siteId: string): Promise<string[]>;

  // --- share links ---------------------------------------------------------
  createShare(input: InsertShareInput): Promise<Share>;
  /** By token hash — the only lookup a reader's request can drive. Returns revoked/expired rows
   *  too: the caller decides, so that "revoked" and "never existed" can answer identically. */
  getShareByTokenHash(tokenHash: string): Promise<ShareRow | null>;
  getShare(id: string): Promise<ShareRow | null>;
  listShares(siteId: string): Promise<Share[]>;
  revokeShare(id: string, at: number): Promise<void>;
  updateSharePolicy(id: string, policy: SharePolicy, passcodeHash: string | null, expiresAt: number | null): Promise<void>;
  /** Q&A-mode flag on one share — its own setter, not folded into updateSharePolicy, because
   *  toggling the assistant must not force the caller to restate (and re-mint) passcodes. */
  setShareAllowAi(id: string, allowAi: boolean): Promise<void>;
  /** Every live share of a site, for the read gate — it asks "does ANY of them let this reader in". */
  listLiveShares(siteId: string, now: number): Promise<ShareRow[]>;

  addShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }, grantedBy: string | null): Promise<void>;
  removeShareGrant(shareId: string, target: { userId?: string | null; email?: string | null }): Promise<void>;
  listShareGrants(shareId: string): Promise<ShareGrant[]>;

  recordShareView(view: ShareView): Promise<void>;
  /** Has this exact reader been recorded on this share since `since`? Collapses refreshes. */
  hasRecentShareView(shareId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean>;
  listShareViews(siteId: string, limit: number): Promise<ShareView[]>;
  /** Delete at most 1,000 old details, atomically retaining their lifetime count. */
  pruneShareViews(before: number): Promise<number>;

  // --- direct openings of /s/<slug> (site_views) + read-side aggregates over BOTH view tables ---
  recordSiteView(view: SiteView): Promise<void>;
  /** Atomically collapse a reader across direct and share entrances. */
  recordSiteOpen(view: SiteOpen, collapseMs: number): Promise<void>;
  /** Same collapse contract as hasRecentShareView, keyed by site instead of share. */
  hasRecentSiteView(siteId: string, userId: string | null, anonId: string | null, ip: string | null, since: number): Promise<boolean>;
  /** share_views ∪ site_views, newest first — one list of "who opened this", whichever door. */
  listSiteOpens(siteId: string, limit: number): Promise<SiteOpen[]>;
  /**
   * Aggregates over both tables. `opens`/`uniqueViewers` count rows with viewedAt >= since;
   * `lastViewedAt` is NOT clipped to the window. Rows attributed to `exclude.userIds` (owner and
   * collaborators) or `exclude.anonIds` (an ANONYMOUS owner — the agent-publish hero flow has no
   * account to exclude by) are left out of all three: the UI promises "not counting yourself",
   * and that promise must hold for both kinds of owner.
   */
  getSiteViewStats(siteId: string, since: number, exclude: { userIds: readonly string[]; anonIds: readonly string[] }): Promise<SiteViewStats>;
  /** Delete at most 1,000 old details, atomically retaining their lifetime count. */
  pruneSiteViews(before: number): Promise<number>;
  /** Attribute the anonymous versions of a just-claimed site to its new owner. */
  attributeUnattributedVersions(siteId: string, userId: string): Promise<number>;
  clearSiteOwner(siteId: string): Promise<void>;
  /** "My sites" / "Sites I collaborate on". Deliberately NOT filtered by visibility: these answer "what is mine",
   *  and marking a site Unlisted must never hide it from the person who owns or co-edits it. */
  listSitesByOwner(ownerId: string): Promise<SiteSummary[]>;
  listSitesForCollaborator(userId: string): Promise<SiteSummary[]>;
  createSession(input: CreateSessionInput): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  /** Slide the expiry window. Callers clamp to absoluteExpiresAt before calling. */
  touchSession(id: string, expiresAt: number, lastSeenAt: number): Promise<void>;
  revokeSession(id: string): Promise<void>;
  /** Revoke every live session of a user, optionally sparing one (the just-issued login). */
  revokeUserSessions(userId: string, exceptId?: string | null): Promise<number>;
  /** Back-channel logout: the IdP names a session by its `sid` claim. */
  revokeSessionsByOidcSid(sid: string): Promise<number>;
  createOidcFlow(input: CreateOidcFlowInput): Promise<void>;
  /** Atomically mark a flow consumed and return it. Null if unknown, expired or already used —
   *  this single-shot property is what stops an authorization-code replay across replicas. */
  consumeOidcFlow(flowId: string, now: number): Promise<CreateOidcFlowInput | null>;
  // Publish tokens (agent identity): id is sha256 of the bearer secret, mirroring sessions.
  insertPublishToken(t: { id: string; userId: string; name: string; createdAt: number }): Promise<void>;
  getPublishToken(id: string): Promise<PublishToken | null>;
  touchPublishToken(id: string, lastUsedAt: number): Promise<void>;
  listPublishTokens(userId: string): Promise<PublishToken[]>;
  /** Scoped to the owner so one user cannot revoke another's token by guessing ids. */
  revokePublishToken(id: string, userId: string): Promise<boolean>;
  // OAuth for remote MCP clients (lib/oauth): registered clients, pending consents that become
  // authorization codes, and the access + refresh tokens minted from them. Secrets are sha256 only.
  insertOauthClient(c: OauthClientRecord): Promise<void>;
  getOauthClient(id: string): Promise<OauthClientRecord | null>;
  touchOauthClient(id: string, now: number): Promise<void>;
  insertOauthAuthorization(a: OauthAuthorization): Promise<void>;
  getOauthAuthorization(id: string): Promise<OauthAuthorization | null>;
  /** pending → approved: records the code hash and grant id and restarts the clock for the code.
   *  Only the account the request was made for, only once, only while unexpired. */
  approveOauthAuthorization(id: string, userId: string, code: { codeHash: string; grantId: string; expiresAt: number }, now: number): Promise<boolean>;
  /** Settle a request without a code (the person declined), so its id cannot be answered again. */
  consumeOauthAuthorization(id: string, now: number): Promise<boolean>;
  /** Consume an authorization code atomically. `reused` marks a code presented a second time —
   *  the caller revokes the grant. Null: unknown, expired, or lost a concurrent redemption. */
  redeemOauthCode(codeHash: string, now: number): Promise<{ authorization: OauthAuthorization; reused: boolean } | null>;
  /** The access + refresh pair of one issuance, in one transaction. */
  insertOauthTokens(tokens: OauthToken[]): Promise<void>;
  getOauthToken(id: string): Promise<OauthToken | null>;
  touchOauthToken(id: string, now: number): Promise<void>;
  /** Retire a refresh token for rotation. `reused` marks one that was already retired — the
   *  caller revokes the grant. Null: unknown or expired. */
  consumeOauthRefreshToken(id: string, now: number): Promise<{ token: OauthToken; reused: boolean } | null>;
  revokeOauthToken(id: string, now: number): Promise<boolean>;
  /** Every live token of a grant; scoped to the owner when `userId` is given (the account page). */
  revokeOauthGrant(grantId: string, now: number, userId?: string | null): Promise<number>;
  /** Every live token of the user's OTHER grants for this client — a re-consent supersedes them. */
  revokeOauthGrantsForClient(userId: string, clientId: string, now: number, exceptGrantId: string): Promise<number>;
  /** One row per live grant: what the account page lists as connected applications. */
  listOauthConnections(userId: string, now: number): Promise<OauthConnection[]>;
  /** Every live OAuth token of a user, in one statement (disable / offboarding). */
  revokeOauthTokensForUser(userId: string, now: number): Promise<number>;
  /** Drop what can no longer matter: settled or expired requests, dead tokens past the window in
   *  which a replay must still be recognised, and registered clients nobody has used in months. */
  pruneOauth(now: number): Promise<number>;
  /** Attach ownership and its audit row atomically; authorization belongs to the caller. */
  claimSiteAudited(siteId: string, ownerId: string, audit: InsertAuditInput, adminLog?: AdminLogEntry): Promise<boolean>;
  insertUploadSession(u: UploadSessionRow): Promise<void>;
  getUploadSession(versionId: string): Promise<UploadSessionRow | null>;
  compareUploadSessionFiles(versionId: string, before: UploadSessionRow["files"], after: UploadSessionRow["files"]): Promise<boolean>;
  deleteUploadSession(versionId: string): Promise<void>;
  listUploadSessionsForTarget(ownerKey: string, targetSlug: string): Promise<UploadSessionRow[]>;
  listUploadSessionsBefore(createdBefore: number): Promise<UploadSessionRow[]>;
  /** Throws UserCodeConflictError when `userCode` is already taken (the caller retries with a fresh one). */
  insertDeviceGrant(g: { deviceCode: string; userCode: string; createdAt: number; expiresAt: number }): Promise<void>;
  getDeviceGrant(deviceCode: string): Promise<DeviceGrant | null>;
  /** pending → approved, only while unexpired. False means unknown / expired / already settled. */
  approveDeviceGrant(userCode: string, userId: string, now: number): Promise<boolean>;
  /** approved → consumed AND the publish token minted, in one transaction. Null when the CAS finds
   *  nothing to consume (pending / expired / already redeemed). If the token insert fails the
   *  consume rolls back with it — the grant stays approved, so the agent's retry can still succeed
   *  instead of being told to restart the whole device flow. Exactly-once either way. */
  redeemDeviceGrant(deviceCode: string, token: { id: string; name: string }, now: number): Promise<string | null>;
  // Folders: an account-level shelf for "My sites". Owner-perspective data — nothing on `sites`
  // changes, and a site may sit in at most one folder per user (PRIMARY KEY (user_id, site_id)).
  listFolders(userId: string): Promise<UserFolder[]>;
  /** Appends the folder (sort = current max + 1) unless the user already has `maxFolders`; the
   *  count, the sort and the insert are ONE statement, so two concurrent creates cannot both slip
   *  under the cap. False = cap reached, nothing written. */
  insertFolder(f: { id: string; userId: string; name: string; createdAt: number }, maxFolders: number): Promise<boolean>;
  renameFolder(id: string, userId: string, name: string, now: number): Promise<boolean>;
  /** Deletes the folder AND its assignments (members fall back to Unfiled); never touches sites. */
  deleteFolder(id: string, userId: string): Promise<boolean>;
  /** Live sites only: a deleted site's row is ignored rather than surfacing a slug nobody can open. */
  listFolderAssignments(userId: string): Promise<FolderAssignment[]>;
  /** `folderId: null` un-files. False when the folder is not this user's (a dangling pointer is
   *  refused, not stored). */
  setFolderAssignment(userId: string, siteId: string, folderId: string | null, now: number): Promise<boolean>;

  // --- administration -------------------------------------------------------
  /** `at: null` re-enables. False when the row is missing or already in the requested state. */
  setUserDisabled(id: string, at: number | null, reason: string | null): Promise<boolean>;
  /** Every live publish token of a user, in one statement (disable / offboarding). */
  revokePublishTokensForUser(userId: string): Promise<number>;
  /** `at: null` restores. False when missing or already in the requested state. */
  setSiteTakenDown(id: string, at: number | null, reason: string | null): Promise<boolean>;
  /** Undo a soft delete while the files are still there. False once purged (or never deleted). */
  restoreDeletedSite(id: string): Promise<boolean>;
  /** Only while still deleted: a site restored between the file removal and this write stays live
   *  and unmarked (its files are gone — the unavoidable half of that race — but the row is honest). */
  /** Soft-deleted at or before `before` and not yet purged — the purge worklist, oldest first. */
  listDeletedSitesBefore(before: number, limit: number): Promise<Site[]>;
  insertAdminLog(entry: AdminLogEntry): Promise<void>;
  listAdminLog(opts: { targetId?: string | null; limit: number }): Promise<AdminLogEntry[]>;
  /** Has this administrator done this to this target since `since`? Collapses a burst (a page and
   *  its twenty assets) into one row. */
  hasRecentAdminLog(actorUserId: string, action: AdminAction, targetId: string, since: number): Promise<boolean>;
  adminOverview(): Promise<AdminOverview>;
  /** Every account with its live site count and stored bytes (all versions of its sites). */
  listUsersAdmin(opts: AdminUserQuery): Promise<{ rows: AdminUserRow[]; total: number }>;
  listSitesAdmin(opts: AdminSiteQuery): Promise<{ rows: AdminSiteRow[]; total: number }>;

  // --- quotas and expiry --------------------------------------------------------
  /** Live site count and stored bytes (every version of every unpurged site) of one owner:
   *  an account, or an anonymous browser whose sites nobody has claimed yet. */
  ownerUsage(owner: QuotaOwner): Promise<{ sites: number; bytes: number }>;
  /** Soft-delete anonymous sites (an anonymous browser's, never claimed) last changed before
   *  `before`. Pre-identity rows (no anonymous owner either) are never touched. Returns what went. */
  expireAnonymousSites(before: number, now: number, limit: number): Promise<Site[]>;

  // --- searchable text (lib/site-text) ------------------------------------------------
  /** One row per site. Written only while `versionId` is still the site's current version — a
   *  slower extraction of an older version must not overwrite a newer one; false = not written. */
  upsertSiteText(write: SiteTextWrite): Promise<boolean>;
  /** A rename: the title and its tokens change, the body stays. False when the site has no row. */
  updateSiteTextTitle(siteId: string, title: string, titleTokens: string): Promise<boolean>;
  getSiteText(siteId: string): Promise<SiteTextRow | null>;
  /** Live sites whose CURRENT version's text matches every token, most relevant first, under the
   *  same visibility predicate as listSiteSummaries: what the viewer could list, they may search. */
  searchSiteTexts(viewer: ListViewer | undefined, tokens: SearchToken[], limit: number): Promise<SearchHit[]>;
  /** Live sites whose current version has no text row yet (or a stale one), freshest first. */
  listSitesNeedingText(limit: number): Promise<{ siteId: string; versionId: string }[]>;

  // --- console settings (lib/settings) ------------------------------------------------
  listSettings(scope: string): Promise<SettingRow[]>;
  /** Apply a batch — puts and removals — in one transaction. */
  writeSettings(scope: string, writes: SettingWrite[], updatedBy: string | null, now: number): Promise<void>;
  close(): Promise<void>;
}

let storePromise: Promise<MetadataStore> | null = null;

function getStore(): Promise<MetadataStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const driver = config.dbDriver;
      let store: MetadataStore;
      if (driver === "postgres") store = new PostgresStore();
      else if (driver === "sqlite") {
        // The sqlite backend is the test suite's, not a deployment option: refusing here (and
        // not only in the boot check) keeps the rule intact on any host that skips
        // instrumentation, e.g. a custom server or an old image with the env carried over.
        if (!config.sqliteAllowed) {
          throw new Error(
            "ARTIFACT_DB_DRIVER=sqlite is for the test runner only; production deployments must use Postgres: " +
            "remove this variable and set ARTIFACT_DATABASE_URL.",
          );
        }
        store = new SqliteStore();
      } else throw new Error(`unknown ARTIFACT_DB_DRIVER: ${driver}`);
      await store.init();
      return traceUploadStore(store);
    })();
    // Don't cache a failed init (e.g. Postgres unreachable at startup) — let the next call retry.
    storePromise.catch(() => { storePromise = null; });
  }
  return storePromise;
}

/** Test/ops hook: close + drop the memoized backend so the next call re-opens it. */
const closeHooks: Array<() => void> = [];
/** Modules that cache what they read from the store register here, so a test's fresh database never meets a stale cache. */
export function onDbCloseForTests(hook: () => void): void {
  closeHooks.push(hook);
}

export async function closeDbForTests(): Promise<void> {
  await flushAfterResponseForTests(); // extractions scheduled by the test's writes finish on THIS store, not a re-opened one
  const p = storePromise;
  storePromise = null;
  for (const hook of closeHooks) hook();
  if (p) await (await p).close().catch(() => {});
}

/** Gracefully drain the metadata pool when a standalone worker stops. */


// --- delegating API (same names as before, now async) ------------------------
// Lock-only wrappers below deliberately call store methods on their own connection.
// They serialize revocation with publication, but do not make those autocommit writes
// atomic with the surrounding transaction. Atomic multi-statement writes must use q.

export async function insertSite(input: InsertSiteInput): Promise<void> {
  return (await getStore()).insertSite(input);
}
export async function insertAudit(input: InsertAuditInput): Promise<void> {
  return (await getStore()).insertAudit(input);
}
export async function listAudit(siteId: string, limit?: number): Promise<AuditEntry[]> {
  return (await getStore()).listAudit(siteId, limit);
}
export async function getSiteBySlug(slug: string): Promise<Site | null> {
  return (await getStore()).getSiteBySlug(slug);
}
export async function getSite(id: string): Promise<Site | null> {
  return (await getStore()).getSite(id);
}
export async function updateSiteTitle(id: string, title: string): Promise<void> {
  return (await getStore()).updateSiteTitle(id, title);
}
export async function setEditToken(id: string, token: string): Promise<void> {
  return rbacTransaction(async () => (await getStore()).setEditToken(id, token));
}
export async function softDeleteSite(id: string): Promise<void> {
  return (await getStore()).softDeleteSite(id);
}
export async function listSiteSummaries(viewer?: ListViewer, options?: { withViews?: boolean; ownedOnly?: boolean; limit?: number }): Promise<SiteSummary[]> {
  return (await getStore()).listSiteSummaries(viewer, options);
}
export async function countVersions(siteId: string): Promise<number> {
  return (await getStore()).countVersions(siteId);
}
export async function insertVersion(input: InsertVersionInput): Promise<void> {
  return (await getStore()).insertVersion(input);
}
export async function getVersion(id: string): Promise<Version | null> {
  return (await getStore()).getVersion(id);
}
export async function listVersions(siteId: string): Promise<Version[]> {
  return (await getStore()).listVersions(siteId);
}
export async function backfillEditTokens(): Promise<number> {
  return (await getStore()).backfillEditTokens();
}

export async function upsertUser(input: UpsertUserInput): Promise<User & { created: boolean }> {
  const user = await (await getStore()).upsertUser(input);
  if (input.publicDisplayName !== undefined) {
    const name = input.publicDisplayName?.trim();
    const safeName = name && !name.includes("@") && name !== input.providerSubject && name.toLowerCase() !== input.email?.toLowerCase() ? name : null;
    await rbacQuery("UPDATE users SET public_display_name=$2 WHERE id=$1", [user.id, safeName]);
  }
  return user;
}
export async function getUser(id: string): Promise<User | null> {
  return (await getStore()).getUser(id);
}
export async function getUserByVerifiedEmail(email: string): Promise<User | null> {
  return (await getStore()).getUserByVerifiedEmail(email);
}
export async function searchUsers(q: string, viewerId: string, limit = 10): Promise<User[]> {
  return (await getStore()).searchUsers(q, viewerId, limit);
}

export async function updateSiteVisibility(siteId: string, visibility: Visibility): Promise<void> {
  return (await getStore()).updateSiteVisibility(siteId, visibility);
}
export async function listAudienceExcludedUserIds(siteId: string): Promise<string[]> {
  return (await getStore()).listAudienceExcludedUserIds(siteId);
}

// --- share links -------------------------------------------------------------
export async function createShare(input: InsertShareInput): Promise<Share> {
  return (await getStore()).createShare(input);
}
export async function getShareByTokenHash(tokenHash: string): Promise<ShareRow | null> {
  return (await getStore()).getShareByTokenHash(tokenHash);
}
export async function getShare(id: string): Promise<ShareRow | null> {
  return (await getStore()).getShare(id);
}
export async function listShares(siteId: string): Promise<Share[]> {
  return (await getStore()).listShares(siteId);
}
export async function revokeShare(id: string, at: number = Date.now()): Promise<void> {
  return (await getStore()).revokeShare(id, at);
}
export async function setShareAllowAi(id: string, allowAi: boolean): Promise<void> {
  return (await getStore()).setShareAllowAi(id, allowAi);
}
export async function updateSharePolicy(
  id: string, policy: SharePolicy, passcodeHash: string | null, expiresAt: number | null,
): Promise<void> {
  return (await getStore()).updateSharePolicy(id, policy, passcodeHash, expiresAt);
}
export async function listLiveShares(siteId: string, now: number = Date.now()): Promise<ShareRow[]> {
  return (await getStore()).listLiveShares(siteId, now);
}
export async function addShareGrant(
  shareId: string, target: { userId?: string | null; email?: string | null }, grantedBy: string | null = null,
): Promise<void> {
  return (await getStore()).addShareGrant(shareId, target, grantedBy);
}
export async function removeShareGrant(
  shareId: string, target: { userId?: string | null; email?: string | null },
): Promise<void> {
  return (await getStore()).removeShareGrant(shareId, target);
}
export async function listShareGrants(shareId: string): Promise<ShareGrant[]> {
  return (await getStore()).listShareGrants(shareId);
}

export async function recordShareView(view: ShareView): Promise<void> {
  return (await getStore()).recordShareView(view);
}
export async function hasRecentShareView(
  shareId: string, userId: string | null, anonId: string | null, ip: string | null, since: number,
): Promise<boolean> {
  return (await getStore()).hasRecentShareView(shareId, userId, anonId, ip, since);
}
export async function listShareViews(siteId: string, limit = 200): Promise<ShareView[]> {
  return (await getStore()).listShareViews(siteId, limit);
}
export async function pruneShareViews(before: number): Promise<number> {
  return (await getStore()).pruneShareViews(before);
}
export async function recordSiteOpen(view: SiteOpen, collapseMs: number): Promise<void> {
  return (await getStore()).recordSiteOpen(view, collapseMs);
}

export async function recordSiteView(view: SiteView): Promise<void> {
  return (await getStore()).recordSiteView(view);
}
export async function hasRecentSiteView(
  siteId: string, userId: string | null, anonId: string | null, ip: string | null, since: number,
): Promise<boolean> {
  return (await getStore()).hasRecentSiteView(siteId, userId, anonId, ip, since);
}
export async function listSiteOpens(siteId: string, limit = 200): Promise<SiteOpen[]> {
  return (await getStore()).listSiteOpens(siteId, limit);
}
export async function getSiteViewStats(
  siteId: string, since: number, exclude: { userIds?: readonly string[]; anonIds?: readonly string[] } = {},
): Promise<SiteViewStats> {
  return (await getStore()).getSiteViewStats(siteId, since, { userIds: exclude.userIds ?? [], anonIds: exclude.anonIds ?? [] });
}
export async function pruneSiteViews(before: number): Promise<number> {
  return (await getStore()).pruneSiteViews(before);
}

export async function attributeUnattributedVersions(siteId: string, userId: string): Promise<number> {
  return (await getStore()).attributeUnattributedVersions(siteId, userId);
}
export async function clearSiteOwner(siteId: string): Promise<void> {
  return (await getStore()).clearSiteOwner(siteId);
}

export async function listSitesByOwner(ownerId: string): Promise<SiteSummary[]> {
  return (await getStore()).listSitesByOwner(ownerId);
}
export async function listSitesForCollaborator(userId: string): Promise<SiteSummary[]> {
  return (await getStore()).listSitesForCollaborator(userId);
}
export async function createSession(input: CreateSessionInput): Promise<void> {
  return (await getStore()).createSession(input);
}
export async function getSession(id: string): Promise<Session | null> {
  return (await getStore()).getSession(id);
}
export async function touchSession(id: string, expiresAt: number, lastSeenAt: number): Promise<void> {
  return (await getStore()).touchSession(id, expiresAt, lastSeenAt);
}
export async function revokeSession(id: string): Promise<void> {
  return rbacTransaction(async () => (await getStore()).revokeSession(id));
}
/** Revoke only the credentials presented by this browser, all or nothing. */
export async function revokeBrowserSessions(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await rbacTransaction(async q => {
    const now = Date.now();
    for (const id of new Set(ids)) {
      // Use the transaction's query connection, not the store's autocommit wrapper.
      await q("UPDATE sessions SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL", [now, id]);
    }
  });
}
export async function revokeUserSessions(userId: string, exceptId: string | null = null): Promise<number> {
  return rbacTransaction(async () => (await getStore()).revokeUserSessions(userId, exceptId));
}
export async function revokeSessionsByOidcSid(sid: string): Promise<number> {
  return rbacTransaction(async () => (await getStore()).revokeSessionsByOidcSid(sid));
}
export async function createOidcFlow(input: CreateOidcFlowInput): Promise<void> {
  return (await getStore()).createOidcFlow(input);
}
export async function consumeOidcFlow(flowId: string, now: number = Date.now()): Promise<CreateOidcFlowInput | null> {
  return (await getStore()).consumeOidcFlow(flowId, now);
}

export async function insertPublishToken(t: { id: string; userId: string; name: string; createdAt: number }): Promise<void> {
  return (await getStore()).insertPublishToken(t);
}
export async function getPublishToken(id: string): Promise<PublishToken | null> {
  return (await getStore()).getPublishToken(id);
}
export async function touchPublishToken(id: string, lastUsedAt: number): Promise<void> {
  return (await getStore()).touchPublishToken(id, lastUsedAt);
}
export async function listPublishTokens(userId: string): Promise<PublishToken[]> {
  return (await getStore()).listPublishTokens(userId);
}
export async function revokePublishToken(id: string, userId: string): Promise<boolean> {
  return rbacTransaction(async () => (await getStore()).revokePublishToken(id, userId));
}
// OAuth (lib/oauth) — see the interface for the contract of each.
export async function insertOauthClient(c: OauthClientRecord): Promise<void> { return (await getStore()).insertOauthClient(c); }
export async function getOauthClient(id: string): Promise<OauthClientRecord | null> { return (await getStore()).getOauthClient(id); }
export async function touchOauthClient(id: string, now: number = Date.now()): Promise<void> { return (await getStore()).touchOauthClient(id, now); }
export async function insertOauthAuthorization(a: OauthAuthorization): Promise<void> { return (await getStore()).insertOauthAuthorization(a); }
export async function getOauthAuthorization(id: string): Promise<OauthAuthorization | null> { return (await getStore()).getOauthAuthorization(id); }
export async function approveOauthAuthorization(id: string, userId: string, code: { codeHash: string; grantId: string; expiresAt: number }, now: number = Date.now()): Promise<boolean> {
  return (await getStore()).approveOauthAuthorization(id, userId, code, now);
}
export async function consumeOauthAuthorization(id: string, now: number = Date.now()): Promise<boolean> { return (await getStore()).consumeOauthAuthorization(id, now); }
export async function redeemOauthCode(codeHash: string, now: number = Date.now()): Promise<{ authorization: OauthAuthorization; reused: boolean } | null> {
  return (await getStore()).redeemOauthCode(codeHash, now);
}
export async function insertOauthTokens(tokens: OauthToken[]): Promise<void> { return (await getStore()).insertOauthTokens(tokens); }
export async function getOauthToken(id: string): Promise<OauthToken | null> { return (await getStore()).getOauthToken(id); }
export async function touchOauthToken(id: string, now: number = Date.now()): Promise<void> { return (await getStore()).touchOauthToken(id, now); }
export async function consumeOauthRefreshToken(id: string, now: number = Date.now()): Promise<{ token: OauthToken; reused: boolean } | null> {
  return (await getStore()).consumeOauthRefreshToken(id, now);
}
export async function revokeOauthToken(id: string, now: number = Date.now()): Promise<boolean> { return rbacTransaction(async () => (await getStore()).revokeOauthToken(id, now)); }
export async function revokeOauthGrant(grantId: string, now: number = Date.now(), userId: string | null = null): Promise<number> {
  return rbacTransaction(async () => (await getStore()).revokeOauthGrant(grantId, now, userId));
}
export async function revokeOauthGrantsForClient(userId: string, clientId: string, now: number, exceptGrantId: string): Promise<number> {
  return rbacTransaction(async () => (await getStore()).revokeOauthGrantsForClient(userId, clientId, now, exceptGrantId));
}
export async function listOauthConnections(userId: string, now: number = Date.now()): Promise<OauthConnection[]> { return (await getStore()).listOauthConnections(userId, now); }
export async function revokeOauthTokensForUser(userId: string, now: number = Date.now()): Promise<number> { return rbacTransaction(async () => (await getStore()).revokeOauthTokensForUser(userId, now)); }
export async function pruneOauth(now: number = Date.now()): Promise<number> { return (await getStore()).pruneOauth(now); }
export async function claimSiteAudited(siteId: string, ownerId: string, audit: InsertAuditInput, adminLog?: AdminLogEntry): Promise<boolean> {
  return (await getStore()).claimSiteAudited(siteId, ownerId, audit, adminLog);
}
export async function insertUploadSession(u: UploadSessionRow): Promise<void> { await (await getStore()).insertUploadSession(u); }
export async function getUploadSessionRow(versionId: string): Promise<UploadSessionRow | null> { return (await getStore()).getUploadSession(versionId); }
export async function deleteUploadSession(versionId: string): Promise<void> { return (await getStore()).deleteUploadSession(versionId); }
export async function listUploadSessionsForTarget(ownerKey: string, targetSlug: string): Promise<UploadSessionRow[]> { return (await getStore()).listUploadSessionsForTarget(ownerKey, targetSlug); }
export async function listUploadSessionsBefore(createdBefore: number): Promise<UploadSessionRow[]> { return (await getStore()).listUploadSessionsBefore(createdBefore); }
export async function insertDeviceGrant(g: { deviceCode: string; userCode: string; createdAt: number; expiresAt: number }): Promise<void> {
  return (await getStore()).insertDeviceGrant(g);
}
export async function getDeviceGrant(deviceCode: string): Promise<DeviceGrant | null> {
  return (await getStore()).getDeviceGrant(deviceCode);
}
export async function approveDeviceGrant(userCode: string, userId: string, now: number = Date.now()): Promise<boolean> {
  return (await getStore()).approveDeviceGrant(userCode, userId, now);
}
export async function redeemDeviceGrant(deviceCode: string, token: { id: string; name: string }, now: number = Date.now()): Promise<string | null> {
  return (await getStore()).redeemDeviceGrant(deviceCode, token, now);
}

export async function listFolders(userId: string): Promise<UserFolder[]> {
  return (await getStore()).listFolders(userId);
}
export async function insertFolder(f: { id: string; userId: string; name: string; createdAt: number }, maxFolders: number): Promise<boolean> {
  return (await getStore()).insertFolder(f, maxFolders);
}
export async function renameFolder(id: string, userId: string, name: string, now: number = Date.now()): Promise<boolean> {
  return (await getStore()).renameFolder(id, userId, name, now);
}
export async function deleteFolder(id: string, userId: string): Promise<boolean> {
  return (await getStore()).deleteFolder(id, userId);
}
export async function listFolderAssignments(userId: string): Promise<FolderAssignment[]> {
  return (await getStore()).listFolderAssignments(userId);
}
export async function setFolderAssignment(userId: string, siteId: string, folderId: string | null, now: number = Date.now()): Promise<boolean> {
  return (await getStore()).setFolderAssignment(userId, siteId, folderId, now);
}

/** The version currently served for a slug (null if the site is missing/deleted or has none). */
export async function getCurrentVersion(slug: string): Promise<Version | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt || !site.currentVersionId) return null;
  return getVersion(site.currentVersionId);
}

// --- administration wrappers --------------------------------------------------
export async function setUserDisabled(id: string, at: number | null, reason: string | null): Promise<boolean> {
  return rbacTransaction(async () => (await getStore()).setUserDisabled(id, at, reason));
}
export async function revokePublishTokensForUser(userId: string): Promise<number> {
  return rbacTransaction(async () => (await getStore()).revokePublishTokensForUser(userId));
}
export async function setSiteTakenDown(id: string, at: number | null, reason: string | null): Promise<boolean> {
  return rbacTransaction(async () => (await getStore()).setSiteTakenDown(id, at, reason));
}
export async function restoreDeletedSite(id: string): Promise<boolean> {
  return (await getStore()).restoreDeletedSite(id);
}
export async function setSitePurged(id: string, at: number): Promise<void> {
  return rbacTransaction(async q => {
    // Purge retains the site tombstone but removes discussion content independently of audit TTL.
    const [site] = await q("SELECT id FROM sites WHERE id=$1 AND deleted_at IS NOT NULL", [id]);
    if (!site) return;
    await q("DELETE FROM reactions WHERE site_id=$1", [id]);
    await q("DELETE FROM comment_read_scopes WHERE site_id=$1", [id]);
    await q("DELETE FROM comment_spaces WHERE site_id=$1", [id]);
    await q("DELETE FROM site_comment_settings WHERE site_id=$1", [id]);
    // Search text is content too. Keep both row and SQLite FTS cleanup in this transaction.
    await q("DELETE FROM site_texts WHERE site_id=$1", [id]);
    if (config.dbDriver === "sqlite") {
      await q("DELETE FROM site_texts_fts WHERE site_id=$1", [id]);
    }
    await q("UPDATE sites SET purged_at=$1 WHERE id=$2 AND purged_at IS NULL AND deleted_at IS NOT NULL", [at,id]);
  });
}
export async function listDeletedSitesBefore(before: number, limit = 100): Promise<Site[]> {
  return (await getStore()).listDeletedSitesBefore(before, limit);
}
export async function insertAdminLog(entry: AdminLogEntry): Promise<void> {
  return (await getStore()).insertAdminLog(entry);
}
export async function listAdminLog(opts: { targetId?: string | null; limit?: number } = {}): Promise<AdminLogEntry[]> {
  return (await getStore()).listAdminLog({ targetId: opts.targetId ?? null, limit: opts.limit ?? 50 });
}
export async function adminOverview(): Promise<AdminOverview> {
  return (await getStore()).adminOverview();
}
export async function listUsersAdmin(opts: AdminUserQuery): Promise<{ rows: AdminUserRow[]; total: number }> {
  return (await getStore()).listUsersAdmin(opts);
}
export async function listSitesAdmin(opts: AdminSiteQuery): Promise<{ rows: AdminSiteRow[]; total: number }> {
  return (await getStore()).listSitesAdmin(opts);
}

// --- quotas and expiry wrappers ------------------------------------------------
export async function ownerUsage(owner: QuotaOwner): Promise<{ sites: number; bytes: number }> {
  return (await getStore()).ownerUsage(owner);
}
export async function expireAnonymousSites(before: number, now = Date.now(), limit = 500): Promise<Site[]> {
  return (await getStore()).expireAnonymousSites(before, now, limit);
}
export async function hasRecentAdminLog(actorUserId: string, action: AdminAction, targetId: string, since: number): Promise<boolean> {
  return (await getStore()).hasRecentAdminLog(actorUserId, action, targetId, since);
}
export async function upsertSiteText(write: SiteTextWrite): Promise<boolean> {
  return (await getStore()).upsertSiteText(write);
}
export async function updateSiteTextTitle(siteId: string, title: string, titleTokens: string): Promise<boolean> {
  return (await getStore()).updateSiteTextTitle(siteId, title, titleTokens);
}
export async function getSiteText(siteId: string): Promise<SiteTextRow | null> {
  return (await getStore()).getSiteText(siteId);
}
export async function searchSiteTexts(viewer: ListViewer | undefined, tokens: SearchToken[], limit: number): Promise<SearchHit[]> {
  return (await getStore()).searchSiteTexts(viewer, tokens, limit);
}
export async function listSitesNeedingText(limit: number): Promise<{ siteId: string; versionId: string }[]> {
  return (await getStore()).listSitesNeedingText(limit);
}
export async function listSettings(scope: string): Promise<SettingRow[]> {
  return (await getStore()).listSettings(scope);
}
export async function writeSettings(scope: string, writes: SettingWrite[], updatedBy: string | null, now = Date.now()): Promise<void> {
  return (await getStore()).writeSettings(scope, writes, updatedBy, now);
}

export async function compareUploadSessionFiles(versionId: string, before: UploadSessionRow["files"], after: UploadSessionRow["files"]): Promise<boolean> { return (await getStore()).compareUploadSessionFiles(versionId, before, after); }

/** Internal, parameterized metadata access for the shared RBAC repository. */
export async function rbacQuery(...args: Parameters<RbacQuery>): ReturnType<RbacQuery> { return (await getStore()).rbacQuery(...args); }
export async function rbacTransaction<T>(work: (q: RbacQuery) => Promise<T>): Promise<T> { return (await getStore()).rbacTransaction(work); }

/** Management-only projection. Callers must authorize and explicitly omit token/hash fields. */
export async function listShareRows(siteId: string): Promise<ShareRow[]> {
  return (await rbacQuery(listSharesQuery("$1"), [siteId])).map(toShareRow);
}
