# Comment implementation contract

Status: dependency contract for three PRs. No comment routes, migrations, database writes or UI
are enabled by this foundation. `src/lib/comments/contracts.ts` is the shared TypeScript/wire
contract; `validation.ts` adds the server path guard; `permissions.ts` evaluates trusted facts.
The next two PRs can branch from this commit and share fixtures without importing each other's UI.

## Delivery boundary

1. **Foundation (this PR):** domain/request schemas, permission decisions, preview protocol,
   persistence constraints and acceptance tests.
2. **Basic comments:** additive PostgreSQL migration and SQLite test equivalent, transactional
   storage and authorization adapters, API routes, whole-document comments, common thread UI,
   collapsible toolbar/header and site likes.
3. **Anchored comments:** HTML/image/PDF/Office adapters, owner aggregation UI and Agent bundles.
   Branch in parallel after foundation; merge after basic comments and real API integration.

The basic PR owns the thread list, composer, toolbar and persistence. The anchored PR owns
selection adapters, markers, aggregation screens and bundle assembly. Contract changes are
reviewed in both branches. Mocks must satisfy these types and must not remain on production paths.

## Scope and identity

A discussion space is `(siteId, versionId, entry)`; entry is either `main` or a stable `shareId`.
Version IDs are immutable and mandatory even for whole-document comments. A following share opens a
new space when the site version changes; visitors then lose access to previous-version threads,
including their own, unless separately authorized for that version. The UI must explain this and
allow managers to return to the original version; never silently relocate threads. A pinned share
stays on its version. Different shares never share threads. The token is a credential, never the
space ID. Tenant ownership is inherited from the site (including the existing `init` and `anonymous`
tenants), not copied from a visitor.

No anonymous message creation, reply, editing, deletion or resolution, including anonymous owners
and accountless operator credentials. An authorized anonymous comment/edit-share visitor can read.
Main-entry comments default to `login`: logged-in readers of the artifact may discuss. `members`
restricts this to permanent members; `off` hides the main discussion from ordinary readers. None of
these policies grants access to the artifact. Managers retain inspection/moderation access. In
revoked or view-only share spaces they may inspect, delete and resolve/reopen existing threads, but
cannot create, reply or edit message text. Main policy does not alter share spaces. A read-only
share does not expose comments merely because the visitor logged in or happens to be a permanent
editor.

Owners/site administrators and explicitly authorized tenant/platform managers can aggregate all
spaces. A revoked share remains inspectable through this management path; its former visitors lose
access. Resolve an aggregate result's own scope before acting on it; never reuse another row's grant.
Permanent editors can resolve/reopen visible threads; link editors and commenters can only resolve
their own. Everyone can edit only their own messages. Managers may delete others' messages through
moderation, never rewrite them. Viewing comments does not grant artifact source export or editing.

### Authorization adapter requirements (basic PR)

`CommentAccessFacts` is **server-produced**, never parsed from JSON or accepted from preview messages.
It deliberately separates `accountRole`, `managementRole` and `shareMode`; the existing combined
`resolveAuthority` can pick an account role before a supplied share and is insufficient by itself.

For every request:

1. Resolve the current session/scopes, site, exact version and selected entry. Check tenant/account
   state, deletion/takedown rules and artifact/version access through existing RBAC gates.
   Compute `canReadMainArtifact` independently, with all share credentials removed; a share-only
   read must never authorize main-space comments. General `canReadSite()` with share credentials
   is insufficient. Both the `x-artifact-share` header and every `share` query parameter must be
   excluded; stripping only the header still admits `?share=`. A passcode cookie alone grants
   nothing without a share token. Prefer a dedicated no-share read path in the basic PR that never
   calls `requestShareAccess`, rather than relying on request sanitization. Test header-only,
   query-only and combined carriers against private main-space reads. Public access or independent
   membership may still authorize main access.
