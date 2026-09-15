// Domain — the whole product in two nouns: a Site points at its current Version;
// each Version is an immutable directory snapshot on disk. No git, no build, no jobs.

/** single = one index.html (edited whole); folder = a tree of files (edited by path);
 *  document = an uploaded pdf/office file wrapped in a generated viewer page (not editable —
 *  updating means re-uploading, which lands a new version like any other site). */
export type SiteKind = "single" | "folder" | "document";

/** The document formats a single-file drop may carry. Office formats get a server-side PDF
 *  conversion when a converter is configured; pdf needs none. */
export type DocumentFormat = "pdf" | "pptx" | "ppt" | "docx" | "doc";

/** What a document upload was, kept on the normalized result so the create path can run the
 *  office→pdf conversion AFTER normalization and rebuild the wrapper with a preview. */
export interface DocumentMeta {
  format: DocumentFormat;
  /** The uploaded file's own name (display + download name), e.g. "quarterly-report.pptx". */
  originalName: string;
  /** Where the original landed inside the version tree, e.g. "original/quarterly-report.pptx". */
  originalRelpath: string;
}
/**
 * How a version came to be: the original drop (`upload`), an in-browser save (`edit`),
 * the first snapshot of a duplicated site (`fork`), a forward-only restore of an earlier
 * version (`rollback`), or the output of a server-side build of dropped source (`build`).
 * Every source produces a normal immutable version row.
 */
export type VersionSource = "upload" | "edit" | "fork" | "rollback" | "build";

/**
 * Who may READ a site through its own address, `/s/<slug>`.
 *
 *   public    anyone, and it appears in the home directory
 *   unlisted  anyone with the link; absent from the directory
 *   private   owner and collaborators only — readers must come through a share link
 *
 * `private` is what makes shares mean anything: leave the site's own door open and a share that
 * says "signed-in only" restricts nothing, because the content is still one URL away.
 */
export type Visibility = "public" | "unlisted" | "private";

/**
 * How a share link decides who may open it. One of four, never a combination — a single choice is
 * what an owner can actually reason about when deciding where a link may be forwarded.
 *
 *   public    no gate at all. What an anonymous publish produces, and today's whole behaviour.
 *   login     any signed-in user. The default when a signed-in owner mints a share.
 *   people    an explicit list (accounts, plus e-mail addresses that have not signed in yet).
 *   passcode  anyone holding the link AND the code. The only tier that works for someone with
 *             no account at all, which is why it exists despite being the weakest.
 */
export type SharePolicy = "public" | "login" | "people" | "passcode";

/** Every policy, in the order the API documents them. The one list the server validates against. */
export const SHARE_POLICIES: readonly SharePolicy[] = ["public", "login", "people", "passcode"];

/**
 * The three share-link lifetimes on offer. A free-form number is deliberately refused: the UI would
 * have to pick defaults anyway, and "expires in 3650 days" is a permanent link wearing a costume.
 * Absent means never — a deliberate choice the owner makes, not something a forgotten field decides.
 */
export const EXPIRY_DAYS: readonly number[] = [7, 30, 90];

/**
 * A share link: an object in its own right, not a field on the site. That is what lets one artifact
 * carry several links with different audiences, lets a link be revoked without touching the site,
 * and lets a view be attributed to the link it came through rather than just to the site.
 *
 * `token` never appears here — only its hash is stored, so a read-only dump of the database cannot
 * reconstruct a working link. Same shape as sessions.
 */
export interface Share {
  mode: import("@/lib/rbac").ShareMode;
  /** null follows current; a value restricts the link to that snapshot. */
  versionId: string | null;
  id: string;
  siteId: string;
  policy: SharePolicy;
  /** Owner-facing note («for the client»). Never shown to readers. */
  label: string | null;
  /** Whether a passcode is set. The code itself is only ever stored hashed. */
  hasPasscode: boolean;
  /**
   * Q&A mode: readers arriving through THIS link get the embedded assistant (ask/summarize only —
   * no edit coordinates ever leave the host for them, and the write APIs would refuse them
   * anyway). Off by default: an AI affordance on someone else's screen is the owner's call.
   */
  allowAi: boolean;
  createdBy: string | null;
  createdAnonId: string | null;
  createdAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  revokedAt: number | null;
}

/** One entry on a `people` share. Exactly one of userId / email is set. */
export interface ShareGrant {
  shareId: string;
  /** Set when the person has signed in here before. */
  userId: string | null;
  /** Set when they have not: matched against their VERIFIED e-mail when they eventually sign in. */
  email: string | null;
  /** Filled in for display when userId is set. */
  displayName?: string | null;
  grantedAt: number;
}

