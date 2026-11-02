// Shared metadata contracts, identifiers, row mappings, and pure query helpers.
// Adapters depend on this module without loading the active-store facade.
import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuditAction,
  AuditEntry,
  EditMethod,
  EditorKind,
  Share,
  SharePolicy,
  ShareRow,
  ShareView,
  Session,
  Site,
  SiteKind,
  SiteOpen,
  SiteSummary,
  User,
  Version,
  VersionSource,
  Visibility,
  AdminLogEntry,
  AdminOverview,
  AdminSiteRow,
  AdminSiteState,
  AdminUserRow,
  SettingRow,
  OauthAuthorization,
  OauthClientRecord,
  OauthConnection,
  OauthToken,
} from "@/lib/types";

export type Row = Record<string, unknown>;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Short, URL-safe, unguessable slug for /s/<slug>. */
export function createSlug(): string {
  return randomBytes(9).toString("base64url");
}

/** Per-site edit token — 24 url-safe chars of entropy, minted once at site creation. */
export function createEditToken(): string {
  return randomBytes(18).toString("base64url");
}

// --- row mappers (shared: both backends return snake_case columns; ints, not bigint strings) ---

export function toSite(row: Row): Site {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    slug: row.slug as string,
    title: row.title as string,
    kind: row.kind as SiteKind,
    currentVersionId: (row.current_version_id as string | null) ?? "",
    officialVersionId: (row.official_version_id as string | null) ?? null,
    officialSetAt: row.official_set_at == null ? null : Number(row.official_set_at),
    officialSetBy: (row.official_set_by as string | null) ?? null,
    officialRevision: Number(row.official_revision ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    purgedAt: row.purged_at == null ? null : Number(row.purged_at),
    takenDownAt: row.taken_down_at == null ? null : Number(row.taken_down_at),
    takenDownReason: (row.taken_down_reason as string | null) ?? null,
    editToken: (row.edit_token as string | null) ?? "",
    ownerId: (row.owner_id as string | null) ?? null,
    anonOwnerId: (row.anon_owner_id as string | null) ?? null,
    // Defaults mirror the DDL so a row read before the migration lands still maps cleanly.
    visibility: ((row.visibility as string | null) ?? "public") as Visibility,
  };
}

export function toUser(row: Row): User {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string | null) ?? null,
    authProvider: row.auth_provider as string,
    providerSubject: row.provider_subject as string,
    email: (row.email as string | null) ?? null,
    // SQLite has no boolean type — it round-trips 0/1, so coerce rather than cast.
    emailVerified: Boolean(row.email_verified),
    displayName: (row.display_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
    disabledAt: row.disabled_at == null ? null : Number(row.disabled_at),
    disabledReason: (row.disabled_reason as string | null) ?? null,
  };
}

export function toSession(row: Row): Session {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    oidcSid: (row.oidc_sid as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
  };
}

export function toPublishToken(row: Row): PublishToken {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

const optionalTime = (value: unknown): number | null => (value == null ? null : Number(value));

export function toOauthClient(row: Row): OauthClientRecord {
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(String(row.redirect_uris ?? "[]")) as unknown;
    if (Array.isArray(parsed)) redirectUris = parsed.filter((v): v is string => typeof v === "string");
  } catch { /* a corrupt row registers nowhere to redirect to, which fails closed */ }
  return {
    id: row.id as string,
    secretHash: (row.secret_hash as string | null) ?? null,
    name: row.name as string,
    redirectUris,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method as OauthClientRecord["tokenEndpointAuthMethod"],
    createdAt: Number(row.created_at),
    lastUsedAt: optionalTime(row.last_used_at),
  };
}

export function toOauthAuthorization(row: Row): OauthAuthorization {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    clientName: row.client_name as string,
    redirectUri: row.redirect_uri as string,
    scope: row.scope as string,
    state: (row.state as string | null) ?? null,
    codeChallenge: row.code_challenge as string,
    resource: row.resource as string,
    userId: row.user_id as string,
    codeHash: (row.code_hash as string | null) ?? null,
    grantId: (row.grant_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    approvedAt: optionalTime(row.approved_at),
    consumedAt: optionalTime(row.consumed_at),
  };
}

export function toOauthToken(row: Row): OauthToken {
  return {
    id: row.id as string,
    kind: row.kind as OauthToken["kind"],
    grantId: row.grant_id as string,
    userId: row.user_id as string,
    clientId: row.client_id as string,
    clientName: row.client_name as string,
    scope: row.scope as string,
    resource: row.resource as string,
    grantCreatedAt: Number(row.grant_created_at),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    lastUsedAt: optionalTime(row.last_used_at),
    revokedAt: optionalTime(row.revoked_at),
  };
}