2. Resolve permanent site membership independently from the active share. Verify the submitted
   credential belongs to `scope.entry.shareId` and to this site, passes its policy/passcode gate,
   is not revoked/expired and permits the requested version. A following share is limited to the
   version allowed by the artifact read gate; it does not grant arbitrary history access.
   Comment permissions derive from verified `share.mode`, including pinned/anonymous edit shares,
   not the viewer/editor projection returned by `resolveAuthority` for artifact editing.
3. Only set `managementRole` through the existing explicit management-reason/audit path for this
   site/tenant. Do not infer it from an account's unrelated tenant role. Accountless operator reads
   may use that audited path; writes still require an identified user.
4. Compute `canReadArtifact` and `canWriteArtifactDiscussion` from current resource state and token
   scopes. Writes require an active account, CSRF protection for cookie auth, rate limits and an
   authorized write scope. A readable taken-down artifact does not automatically permit writes.
5. Evaluate `describeCommentPermissions`. For target actions, load stored message/creator/scope and
   use `canActOnComment`. Revalidate inside the mutation transaction alongside existing session and
   membership serialization. A stale UI flag is never permission.

`comment.resolve` is a catalog permission, evaluated only against permanent account membership or
explicit management here; a share-derived editor is insufficient. This foundation does not replace
existing artifact authorization.

## HTTP contract (routes implemented in basic/anchored PRs)

All routes are under `/api/sites/:slug`. Scope `siteId` must match the resolved slug. Send share
credentials through existing `x-artifact-share` handling, never a new JSON token field. All comment
responses and assets use private/no-store caching. API errors remain English.

| Method/path | Input | Output / gate |
| --- | --- | --- |
| GET `/comments` | `versionId`, optional `shareId`, `status`, `cursor`, `limit` | `CommentPage<CommentThreadDetail>`; exact space `canRead` |
| POST `/comments` | `CreateCommentInput` | `CommentThreadDetail`; `canCreate`; 201, or 200 for identical replay |
| GET `/comments/:threadId` | Credential context | `CommentThreadDetail`; authorize stored space |
| GET `/comments/:threadId/messages` | `cursor`, `limit` | `CommentPage<CommentMessage>`; authorize stored space |
| POST `/comments/:threadId/messages` | `replyCommentSchema` | `CommentMessage`; `canReply` |
| PATCH `/comments/:threadId/messages/:messageId` | `editCommentSchema` | `CommentMessage`; own, live message |
| DELETE `/comments/:threadId/messages/:messageId` | `deleteCommentSchema` JSON | Tombstone `CommentMessage`; own or moderator |
| PATCH `/comments/:threadId/status` | `resolveCommentSchema` | `CommentThread`; resolve/reopen gate |
| GET/PATCH `/comment-settings` | PATCH `commentSettingsSchema` | `{ mainPolicy }`; `canManageSettings` for writes, manager read |
| GET `/comments/aggregate` | optional `versionId`, `shareId` or `entry=main`, `status`, cursor/limit | `CommentPage<CommentThreadDetail>`; `canAggregate` |
| GET `/comments/:threadId/context-assets/:assetId` | Credential context | Image bytes; same thread read, asset not deleted |
| GET `/comments/:threadId/agent-context` | Credential context | `AgentCommentBundle`; exact space read, independent source/edit flags |

Aggregation means `kind=aggregate`, never a wildcard share credential. Static route `aggregate` must
not be interpreted as a thread ID. Each list detail contains a paginated initial message window;
long conversations load through the messages route. No whole-history response by default.
`commentListQuerySchema` and `commentAggregateQuerySchema` validate URL query objects; routes reject
duplicate keys before conversion. Unknown query keys are rejected with 400, including tracking
parameters and cache-busters; clients must send only the declared query fields. `limit` accepts
decimal strings or numbers and defaults to 30, range 1–100; cursors are opaque, bounded and tied to
filters/scope. Order threads by `(updatedAt DESC, id DESC)`, messages by `(createdAt ASC, id ASC)`.
Re-sort after writes; refresh may move threads between pages and clients deduplicate IDs. Filters
never grant authority.