/** A share as the storage layer holds it: `Share` plus the two secrets, which never leave lib/. */
export interface ShareRow extends Share {
  tokenHash: string;
  passcodeHash: string | null;
}

export interface InsertShareInput {
  mode?: import("@/lib/rbac").ShareMode;
  versionId?: string | null;
  id: string;
  siteId: string;
  tokenHash: string;
  policy: SharePolicy;
  passcodeHash: string | null;
  label: string | null;
  createdBy: string | null;
  createdAnonId: string | null;
  expiresAt: number | null;
  allowAi?: boolean;
}

/** A single opening of a share link. Sub-resource requests are not views — see recordShareView. */
export interface ShareView {
  shareId: string;
  siteId: string;
  userId: string | null;
  anonId: string | null;
  ip: string | null;
  userAgent: string | null;
  viewedAt: number;
}

/**
 * A single opening of the site's own address (/s/<slug>) — the direct-visit counterpart of
 * ShareView. Separate table on purpose: share_views is an access log for a *credential* (the
 * link), this is traffic on the site itself, and folding the two would force shareId nullable
 * on every existing row and reader. They meet only in the read-side aggregates below.
 */
export interface SiteView {
  siteId: string;
  userId: string | null;
  anonId: string | null;
  ip: string | null;
  userAgent: string | null;
  viewedAt: number;
}

/** One opening of the site's content, whichever door it came through. null shareId = direct /s/. */
export interface SiteOpen extends SiteView {
  shareId: string | null;
}

/** Aggregates over BOTH tables. `uniqueViewers` keys on account, else browser, else IP — a row
 *  with none of the three counts toward `opens` but cannot be attributed to a "viewer". */
export interface SiteViewStats {
  opens: number;
  uniqueViewers: number;
  /** Newest opening across all time (not clipped to the stats window), or null if never opened. */
  lastViewedAt: number | null;
}

/**
 * Who — BEYOND the owner and explicit collaborators — may edit. `owner` = nobody else (a
 * read-only share); `login` = any signed-in user.
 *
 * There is deliberately no anonymous tier: an edit nobody can attribute leaves
 * `versions.created_by` empty, which makes ownership, audit and revocation meaningless.
 * Creating a site stays anonymous (that is the product's hero flow) and reading stays fully
 * anonymous — the asymmetry is the whole point.
 */
export type EditPolicy = "owner" | "login";

/**
 * Graded write permission. The authz layer resolves a request to one of these and each route
 * declares the level it needs — a plain boolean cannot express "may edit content but must not
 * delete the site", which is exactly the boundary `login`/`link` shares depend on.
 */
export type Capability = "none" | "content" | "manage" | "owner";

/** A hosted front-end site. `currentVersionId` points at the version served at /s/<slug>. */
export interface Site {
  /** Organization owning this resource. */
  tenantId: string;
  id: string;
  slug: string;
  title: string;
  kind: SiteKind;
  currentVersionId: string;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete tombstone. The files stay for `config.deletedRetentionMs` so an administrator
   *  can restore the site; after that a purge removes them and sets `purgedAt`. */
  deletedAt: number | null;
  /** Set once the deleted site's files are gone for good; a purged site cannot be restored. */
  purgedAt: number | null;
  /** Administrative takedown: the site stays in place for its owner but is served to nobody else. */
  takenDownAt: number | null;
  /** Visible to the owner and administrators only — never rendered to a visitor. */
  takenDownReason: string | null;
  /**
   * DEPRECATED — no longer an authorization credential. Editing requires a signed-in account, so
   * a bearer capability that anyone could forward cannot be honoured. The column survives only so
   * pre-identity rows keep round-tripping; nothing in the authz path reads it.
   */
  editToken: string;
  /**
   * Claim receipt, minted when a site is created anonymously and kept only in that browser's
   * localStorage. Redeeming it on first sign-in attaches the site to that account.
   *
   * Safe as ownership proof precisely because nothing broadcasts it: with editing governed by
   * `editPolicy` + collaborators, there is no "copy editable link" affordance to mail it around
   * — which is exactly why the older, broadcast `editToken` could never serve this role.
   */
  claimToken: string;
  /** Owner account; null until an anonymously-created site is claimed. */
  ownerId: string | null;
  /**
   * Anonymous owner: the random id in the creating browser's cookie. Lets an anonymous creator
   * keep editing their own site with no account, and lets sign-in migrate every site from that
   * browser in one statement. Never the client IP — behind a gateway all visitors share one.
   */
  anonOwnerId: string | null;
  visibility: Visibility;
  editPolicy: EditPolicy;
}

