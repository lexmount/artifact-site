# Comment implementation contract

Status: foundation (#135), basic comments (#139), and anchored comments (#140) are merged.
The current increment adds selection-to-comment, explicit creation destinations and stable reading.
`src/lib/comments/contracts.ts` remains the shared wire contract; `validation.ts` guards paths and
`permissions.ts` evaluates server-produced facts. The published HTML discussion specification is
the product reference; its illustrative schemas and early mockup controls are superseded by the
reviewed contract and explicit first-release limits below.

## Delivery boundary

The sidebar redesign reuses the existing discussion spaces, messages, transactions and RBAC.
It retains the manager-only options endpoint, safe display names and tab-local draft recovery.
Migration `0006-comment-engagement` adds authenticated emoji reactions and private reading progress;
no new comment-access grant is introduced. Notifications, search, mentions, screenshots and
automated Agent writes remain outside this increment.

## Scope and identity

A discussion space is `(siteId, versionId, entry)`; entry is either `main` or a stable `shareId`.
Version IDs are immutable and mandatory even for whole-document comments. A following share permits
the latest and currently designated official versions, matching artifact read access. Each still
has a separate immutable space. Visitors lose access to previous-version threads, including their
own, when those versions are neither latest nor official, unless separately authorized. The UI must explain this and
allow managers to return to the original version; never silently relocate threads. A pinned share
stays on its version. Different shares never share threads. The token is a credential, never the
space ID. Tenant ownership is inherited from the site (including the existing `init` and `anonymous`
tenants), not copied from a visitor.

No anonymous message creation, reply, editing, deletion or resolution, including anonymous owners
and accountless operator credentials. An authorized anonymous comment/edit-share visitor can read that share discussion only.
Anonymous main-link readers cannot read main-discussion messages, even on public sites.
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
   latest and official snapshots allowed by the artifact read gate; it does not grant arbitrary
   history access.
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
| Reserved `/comments/:threadId/context-assets/:assetId` | Not implemented in this release | No image producer or asset read route |
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
The basic PR supplies numbered migrations under the existing advisory lock and runs the comment
service and authorization suites against PostgreSQL in CI. See `docs/MIGRATIONS.md`.

| Table | Columns and invariants |
| --- | --- |
| `site_comment_settings` | `site_id` PK/FK sites, `main_policy` CHECK off/login/members DEFAULT login, `updated_by` users FK, `updated_at`. Absence means login. |
| `comment_spaces` | `id` PK, `site_id`, `version_id`, `kind` main/share, `share_id` nullable, `created_at`. Composite FKs `(site_id, version_id)` to versions and `(site_id, share_id)` to site_shares prevent foreign-site references. Main iff share_id is null. |
| `comment_threads` | `id` PK, `space_id` FK, `created_by` users FK NOT NULL, `anchor` JSONB, `context_snapshot` JSONB, `status` open/resolved, `resolved_by/at`, `revision`, `created_at`, `updated_at`. Open has no resolution metadata; resolved has both fields. File path lives inside anchor, not a second mutable column. |
| `comment_messages` | `id` PK, `thread_id` FK, `author_user_id` users FK NOT NULL, `is_root`, `body`, `client_request_id`, `request_fingerprint`, `revision`, `created_at`, `edited_at`, `deleted_at/by`. Live body is nonblank; deleted body is NULL and tombstone actor/time are present. |
| `comment_context_assets` | `id` PK, `message_id` FK, `kind`, private unique `storage_key`, `mime_type`, positive `byte_size/pixel_width/pixel_height`, SHA-256 digest, `created_at/deleted_at`. Only PNG/JPEG/WebP; storage keys never appear in public DTOs. |
| `reactions` | Future extensible site/message target with FK, kind=like, either logged-in user or anonymous actor hash, `created_at`. Site targets remain enabled here; message emoji use the separate `comment_reactions` table and authenticated comment permissions. |

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

When configured, `ARTIFACT_PUBLIC_URL` restricts preview-to-parent events to the deployment's
origin. With it unset, `parent.postMessage(..., "*")` targets the immediate parent window with
no origin restriction; it does not broadcast to unrelated windows. Preview routes intentionally
allow external embedding (no `frame-ancestors` restriction), so an external embedder can then
initiate the preview handshake and receive location events for its own embedded artifact. Such
a handshake grants no comment-read or mutation permission: credentials and discussion text stay
in the authorized host, and every API request is independently checked. Set `ARTIFACT_PUBLIC_URL`
when deployment policy requires location events to be delivered only to the first-party viewer.

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
Automatic edits, publishing, resolving, attachments, mentions and notifications are
not part of the first release.

## Acceptance before subsequent merges

- Basic: live credential resolution/revocation, both stores, repeat migrations, atomic root creation,
  idempotency conflicts, stale edits, soft deletion and private asset access, CSRF/token scopes,
  pagination, main/share/version isolation and anonymous rejection. UI checks cover hidden defaults,
  focus, drafts, disabled actions and whole-file flows. Unit contracts are not API integration tests.
- Anchored: browser tests for iframe spoof/stale messages, scroll/resize/zoom/rotation, missing
  selectors, PDF bounds, Office fallback, old-version switching, aggregation scope, and Agent export
  boundaries. Run against the real basic API before merging; mocks alone do not constitute acceptance.

## Basic implementation details

- `GET /comments/permissions?versionId=...&shareId=...` returns server-computed permissions and
  `isAuthenticated` without disclosing counts or messages. Artifact read access is required;
  comment read access is not, allowing the viewer to show a sign-in prompt.
- Space lists additionally return these permissions. Paginated message results additionally
  return `permissions`, keyed by message ID. Messages may include `authorDisplayName`; emails
  and avatar markup are never returned as participant labels.
- `GET /likes` and `PUT /likes` (`{ liked: boolean }`) return `{ count, liked }`. Likes are
  site-wide and idempotent; anonymous actors use a separate signed, host-scoped HTTP-only like cookie. Browser login
  atomically adopts the current site’s anonymous like and removes any duplicate.
- Request bodies are streamed with a 64 KiB ceiling. All comment responses, including errors,
  are private/no-store. Root/request replay fingerprints use a persistent private HMAC key in
  `comment_secrets`, independent of preview-key rotation. Digests remain until site purge;
  deleted message plaintext is cleared immediately.
- Context-asset metadata is reserved, but this PR creates no image assets and exposes no upload
  endpoint. No screenshot bytes are stored in public artifact directories. Before any later
  producer is enabled, it must supply private storage, authorized reads, and retryable cleanup.
- Site purge removes messages, threads, spaces, reactions, and settings while retaining the site
  tombstone. Soft deletion and share revocation only restrict access. Mutations write text-free
  RBAC audit records, subject to the existing independently configurable audit retention policy.

## Anchored implementation and acceptance

- `/s/:slug` and `/v/:token` share the same anchored controller. Marker visibility is independent
  of the panel: enabling it fetches authorized threads even while the panel stays closed. Both
  remain hidden on a fresh page. A per-load channel binds the actual iframe Window, exact scope,
  expected selection state and pending location. Old callbacks, unsolicited marker IDs and events
  above 64 KiB are rejected. Marker commands are bounded at 100 entries/1 MiB. Marker clusters
  open a keyboard-accessible chooser for their members. Comment bodies and author identities are
  not sent into the uploaded artifact; the chooser uses saved artifact location excerpts.
- Host-initiated navigation starts a fresh handshake immediately; old-document acknowledgements
  cannot satisfy the new target. The sandbox acknowledges readiness after DOM parsing, without
  waiting for images or fonts. Slow loads keep their queued location: after five seconds the UI
  reports that loading continues, and a later handshake resumes placement. Retries stop on success
  or unmount. After iframe `load`, eight unanswered attempts stop retries and mark positioning
  unavailable; saved comment context remains readable. A location request still performs at most
  one automatic navigation, including when the current document cannot bridge. The root layout
  records iframe load events before hydration for both main and shared viewers in a weak reference
  set, so a late-mounted workspace can arm the cutoff without reading the sandbox DOM or mistaking a new iframe for a loaded one.
- The dormant preview bridge emits nothing until the host handshakes. The host owns drafts and
  submissions. It never sends login/share credentials over the bridge. HTML capture and matching
  use the same whitespace-normalized, form/script-free text. Missing selectors or changed text
  produce `missing`, not guessed placement. Embedded images use intrinsic bounds; `contain`
  padding is excluded. An authorized `__artifact_image=1` preview wrapper lets image-only targets
  retain the sandbox bridge when opening their original location. This does not relax CSP or
  change raw image resource responses.
- PDF.js canvases expose their rendered page number, immutable PDF path and page rotation.
  Coordinates reverse rotation and viewport geometry into the unrotated crop box. Server parsing
  verifies the actual page count before writing; PDFs above the existing 40 MiB parsing limit
  reject location capture with an explicit whole-document alternative. Office PDF renditions
  retain the original file path and SHA-256; no-conversion download cards use whole-file comments.
- CSRF, rate limit and identity preflight happen before any potentially expensive evidence read.
  Matching request-ID retries skip evidence reads; the transaction still checks the stored digest.
  The short write transaction still revalidates account, site, version, share and action rights.
  HTML evidence is verified against bounded stored text; PDF excerpts are extracted near the
  selected region. No client HTML, form values, raw DOM, private storage keys or credentials are
  assembled into context.
- `/s/:slug/comments` redirects old bookmarks to `/s/:slug?comments=all`, preserving a valid
  selected thread ID. The main artifact gate and comment API still authorize every read.
  The sidebar keeps list and detail as separate views; source/version/status/author filters are
  available to managers, and selection opens the original immutable version/file before locating.
  The viewer's version label, editor link and source download follow the displayed historical
  version. Returning restores the original current-version file. Main/share discussion scopes
  remain distinct even when their rows are shown together.
- Agent bundles are currently single-thread, paginated read-only data with `dataTrust=untrusted`,
  original/latest version IDs, exact scope, anchors, bounded evidence and independent source/edit
  capabilities. Continuations are relative authenticated message routes, not credential URLs.
  Deleting a root clears text evidence and root content from bundles while preserving replies.
- Region screenshots are **explicitly unsupported** in this release (`captureStatus=unsupported`),
  surfaced in the original-context UI. No screenshots or user attachments are stored, so there is
  no new asset producer or public resource outlet. Notifications, mentions,
  automatic Agent edits/publishing/resolution remain disabled. `result_version_id` is nullable and
  reserved; no mutation accepts it. A future association action must verify same-site provenance.
- `0002-comment-review-indexes` adds creation/author indexes and the reserved result-version FK,
  using the existing migration transaction/lock and checksum history. The existing first migration
  is untouched. Repeated migration execution and schema parity are covered in the shared suite.

Verification commands (use isolated test data/DB; do not point them at a live deployment):

```sh
npm test
npm run typecheck
npm run lint
npm run build
make test-pg
COMMENT_PREVIEW_E2E=1 npx vitest run test/comment-preview.e2e.test.ts
# Against a production build + disposable Postgres, sharing its isolated storage directory:
# Start that isolated server with ARTIFACT_RATE_LIMIT_BURST=200 for the write-heavy fixture suite.
COMMENTS_E2E_URL=http://127.0.0.1:4392 COMMENTS_E2E_DATA=.data/comment-browser \
  ARTIFACT_DB_DRIVER=postgres ARTIFACT_DATABASE_URL=... \
  npx vitest run test/comments-browser.e2e.test.ts
```

The live suite creates actual HTML/image/PDF/Office artifacts, posts through real comment routes,
checks hidden defaults, persisted PDF page coordinates, Office fallback, original-version review,
and narrow-screen overflow. Browser artifacts are local acceptance output, not committed assets.
Unit/route suites additionally cover source/channel/scope guards, normalization and rotations,
share revocation, author/sort cursor isolation, deleted evidence and separate Agent capabilities.

## Unified discussion sidebar

- Managers with `canAggregate` see all discussions for the displayed version by default on `/s`.
  They can select all versions, one version, main discussion, one share, thread author and status, plus activity/creation sorting.
  `/v` stays isolated even for owners. `/comments/options` authorizes before returning version
  entries, share labels and thread-author names; it never returns share credentials.
- Each thread retains its source. Reply, edit, delete and resolve act on that thread's permissions.
  New top-level comments belong to the current main/share scope. While viewing history, new
  top-level creation is hidden until returning; replies still belong to the historical thread.
- The right dock gives the artifact its own remaining width on desktop. Below 900px it becomes a
  bottom sheet. The list shows author, body, quoted context, source and reply count; detail has
  inline reply/edit and secondary actions in menus. Green accents use the existing project tokens.
  Marker visibility remains independent and defaults off. Selection hides the panel on narrow screens, uses a
  bubble-plus cursor, highlights the hovered element and offers a whole-file fallback. Located
  anchors briefly highlight; overlapping pins open a chooser. Motion honors reduced-motion settings.
- Background refresh preserves the current surface without repeated loading banners. New threads
  appear behind an explicit update button; list/detail navigation retains list scroll. Request
  sequencing rejects stale responses. Access failures clear stale rows/selection.
- Drafts live in `sessionStorage` under an account/site bucket, further keyed by immutable version,
  main/share entry, operation and thread/message. At most 32 nonempty drafts per bucket are retained
  for seven days, bounded by the existing body limit. Refreshing restores an eligible draft;
  closing/switching saves it, **Discard draft** removes it, and successful submission clears it.
  Private browsing/quota failures leave the in-memory draft and show an explicit notice.
  Draft recovery is per tab, not cross-device synchronization, and does not carry credentials.
  Account changes remount the workspace; previous-account drafts remain in their isolated
  namespace for that account to recover. Only drafts accessible from the current viewer
  auto-open the panel or defer automatic refresh. Explicit comment links take precedence over
  unrelated drafts, which remain available from Saved drafts. Share create drafts resume
  in their original share viewer; the main viewer only lists drafts it can actually restore. Displaced unselected rows are
  revalidated at most once per minute while regular list and selected-thread refreshes remain
  frequent; transient polling failures retain readable content and do not replace save errors.
- Failed submissions retain their request ID for an idempotent retry, including after reload.
  Editing after a failed submission starts a new request identity. Revision conflicts preserve
  text and require explicit adoption of the fresh revision, including reopening an edit draft; removed write permissions are checked
  again by the server. Saved drafts (including closed composers) and historical review defer
  automatic artifact-version refreshes. Explicit refresh, rollback and upload flush drafts first;
  storage failure blocks page navigation with a visible notice, while in-panel actions remain usable. Saved drafts can be resumed in their
  original version from the sidebar. Storage writes are debounced while typing and flushed before
  navigation, scope changes or unload; an in-memory copy survives storage errors.
- End discussion (the existing resolve operation) displays its actor and time, retains the detail even under an open-only list filter and
  offers Undo (the existing reopen action with fresh revision checks). The resolver display name
  is visible to authorized human readers of that discussion, including share readers; Agent
  context exports omit display names and retain only stable actor IDs. Deleted message text remains
  a tombstone so replies keep context.

Acceptance adds real-browser reload/retry, inline reply, resolve/undo, historical filters and
mobile geometry checks to the original HTML/image/PDF/Office and sandbox-navigation cases. The
standalone sandbox suite also checks the custom cursor and overlapping-pin chooser. Screenshot
outputs stay local under `output/acceptance/` and are not committed.


Agent context exposes `artifact.latestVersionId` only when the requesting identity can read
that version through its current entrance; otherwise it is `null`. In particular, a fixed
snapshot share does not reveal a later, ungranted version identifier.

## Reactions and reading progress

Each visible message (root or reply) supports a complete Unicode emoji sequence.
Six shortcuts open into a lazy-loaded full picker with categories, English-keyword search,
recent selections and skin tones. Native glyphs need no third-party image requests.
Migration `0006-comment-engagement` creates bounded Unicode reaction storage; the API and service validate one complete emoji (including ZWJ and flags). Readers receive counts
and their own selection; authenticated users with reply permission can set an explicit desired
state using `PUT /api/sites/:slug/comments/:threadId/messages/:messageId/reactions` with
`{ emoji, reacted }`. The server derives the actor, validates the current entry permissions in
its transaction, and rejects deleted messages. Reactions neither update thread activity nor
create unread events. Migration `0006-comment-engagement` adds `comment_reactions`, keyed by
message/account/emoji. Equivalent presentation-selector forms share one canonical bucket.
Standalone emoji components are rejected. Each account can add 12 distinct reactions to a
message, with 64 distinct reaction types across all accounts per message. These limits bound
the chips, not the picker catalog; the existing anonymous-capable site-like table remains independent.

`GET /api/sites/:slug/comments/unread` takes `versionId`, optional `shareId`, optional server-clock `since` for anonymous readers, and
`aggregate=true` (management access through the main entry only). It returns at most 1,000
unread message references, a `hasMore` flag, and a snapshot timestamp; no comment text is
included. GET is read-only and uses no RBAC write lock; an authenticated POST establishes the first-visit historical baseline. Only new, non-deleted messages
by other accounts count, not edits, status changes, likes, or reactions. Share entries stay
isolated by link and version. The owner aggregate includes authorized versions and discussions.

For accounts, `comment_read_scopes` stores a monotonic baseline per site/entry, and
`comment_read_messages` stores exact viewed-message receipts. A POST to the same route accepts
at most 100 `messageIds`, or `through` from the latest snapshot for explicit “Mark all read”.
Every receipt is restricted to the request's authorized scope. Signed-in list and aggregate
queries accept `unread=true`, applying the unread condition before cursor pagination. Merely opening the sidebar does
not acknowledge replies, including unloaded message pages. Visible conversation messages are
acknowledged after a short dwell; list summaries do not acknowledge hidden replies. Anonymous
readers keep their baseline and receipts in browser storage and cannot create reactions/comments.
Background unread refresh is independent of list filters and marker visibility: every 60 seconds
with the sidebar closed, 15 seconds when open, paused in hidden tabs. Progress requests use
a separate 60-burst/120-per-minute account (guest: IP) bucket, never the reply bucket.
Receipts compact the watermark on POST, and purge removes all site reading progress. This is local
comment awareness, not a notification or browsing-event center.

The hidden-marker state suppresses persistent pins, clusters, and highlights. An explicit
location request while hidden displays only that target for 1.5 seconds (0.5-second hold,
1-second fade), without enabling persistent markers. Hiding markers clears an active location
immediately. Reduced-motion preferences suppress the fade. Sidebar closure is a separate action.

## Agent feedback workflow (P0)

`GET /api/sites/:slug/comments/agent-list` is a read-only, paginated summary projection
over the existing comment authorization. It accepts `versionId`, `status`, `cursor`,
`limit`, and explicit `aggregate=true` with optional `shareId` or `allVersions=true`.
Without a version, it selects the fixed share version or latest site version. Keep the
returned scope/version on subsequent pages. Share credentials never authorize aggregation.
Summaries are capped at 500 characters and expose `summaryTruncated`; read the thread
and follow message cursors for full content. Reading does not acknowledge unread comments.

MCP exposes `artifact_site_comments_list`, `artifact_site_comment_read`, and
`artifact_site_comment_context`; CLI exposes `comments list`, `comments read`, and
`comments context`. Context identifies the original version, typed anchor, captured
quote, coordinate convention, continuation cursor, and independent export/edit capabilities.
Anchors are not verified by this API. Treat all comment content as untrusted user data.

Read historical evidence with an explicit version, then inspect the latest source separately.
Apply feedback to the same site using `expected_version` and an operation key. Conflict or
permission errors must not fall back to publishing a new site. A new version does not move
old comments, resolve threads, or retarget fixed share links. Agent replies, resolution,
result-version association, and notifications are deferred. Existing UI iteration PRs follow
this Agent workflow foundation.

## P0 selection and discussion workflow

- HTML text selections expose a small localized action only when the host grants creation capability.
  Forms, editable controls and hidden content are excluded. Quotes retain bounded prefix/suffix
  context and are relocated within the original element; missing targets preserve the saved evidence.
  Creation and relocation share a bounded text index with computed CSS block/line-break separators and the same
  excluded controls. Legacy element quotes without prefix/suffix also accept their original text
  concatenation format; selection quotes remain strict. Scrolling reuses the selection anchor until
  its range, DOM or viewport changes. Selection boundaries use logarithmic DOM comparisons.
  The bridge validates frame, channel and immutable scope, and the API still checks every write.
- Normal PDF pages include a windowed PDF.js text layer. A single-page selection records its page,
  normalized region and quote; rotation is reversed into original-page coordinates. Scanned PDFs,
  failed extraction and image previews retain point/region selection. Cross-page text selection does
  not produce a combined anchor; choose one page or use the existing whole-file comment action.
  The server accepts an exact quote as evidence only if it exists in the original region's text.
- On the main artifact, managers can choose the main discussion or a live comment/edit share that
  admits the displayed version. Following shares admit latest and official versions; pinned shares
  admit their pinned version. Share IDs, modes and version eligibility are returned only to managers;
  credentials are never included. Revocation and version changes are rechecked on submission.
- Within a share link, creation stays in that share. Replies/editing always retain their thread's
  scope. Existing comments are never copied, moved or exposed to another discussion. Sharing shows
  a brief isolation explanation and an Open discussion link, rather than repeating the destination
  in every share composer.
- Creation drafts include their destination in the existing draft identity. Changing position keeps
  that destination. Switching discussions restores that destination's body, anchor and request ID;
  a new destination starts with an empty body. If the current body is empty, its freshly selected
  position takes precedence when loading another destination's body; a changed anchor resets the
  request identity. Switching also persists the active nonempty draft
  before a reload, without deleting independent drafts in other discussions. Restoring a draft checks the target discussion's current permissions; unavailable
  drafts remain stored. Historical recovery links identify the exact draft without including its body.
  The recovery parameter is consumed only after authorization and persistence of the complete active
  draft (including its request identity); storage failures retain the parameter. This ensures later
  destination changes and reloads follow the active draft rather than the original recovery link.
- Cards prioritize author/time, body and reactions, followed by a short citation and file/page origin.
  Citation actions locate the original target; context and management actions stay in menus.
- Quiet refresh retains already displayed unread discussions after they are read, in their previous
  order. Explicit refresh/filter changes apply the latest unread membership. Retained rows are still
  permission-revalidated; request generations prevent older responses from replacing newer state.

No schema migration or new permission is needed. Attachments, rich text, search, mentions,
notifications and cross-version resolution associations remain later increments.