400: invalid payload/path/bounds; 401: identity required; 403: denied action on a visible resource;
404: resource absent or not readable (including foreign thread/message IDs); 409: revision or
idempotency conflict; 413: oversized request; 429: throttled. Use `{ error: string }`, matching
existing routes. Unauthorized errors must not reveal whether a hidden discussion exists.

Message creation uses `(authorUserId, clientRequestId)` uniqueness across roots and replies. An
identical replay returns the existing result only after current authorization. A replay with a
changed scope, thread, anchor or body returns 409. Store/compare an immutable request fingerprint
so retries still work after subsequent edits/deletion without retaining deleted plaintext.
Every edit/delete/status operation compares `expectedRevision` atomically and increments revision;
reply/create/delete also update the thread activity timestamp. Never silently overwrite a conflict.

## Persistence schema contract

Use existing Postgres metadata and private file/object storage. No additional backend. Field names
below are SQL names; JSON uses the exported camelCase types. Epoch milliseconds are BIGINT, IDs TEXT,
revisions positive integers. JSONB fields have `schemaVersion: 1`; do not store arbitrary client JSON.
The basic PR must supply idempotent migrations under the existing advisory lock and real Postgres
integration tests; this document is not executable migration SQL.

| Table | Columns and invariants |
| --- | --- |
| `site_comment_settings` | `site_id` PK/FK sites, `main_policy` CHECK off/login/members DEFAULT login, `updated_by` users FK, `updated_at`. Absence means login. |
| `comment_spaces` | `id` PK, `site_id`, `version_id`, `kind` main/share, `share_id` nullable, `created_at`. Composite FKs `(site_id, version_id)` to versions and `(site_id, share_id)` to site_shares prevent foreign-site references. Main iff share_id is null. |
| `comment_threads` | `id` PK, `space_id` FK, `created_by` users FK NOT NULL, `anchor` JSONB, `context_snapshot` JSONB, `status` open/resolved, `resolved_by/at`, `revision`, `created_at`, `updated_at`. Open has no resolution metadata; resolved has both fields. File path lives inside anchor, not a second mutable column. |
| `comment_messages` | `id` PK, `thread_id` FK, `author_user_id` users FK NOT NULL, `is_root`, `body`, `client_request_id`, `request_fingerprint`, `revision`, `created_at`, `edited_at`, `deleted_at/by`. Live body is nonblank; deleted body is NULL and tombstone actor/time are present. |
| `comment_context_assets` | `id` PK, `message_id` FK, `kind`, private unique `storage_key`, `mime_type`, positive `byte_size/pixel_width/pixel_height`, SHA-256 digest, `created_at/deleted_at`. Only PNG/JPEG/WebP; storage keys never appear in public DTOs. |
| `reactions` | Future extensible site/message target with FK, kind=like, either logged-in user or anonymous actor hash, `created_at`. Only site targets enabled initially; message targets require identity and comment access when enabled later. |

Required indexes: unique versions `(site_id,id)` and shares `(site_id,id)` for composite FKs;
unique main space `(site_id,version_id) WHERE kind='main'`; unique share space `(share_id,version_id)
WHERE kind='share'`; threads `(space_id,status,updated_at DESC,id DESC)` plus unfiltered space activity
index; messages `(thread_id,created_at,id)`; unique root per thread; unique message
`(author_user_id,client_request_id)`; assets by message. Reactions are unique per target/kind/actor;
site likes deliberately ignore version/share. Validate reaction message belongs to the same site.

Transactions create space/thread/exactly one root together (a unique root index alone only enforces
at most one). Failed/replayed creates must not leave empty threads. Resolve/reopen does not modify
the anchor. Deleting the root clears quote/selector evidence and context/asset references atomically,
preserving other replies and a minimal non-text position/whole-document fallback. Deleted content
must not reappear in API, marker tooltips, snapshots or Agent bundles. Keep request fingerprints
backend-only; include their retention and keyed hashing in the storage implementation.