/** An account. Identity source is pluggable: (authProvider, providerSubject) is the only join key
 *  to the IdP — never the email, which would let an attacker pre-register a victim's address. */
export interface User {
  id: string;
  /** Default tenant for creation; authorization uses tenant_members. */
  tenantId: string | null;
  authProvider: string;
  providerSubject: string;
  email: string | null;
  /** Only a verified address may be matched against invites or shown as an identity. */
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  /** Administrative disable: sign-in is refused, sessions and publish tokens were revoked. */
  disabledAt: number | null;
  disabledReason: string | null;
}

/** A browser login. Stateful so it can be revoked the instant a grant is withdrawn.
 *  `id` is the sha256 of the cookie secret — the DB never holds a usable credential. */
export interface Session {
  id: string;
  userId: string;
  /** OIDC `sid` claim, so a back-channel logout can revoke this exact session. */
  oidcSid: string | null;
  createdAt: number;
  /** Sliding expiry, always clamped to absoluteExpiresAt. */
  expiresAt: number;
  /** Hard ceiling set at login — without it a stolen cookie renews itself forever. */
  absoluteExpiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  ip: string | null;
  userAgent: string | null;
  /**
   * Set only on a session synthesised from an OAuth access token (lib/oauth): what the person
   * granted the application. Absent — a browser login, a publish token — means everything the
   * account may do. Enforced by lib/session on mutating requests and by /mcp per tool.
   */
  scopes?: readonly string[];
}

// --- OAuth (remote MCP clients such as ChatGPT; see lib/oauth) ------------------------------------