export function toOauthConnection(row: Row): OauthConnection {
  return {
    id: row.grant_id as string,
    clientId: row.client_id as string,
    clientName: row.client_name as string,
    scope: row.scope as string,
    connectedAt: Number(row.connected_at),
    lastUsedAt: optionalTime(row.last_used_at),
  };
}

export function toDeviceGrant(row: Row): DeviceGrant {
  return {
    deviceCode: row.device_code as string,
    userCode: row.user_code as string,
    status: row.status as DeviceGrant["status"],
    userId: (row.user_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
  };
}

export function toVersion(row: Row): Version {
  return {
    ...(row.package_meta ? { packageMeta: JSON.parse(String(row.package_meta)) } : {}),
    id: row.id as string,
    siteId: row.site_id as string,
    entry: row.entry as string,
    fileCount: Number(row.file_count),
    byteSize: Number(row.byte_size),
    source: row.source as VersionSource,
    createdAt: Number(row.created_at),
  };
}

export function toAudit(row: Row): AuditEntry {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    versionId: (row.version_id as string | null) ?? null,
    action: row.action as AuditAction,
    editorKind: row.editor_kind as EditorKind,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    actorAnonId: (row.actor_anon_id as string | null) ?? null,
    method: (row.method as EditMethod | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

/** One row of a chunked-upload session. `ownerKey` is whoever opened the session (`u:<userId>` or
 *  `a:<anonId>`), and every later PUT / commit has to match it — otherwise anyone holding the
 *  versionId could push files into someone else's upload. */
export interface UploadSessionRow {
  packageOptions?: import("@/lib/package-contract").PackageOptions;
  tenantId?: string;
  versionId: string; siteId: string; targetSlug?: string | null; title?: string | null;
  ownerKey: string; files: { relpath: string; bytes: number; sha256?: string }[]; createdAt: number;
}
export function toUploadSession(row: Row): UploadSessionRow {
  let files: UploadSessionRow["files"] = [];
  try { files = JSON.parse(String(row.files ?? "[]")) as UploadSessionRow["files"]; } catch { /* a corrupt row counts as empty */ }
  return {
    tenantId: (row.tenant_id as string | undefined) ?? undefined,
    versionId: row.version_id as string, siteId: row.site_id as string,
    targetSlug: (row.target_slug as string | null) ?? null, title: (row.title as string | null) ?? null,
    packageOptions: row.package_options ? JSON.parse(String(row.package_options)) : undefined,
    ownerKey: row.owner_key as string, files, createdAt: Number(row.created_at),
  };
}

export function toSummary(row: Row): SiteSummary {
  return {
    ...(row.total_views != null ? { totalViews: Number(row.total_views) } : {}),
    officialVersionId: (row.official_version_id as string | null) ?? null,
    officialVersionNumber: row.official_version_id ? Number(row.official_version_number) : null,
    slug: row.slug as string,
    title: row.title as string,
    kind: row.kind as SiteKind,
    // This column may be empty on old rows; use the same default as the COALESCE in the list query,
    // so one row cannot reach different conclusions for "can it be listed" and "what is it labelled".
    visibility: ((row.visibility as string | null) ?? "public") as Visibility,
    entry: (row.entry as string | null) ?? "index.html",
    versionCount: Number(row.version_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...("taken_down_at" in row ? { takenDownAt: row.taken_down_at == null ? null : Number(row.taken_down_at) } : {}),
  };
}

// --- backend interface + selection -------------------------------------------

export interface InsertSiteInput { tenantId?: string; id: string; slug: string; title: string; kind: SiteKind; editToken: string; anonOwnerId?: string | null; ownerId?: string | null; visibility: Visibility }

/**
 * Who is asking for the site directory — the two ways someone can own a site, mirroring the anon/
 * account split in lib/authz.ts. Both fields absent (or null) is the anonymous stranger, and that
 * is the case the visibility filter is written for: NULL never equals a column value, so a viewer
 * with nothing to prove sees exactly the public rows and no exception widens that.
 */
export interface ListViewer {
  /** Signed-in account id, from the session cookie. */
  userId?: string | null;
  /** This browser's anonymous id, from the anon cookie. Only counts while the site is unowned. */
  anonId?: string | null;
}
export interface UpsertUserInput {
  /** Explicit public name, never a login identifier fallback. Null clears a previous name. */
  publicDisplayName?: string | null;
  authProvider: string; providerSubject: string;
  email?: string | null; emailVerified?: boolean;
  displayName?: string | null; avatarUrl?: string | null;
  /** Temporary OIDC-cutover bridge; remove after all active accounts have migrated. */
  migrateVerifiedEmail?: boolean;
}
/** `id` is the sha256 of the cookie secret — never the secret itself (see lib/session.ts). */
export interface CreateSessionInput {
  id: string; userId: string; oidcSid?: string | null;
  expiresAt: number; absoluteExpiresAt: number;
  ip?: string | null; userAgent?: string | null;
}
export interface CreateOidcFlowInput {
  flowId: string; verifier: string; nonce: string; returnTo: string; expiresAt: number;
}
export interface InsertVersionInput { packageMeta?: import("@/lib/package-contract").PackageMeta; official?: boolean; id: string; siteId: string; entry: string; fileCount: number; byteSize: number; source: VersionSource }

/** An audit row to write. `createdAt` is stamped inside the transaction so it matches the version. */
export interface InsertAuditInput {
  /** Request-local proof; never persisted or returned by the store. */
  authorizationRequest?: Request;
  sourceSiteId?: string;
  id: string;
  siteId: string;
  versionId: string | null;
  action: AuditAction;
  editorKind: EditorKind;
  actorUserId: string | null;
  actorAnonId: string | null;
  method: EditMethod | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Outcome of a compare-and-set version commit.
 * - `applied`  — written and now current.
 * - `stale`    — the site moved on (someone edited/rolled back since); nothing written.
 * - `gone`     — the site is missing or soft-deleted; nothing written.
 */
export type VersionCommit = "applied" | "stale" | "gone";

/** The slug UNIQUE constraint fired — the caller should regenerate the slug and retry. */
export class SlugConflictError extends Error {
  constructor() {
    super("slug conflict");
    this.name = "SlugConflictError";
  }
}

/** The device-grant user_code UNIQUE constraint fired — regenerate the code and retry. Only this
 *  error is worth retrying; a connection failure from the same insert is not. */
export class UserCodeConflictError extends Error {
  constructor() {
    super("user code conflict");
    this.name = "UserCodeConflictError";
  }
}

/** Whose quota: a signed-in account, or an anonymous browser. */
export type QuotaOwner = { userId: string; anonId?: null } | { userId?: null; anonId: string };

export interface AdminUserQuery {
  /** Substring of e-mail or display name, case-insensitive. */
  q: string;
  sort: "recent" | "storage" | "sites";
  disabledOnly: boolean;
  limit: number;
  offset: number;
}

export interface AdminSiteQuery {
  /** Substring of title, slug or owner e-mail. */
  q: string;
  ownerId: string | null;
  anonymousOnly: boolean;
  state: AdminSiteState;
  limit: number;
  offset: number;
}

/** What lib/site-text stores for a site's current version. Tokens are pre-computed there (see tokenize). */
// Revision 1 repairs the PDF worker packaging failure. Older cached bodies are re-extracted
// lazily; this also gives future extractor fixes a bounded backfill instead of a startup scan.
export const SITE_TEXT_EXTRACTOR_VERSION = 1;
export interface SiteTextWrite {
  siteId: string; versionId: string; title: string; body: string;
  titleTokens: string; bodyTokens: string; extractedAt: number; extractorVersion: number;
}
export interface SiteTextRow { siteId: string; versionId: string; title: string; body: string; chars: number; extractedAt: number; extractorVersion: number }
/** One query token; `prefix` matches every indexed token that starts with it (a lone CJK character against bigrams). */
export interface SearchToken { text: string; prefix: boolean }
/** A search hit: the summary columns plus the opening of the body, from which the caller cuts the snippet. */
export type SiteRelationship = "owned" | "collaborating" | "anonymous" | "public";
export interface SearchHit { relationship: SiteRelationship; slug: string; title: string; kind: SiteKind; visibility: Visibility; takenDownAt: number | null; updatedAt: number; body: string }

/** Row → Share, shared by both backends so the two cannot drift on shape. */
export function toShareRow(row: Row): ShareRow {
  return {
    revision: Number(row.revision ?? 0),
    mode: (row.mode ?? "view") as Share["mode"],
    versionId: (row.version_id as string | null) ?? null,

    id: row.id as string,
    siteId: row.site_id as string,
    tokenHash: row.token_hash as string,
    token: (row.token as string | null) ?? null,
    policy: row.policy as SharePolicy,
    passcodeHash: (row.passcode_hash as string | null) ?? null,
    hasPasscode: Boolean(row.passcode_hash),
    allowAi: Boolean(row.allow_ai), // column arrived by migration; absent maps to false
    source: row.source === "publish" || row.source === "manual" ? row.source : null,
    label: (row.label as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAnonId: (row.created_anon as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

/** The owner-facing projection: the two hashes never leave the storage layer. */
export function toShare(row: Row): Share {
  const { tokenHash: _t, passcodeHash: _p, token: _secret, ...rest } = toShareRow(row);
  void _t; void _p; void _secret;
  return rest;
}

export function toShareView(row: Row): ShareView {
  return {
    shareId: row.share_id as string,
    siteId: row.site_id as string,
    userId: (row.user_id as string | null) ?? null,
    anonId: (row.anon_id as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    viewedAt: Number(row.viewed_at),
  };
}

/** Row of the two-table union → SiteOpen. Identical to toShareView except shareId may be null
 *  (a direct /s/ opening has no share). Shared by both backends so the union shape cannot drift. */
export function toSiteOpen(row: Row): SiteOpen {
  return {
    shareId: (row.share_id as string | null) ?? null,
    siteId: row.site_id as string,
    userId: (row.user_id as string | null) ?? null,
    anonId: (row.anon_id as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    viewedAt: Number(row.viewed_at),
  };
}

export interface UserFolder {
  id: string;
  userId: string;
  name: string;
  sort: number;
  createdAt: number;
}

export interface FolderAssignment {
  siteId: string;
  slug: string;
  folderId: string;
}

export function toUserFolder(row: Row): UserFolder {
  return { id: row.id as string, userId: row.user_id as string, name: row.name as string, sort: Number(row.sort), createdAt: Number(row.created_at) };
}

export interface PublishToken {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  status: "pending" | "approved" | "consumed";
  userId: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

// --- administration mappers ----------------------------------------------------
export function toAdminLog(row: Row): AdminLogEntry {
  return {
    id: row.id as string,
    actorKind: row.actor_kind as AdminLogEntry["actorKind"],
    actorUserId: (row.actor_user_id as string | null) ?? null,
    action: row.action as AdminLogEntry["action"],
    targetKind: row.target_kind as AdminLogEntry["targetKind"],
    targetId: row.target_id as string,
    reason: (row.reason as string | null) ?? null,
    ip: (row.ip as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}
export function toAdminOverview(row: Row): AdminOverview {
  return {
    users: Number(row.users ?? 0), disabledUsers: Number(row.disabled_users ?? 0),
    sites: Number(row.sites ?? 0), anonymousSites: Number(row.anonymous_sites ?? 0),
    takenDownSites: Number(row.taken_down_sites ?? 0), deletedSites: Number(row.deleted_sites ?? 0),
    byteTotal: Number(row.byte_total ?? 0),
  };
}
export function toAdminUserRow(row: Row): AdminUserRow {
  return { ...toUser(row), siteCount: Number(row.site_count ?? 0), byteTotal: Number(row.byte_total ?? 0) };
}
export function toAdminSiteRow(row: Row): AdminSiteRow {
  return {
    ...toSite(row),
    ownerEmail: (row.owner_email as string | null) ?? null,
    ownerName: (row.owner_name as string | null) ?? null,
    versionCount: Number(row.version_count ?? 0),
    byteTotal: Number(row.byte_total ?? 0),
  };
}
/** ORDER BY for the admin user list — a fixed vocabulary, never user text (it is spliced into SQL). */
export function adminUserOrder(sort: AdminUserQuery["sort"]): string {
  switch (sort) {
    case "storage": return "byte_total DESC";
    case "sites": return "site_count DESC";
    default: return "COALESCE(u.last_login_at, 0) DESC";
  }
}
/** `%q%` with LIKE's wildcards escaped, lower-cased to pair with lower(column) on both backends. */
export function likeContains(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

export function toSiteText(r: Row): SiteTextRow {
  return { siteId: String(r.site_id), versionId: String(r.version_id), title: String(r.title), body: String(r.body), chars: Number(r.chars), extractedAt: Number(r.extracted_at), extractorVersion: Number(r.extractor_version ?? 0) };
}
export function toSearchHit(r: Row): SearchHit {
  return { relationship: r.relationship as SiteRelationship, slug: String(r.slug), title: String(r.title), kind: r.kind as SiteKind, visibility: ((r.visibility as string | null) ?? "public") as Visibility, takenDownAt: r.taken_down_at == null ? null : Number(r.taken_down_at), updatedAt: Number(r.updated_at), body: String(r.body) };
}
export function toSettingRow(row: Row): SettingRow {
  return { scope: row.scope as string, key: row.key as string, value: row.value as string, updatedAt: Number(row.updated_at), updatedBy: (row.updated_by as string | null) ?? null };
}