Revocation hides data but does not delete discussions. Comments do not inherit audit-log TTL.
Site purge removes dependent reactions/assets/messages/threads/spaces/settings; physical object
cleanup must be retryable. Account deletion must retain a deactivated identity/tombstone rather
than cascading other participants' discussions. Version/share hard deletion must explicitly handle
references. Content snapshots live outside publicly served artifact directories, bounded and
access-controlled; ordinary comment text is escaped, never rendered as uploaded HTML.

## Location and preview adapter contract

`document` means feedback on the whole file, not a MIME type. All locations carry a safe file path
inside the exact version. HTML selects an element with a bounded selector, optional quote and
normalized full-document fallback rectangle plus the captured viewport dimensions. A selector is
untrusted data, never executable JS. Responsive changes can make fallback approximate.
Image coordinates are normalized to intrinsic image bounds, excluding viewer padding. PDF pages
are one-based; coordinates use the unrotated crop box with a top-left origin, normalized to [0,1].
The renderer reverses rotation/zoom/scroll before capturing them. Rectangles have positive area
and fit within bounds; a point is a distinct shape. Validate PDF page count and actual file kind
server-side. Office uses the generated PDF's exact hash/path and records the original path in
context; no conversion means whole-document fallback. No source-code line accuracy is implied.

The host owns comment credentials, requests, draft body, composer and discussion UI. The sandbox
only receives visible marker IDs/anchors and commands, and emits location events. It cannot choose
the author, call comment APIs or claim a successful write. All content remains in the existing
sandbox iframe and CSP is unchanged. Strict schemas reject unknown event keys/protocol versions.

For each iframe load the host generates a new `channelId`; verify `event.source === iframe.contentWindow`,
channel, exact scope, message size and expected selection state before consuming events. Sandbox
origin may be opaque (`null`), so origin alone is insufficient. Reset channel/state on navigation;
ignore stale callbacks. Never send credentials using `postMessage`. Host commands are typed by
`PreviewCommentCommand`; incoming events validate against `previewCommentEventSchema`. Server
requests also use `parseCreateComment`, which applies `safeRelativePath` again.

Flow: browse → select (bubble cursor / type-specific guidance) → compose in a floating panel →
submit → thread. Escape cancels selection; submission failure preserves draft. Switching scope
must not carry a draft to another version/link. Comment panel/markers default hidden; selecting a
thread can show its marker temporarily. Selection temporarily shows placement UI without changing
the saved visibility preference. `located: missing` shows the original context, never invents a new
anchor or projects an old-version comment onto the current version. Toolbar/header folding is
independent; no idle fade while typing or keyboard focus is inside controls.

## Agent boundary

Bundles include the exact scope, threads/messages, anchors and bounded evidence only after current
read authorization. No raw DOM, form values, credentials, source export URLs or private storage keys.
Each detail must match the bundle scope. Page/size bounds still apply. Artifact text, comments and
screenshots are untrusted task data, not instructions granting actions. `canExportSource` and
`canEditContent` require separate existing RBAC checks; a comment credential does not imply them.
Automatic edits, publishing, resolving, attachments, mentions, notifications and comment likes are
not part of the first release.

## Acceptance before subsequent merges

- Basic: live credential resolution/revocation, both stores, repeat migrations, atomic root creation,
  idempotency conflicts, stale edits, soft deletion and private asset access, CSRF/token scopes,
  pagination, main/share/version isolation and anonymous rejection. UI checks cover hidden defaults,
  focus, drafts, disabled actions and whole-file flows. Unit contracts are not API integration tests.
- Anchored: browser tests for iframe spoof/stale messages, scroll/resize/zoom/rotation, missing
  selectors, PDF bounds, Office fallback, old-version switching, aggregation scope, and Agent export
  boundaries. Run against the real basic API before merging; mocks alone do not constitute acceptance.