export type OauthTokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** A dynamically registered client (RFC 7591). Metadata-document clients are never stored. */
export interface OauthClientRecord {
  id: string;
  /** sha256 of the secret, for confidential clients; null for public ones. */
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OauthTokenEndpointAuthMethod;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * One authorization request, from the consent page to the redeemed code. `id` is the unguessable
 * request id the consent form carries; `codeHash` is set when the person allows it and is the
 * only way the token endpoint can find the row. `grantId` ties the tokens minted from it together.
 */
export interface OauthAuthorization {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  userId: string;
  codeHash: string | null;
  grantId: string | null;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  consumedAt: number | null;
}

/** An access or refresh token. `id` is the sha256 of the bearer secret, as for every credential here. */
export interface OauthToken {
  id: string;
  kind: "access" | "refresh";
  grantId: string;
  userId: string;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  /** When the grant was approved — carried across refreshes so "connected since" stays put. */
  grantCreatedAt: number;
  createdAt: number;
  expiresAt: number;
  /** The grant's hard ceiling, fixed at consent and inherited by every refresh. */
  absoluteExpiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** A live grant as the account page shows it: one row per connected application. */
export interface OauthConnection {
  id: string;
  clientId: string;
  clientName: string;
  scope: string;
  connectedAt: number;
  lastUsedAt: number | null;
}

/** An explicit per-user grant. Collaborators always outrank `editPolicy`. */
export interface SiteCollaborator {
  siteId: string;
  userId: string;
  role: "admin" | "editor";
  grantedBy: string | null;
  grantedAt: number;
}

// --- audit --------------------------------------------------------------------
//
// Who did a thing, recorded for real. This is NOT versions.created_by: that column is a FK to
// users (so it cannot hold an anonymous or token-bearing actor), it is set to NULL when a user is
// deleted, and claiming a site backfills it — rewriting every anonymous edit to look like the
// claimant's. None of that can carry an audit trail. The audit_log is append-only, keyed on plain
// strings (no FK, survives deletion), and never rewritten, so "it was anonymous at the time" stays
// true forever.

/** How much we can say about who acted. `legacy-token` = only a pre-identity edit token was held. */
export type EditorKind = "user" | "anon" | "legacy-token" | "admin";

/** The resolved actor behind a request, for attribution. `userId`/`anonId` are best-effort: under
 *  the legacy (no-enforcement) regime a shared token collapses several people to `legacy-token`. */
export interface Actor {
  kind: EditorKind;
  userId: string | null;
  anonId: string | null;
}

/** What happened. Only version-producing actions are recorded atomically; the rest are best-effort. */
export type AuditAction =
  | "create" | "edit" | "rollback" | "fork" | "rename" | "delete" | "share" | "collab"
  // Ownership changes are recorded for accountability.
  | "claim" | "transfer" | "disown";

/** How a content change was made — the source editor, the visual editor, or the raw API. */
export type EditMethod = "source" | "visual" | "api";

export interface AuditEntry {
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
  createdAt: number;
}

/** An immutable snapshot. Files live at <dataDir>/sites/<siteId>/<versionId>/<relpath…>. */
export interface Version {
  id: string;
  siteId: string;
  /** Entry HTML relative to the version root (default "index.html"). */
  entry: string;
  fileCount: number;
  byteSize: number;
  source: VersionSource;
  createdAt: number;
}

/** A version row plus whether it is the one currently served — the shape the history UI wants. */
export type VersionInfo = Version & { current: boolean };

/** Site + its current version + how many versions it has — the shape the list UI wants. */
export interface SiteSummary {
  slug: string;
  title: string;
  kind: SiteKind;
  /**
   * The list must make "can this be shown to people" visible. Without it, a screen of sites all look
   * alike while half of them would hand the recipient a 404 — that is exactly how the incident
   * happened: nothing at share time hinted that the site was private.
   *
   * **Optional, because "Recently viewed" has no way of knowing**: that list is rebuilt from this
   * browser's local records, which hold only what was seen at the time (slug, title). When missing,
   * show no label at all and never fill in a default — labelling a private site "public" would make
   * someone send it out with more confidence, which is far worse than no label.
   */
  visibility?: Visibility;
  entry: string;
  versionCount: number;
  createdAt: number;
  updatedAt: number;
  /** Present on owner-scoped lists so "My sites" can mark a taken-down site; absent elsewhere. */
  takenDownAt?: number | null;
}

// --- upload pipeline ----------------------------------------------------------

/** One file destined for a version: a safe relative path + its raw bytes. */
export interface UploadFile {
  relpath: string;
  bytes: Uint8Array;
}

/** The four ways a finished front-end enters the system (POST /api/sites). */
export type UploadInput =
  | { mode: "paste"; html: string; title?: string }
  | { mode: "file"; filename: string; bytes: Uint8Array; title?: string }
  | { mode: "folder"; files: UploadFile[]; title?: string }
  | { mode: "zip"; bytes: Uint8Array; title?: string };

/** Normalized result of parsing any UploadInput — ready to store as a version. */
export interface NormalizedUpload {
  kind: SiteKind;
  entry: string;
  title: string;
  files: UploadFile[];
  /** Present iff kind === "document". `files` already holds the no-conversion outcome (pdf:
   *  viewer wrapper; office: download card) — a converter that produces a preview rebuilds
   *  them via buildDocumentFiles with the same meta. */
  document?: DocumentMeta;
}

/** Edit payload: single sites replace the whole document; folder sites replace one file. */
export type EditInput = { content: string } | { path: string; content: string };

// --- administration ---------------------------------------------------------------

/** `system` = the process itself (the hourly maintenance tick), nobody at a keyboard. */
export type AdminActorKind = "token" | "user" | "system";
export type AdminAction =
  | "user.disable" | "user.enable"
  | "site.assign_owner" | "site.take_down" | "site.restore" | "site.delete" | "site.undelete" | "site.view"
  | "maintenance.purge_deleted" | "maintenance.sweep_uploads" | "maintenance.reconcile" | "maintenance.expire_anonymous"
  | "maintenance.backfill_text" | "maintenance.prune_audit"
  | "settings.update";

/** One administrative act. Separate from the per-site audit trail: half of these have no site. */
export interface AdminLogEntry {
  id: string;
  actorKind: AdminActorKind;
  actorUserId: string | null;
  action: AdminAction;
  targetKind: "user" | "site" | "system";
  targetId: string;
  reason: string | null;
  ip: string | null;
  createdAt: number;
}

export interface AdminOverview {
  users: number;
  disabledUsers: number;
  sites: number;
  anonymousSites: number;
  takenDownSites: number;
  /** Soft-deleted and still restorable (files not yet purged). */
  deletedSites: number;
  /** Bytes of every stored version, purged sites excluded. */
  byteTotal: number;
}

export interface AdminUserRow extends User {
  siteCount: number;
  byteTotal: number;
}

export interface AdminSiteRow extends Site {
  ownerEmail: string | null;
  ownerName: string | null;
  versionCount: number;
  byteTotal: number;
}

export type AdminSiteState = "live" | "taken_down" | "deleted";

/** One write to the settings table: a JSON value, or null to remove the row. */
export interface SettingWrite { key: string; value: string | null }

/** One console-set value. `scope` is "global" until tenants exist. */
export interface SettingRow {
  scope: string;
  key: string;
  /** JSON-encoded value. */
  value: string;
  updatedAt: number;
  updatedBy: string | null;
}
