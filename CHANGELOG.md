# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow semver. Tagging `vX.Y.Z` publishes `ghcr.io/lexmount/artifact-site:X.Y.Z`.

## Unreleased

- Keep the account menu above transformed home-page artwork.
- Keep new share-link creation at the top of sharing settings and move external visit data into its own tab.
- Replace the account menu's inline language tiles with a compact checked submenu.
- Restore keyboard focus when closing account menus, hide closed visit explanations from assistive technology, and ignore aborted view-history responses.

- Avoid flashing the home-page login entry for browsers with a session cookie; focus the first copy action when opening quick sharing.

- Show the home-page sign-in/sign-up entry before account detection finishes, then animate the first or changed signed-in identity into place without replaying on routine navigation.

- Exclude automatic publish links from sharing guidance, isolate anonymous reminder history, and improve first-paint positioning, keyboard toolbar retention and quick-share modal isolation.

- Unify product branding across shared readers, owners, editors, version selection and notification viewers; retain the logo mark on narrow screens.

- Scope private-site guidance to each account and site, include server-side share history, and keep the guidance visible outside the collapsing header.
- Refine the notification inbox, remove acknowledged rows from its unread filter, and make mobile quick sharing a compact bottom sheet.
- Improve both collapsed viewer controls, retain header pinning when browser storage fails, and ignore stale identity requests after sign-in changes.

- Restore authored fragment links before preview history-event handlers run so TOC highlights can match the original `href`.

- Preserve native anchor activation in sandboxed previews, including event cancellation, stopped propagation, repeated named anchors, keyboard focus and visual-editor documents. Exercise these behaviors in Chrome in CI.

- Keep pure `#fragment` links inside hosted artifacts as same-document navigation instead of reloading the preview before scrolling to the target.
- Add social sharing metadata for public marketing pages, crawler rules and a marketing-only sitemap.
- Document Google and GitHub sign-in on the hosted demo in every README translation.
- Show localized, actionable quota guidance for new-site and new-version uploads.
- Improve sharing with quick audience links, repeated private-site guidance, persistent header pinning, URL locale overrides and adaptive collapsed-header contrast.
- Add language and notification-center entries to the account menu, tighten header utility spacing, and limit the account arrival animation to relevant home-page auth changes.

- Preserve existing accounts, sites and permissions when a Logto application change gives a user
  a new OIDC subject but the same verified email address. Historical duplicates resolve to the
  earliest account; migrations log account identifiers and duplicate warnings.

- Gradually load sandboxed card and list previews after visible cards remain on screen, while preserving fast metadata covers on initial navigation.

- Show share URLs as single-line, truncated links that open in a new tab, with a separate copy button.

- Clarify the comment destination label and help text in English and Simplified Chinese.

- Preserve search drafts and view selections during delayed navigation, refresh directories after publishing or copying, and keep pagination working after deleted folder bookmarks fall back to All sites.

- Stream navigation loading states in a persistent shell and reuse recent routes for 30 seconds.
- Return paginated personal lists with permissions and folder data; paginate and search the public directory in SQL.
- Replace automatic live list thumbnails with metadata covers, deduplicate permission lookups, and cancel abandoned requests.
- Load the full agent reference on demand, cache its rendering, and add local navigation markers plus opt-out slow-read diagnostics.
- Document and probe public-edge HTTP/2 and disable bundled proxy response buffering.
- Add permission-checked comment mentions with an extensible candidate policy, keyboard-accessible picker, durable mention identities, and deduplicated in-app notifications.

- Add discussion follows and a personal notification inbox for replies, with permission-checked deep links, revocable version-scoped share access receipts, and configurable notification retention.

- Keep the home update-artifact link next to the upload hint rather than at the far edge.

- Place the text-selection comment action near the mouse release point, with viewport clamping and selection-based keyboard/touch fallback.

- Remember acknowledgement of the update-artifact banner using account-scoped coachmark preferences and replace its close icon with a clear “Got it” button.

- Place the home page update-artifact shortcut beside the upload hint as an underlined text link, with wrapping on narrow screens.

- Add a shared new-version upload panel to the library, viewer More menu, and version history, with whole-content replacement, conflict acknowledgement, retry recovery, correctable rejected files, and explicit official designation. Uploads also work on LAN HTTP origins. Add a home shortcut to updating existing artifacts.
- Compact the viewer header around the project logo, title and version. Replace the persistent private-link warning with dismissible, account-scoped guidance and teach the collapsed toolbar handle.
- Reduce idle comment list polling from 10 to at most 30 seconds, suspend background timers, and coalesce foreground refreshes while retaining low-frequency unread checks.

- Add CLI/MCP personal-folder listing and moves, explicit public-catalog lookup, and operator identity reporting; label search ownership independently of visibility and align agent help and Skill guidance.
- CLI JSON compatibility: `whoami.tokenStatus` now uses `unidentified` instead of `rejected` for credentials without an identified account and adds `operator` for verified operator credentials. `email` now comes from the server identity and is null when absent, rather than using the saved login email.
- Replace the site deletion browser prompt with an accessible confirmation and retryable errors.
- Open bundled PDF links in the sandboxed PDF.js reader while preserving raw downloads and range reads; route platform-return links through a host confirmation to preserve browser identity.
- Keep comment previews, posting and image uploads working on LAN HTTP origins where `crypto.randomUUID` is unavailable, using secure random bytes for UUID generation.

- Load comment images near the viewport and separate mobile preview/remove touch targets without enlarging thumbnails.
- Attribute comment result associations made with personal API tokens to agents, matching OAuth attribution and audit records.

- Clarify comment-style preview and code-format controls; halve attachment thumbnails while keeping full-size image previews.

- Improve comment search with safe keyword highlighting, clear controls and filter summaries; restore keyboard focus when returning to discussions and enlarge touch controls.
- Show image upload progress and processing states, preserve individual retry/cancel, and proportionally resize overlarge re-encoded images within existing upload/decode limits.
- Add authenticated native MCP image reads for comment attachments, retaining share isolation and per-read access checks.


- Add lightweight comment links and inline code with a safe preview, plus pasted/uploaded image
  attachments for comments and replies. Keep image drafts across reloads, offer upload retry and
  accessible previews, and protect image reads with the discussion permissions. Decode uploaded
  rasters, expire abandoned drafts after seven days, and clean up removed attachments.
- Search comment text and replies within authorized discussions, filter discussions you participated
  in, and record an adjusted version without moving or automatically resolving original feedback.
  Result associations retain actor/time audit records and hide inaccessible target versions.
- Synchronize comment mutations with unread refresh and reject obsolete in-flight responses while
  keeping reading order and drafts stable.

- Explain per-link comment isolation beside the destination picker and identify share
  destinations with the same short link ID as sharing settings and creation date.
  Keep destination rows consistent and floating editors within the soft-keyboard viewport;
  preserve input height when switching between floating and sidebar composition.

- Simplify comment creation with a shared compact sidebar/floating composer, contextual
  selection toolbar, grouped quotes, adaptive input height, and quieter draft controls.

- Preserve file metadata and SHA-256 receipts during parallel uploads and re-uploads, keeping
  entry-page detection stable and enforcing aggregate upload limits when merging receipts.
  Revalidate stale limit failures and identify retryable receipt contention as `upload_conflict`.

- Keep site action menus inside the viewport so bottom-row actions, including Delete, remain
  reachable. Flip menus above their trigger when needed and scroll tall menus on short screens.
  Respect the visible area during mobile zoom and keyboard use; close menus when outside scrolling moves their trigger.
  Keep width stable on open and restore keyboard focus without scrolling on dismissal.
- Add read-only comment listing, discussion and context tools to MCP and CLI, historical source reads/exports, and an Agent feedback-to-update workflow. CLI content updates now require an explicit version baseline; existing-site revisions preserve the original address.

- Add selection-to-comment for HTML and selectable PDF text, including verified citations and
  file/page labels. Managers can choose a live, version-compatible share discussion when composing
  from the main artifact; each destination keeps its own draft. Share management links directly to
  the independent discussion. Keep read discussions stable during quiet unread-list refreshes.

- Restore the original README banner display width across all six languages.

- Remove retired authorization tables and columns after the four-table RBAC rollout. Grant
  management now uses `/api/authorization/*`; remove the old collaborators API and edit-policy
  controls/fields. Keep visibility, share links, ownership and anonymous management unchanged.
  Upgrade directly from 0.2.0; no separate PR1 deployment is required. Stop every instance sharing
  the database before deploying; neither 0.2.0 nor PR1 binaries can run against the cleaned schema. See `docs/RBAC.md` for deployment and backup requirements.

- Move role catalogs and authorization grants to four database tables. Migrate existing tenant
  administrators and site roles at startup before retiring old role storage.
  Add Administration → Authorization and scoped grant editors in Sharing and Workspaces, with
  viewer/commenter/editor/admin roles for named members, own-workspace members and global everyone.
  Support revocation for disabled accounts, audit administrative authorization reads, and exclude
  only named collaborators from audience statistics. Preserve share-link scope, CLI/MCP identity
  and immediate revocation. Deploy with a coordinated
  restart; old and new authorization writers must not run together (see `docs/RBAC.md`).

## 0.2.0 — 2026-09-17

Comments and reactions on artifacts, recoverable publishing for large trees, OAuth for MCP
clients, tenant-scoped RBAC, official versions and the multilingual README. Upgrading applies
database migrations automatically; no configuration changes are required.

### Added

- **Comments.** Version- and share-isolated comment threads with replies, author editing,
  moderation, resolution, main-link policy settings and audited access. Comments can be anchored
  to a selection in HTML, image and PDF artifacts (Office documents fall back to whole-file
  comments), reviewed against the exact version they were written on, and bundled as authorized
  context for agents. Anonymous visitors can read but not write.
- **Comment sidebar.** All review happens in the artifact's right sidebar: owner share feedback,
  version/source/author/status filters, original-version previews, inline replies, resolve/undo,
  an overlapping-marker chooser, a mobile sheet and per-tab draft recovery that survives
  sign-in and refreshes. Old review bookmarks redirect to the sidebar.
- **Reactions and read progress.** Account-scoped emoji reactions on comments and replies with a
  searchable Unicode picker (categories, recent, skin tones), unread discussion indicators and
  private cross-device read progress (local for anonymous readers). Migration
  `0006-comment-engagement`. Signed anonymous artifact likes.
- **Recoverable publishing.** Authenticated CLI publishing safely extracts ZIPs, preflights HTML
  entries, uploads large trees file by file, persists credential-free progress and recovers lost
  commit responses. Publication results are idempotent for seven days with owner-scoped HTTP/MCP
  status queries, atomic result/version commits and fencing against superseded attempts; staged
  uploads are kept for six hours. File-transfer rate limits are separate from publication limits.
- **OAuth for MCP clients.** ChatGPT, Claude and any client that implements MCP authorization
  can connect to `/mcp` by signing in instead of pasting a token: this server is now its own
  OAuth 2.1 authorization server — authorization code with PKCE (S256), refresh tokens with
  rotation, RFC 9728 / RFC 8414 discovery, Client ID Metadata Documents and dynamic client
  registration — with a consent page at `/oauth/authorize`, the scopes `artifacts:read` and
  `artifacts:write`, and **Connected applications** in My sites to disconnect. Personal and
  operator tokens work unchanged. New settings, also editable from the console:
  `ARTIFACT_OAUTH_CLIENT_HOSTS`, `ARTIFACT_OAUTH_DCR`, `ARTIFACT_OAUTH_APP_SCHEMES`. The agent
  guide's MCP tab offers both ways in.
- **Tenant-scoped RBAC** with `init` and `anonymous` system tenants, tenant/site administrators,
  permanent editor memberships, independent view/comment/edit share modes and fixed-version links.
  Workspaces provides member management and explicit anonymous-artifact claiming. Legacy
  collaborators now have editing rights only; signing in alone no longer grants editing or
  automatically claims anonymous sites. See [RBAC](docs/RBAC.md).
- Encrypted, version-scoped preview credentials that recheck share revocation and tenant access.
  A shared database key is generated automatically; platform administrators can rotate it from
  Settings without a restart. `PREVIEW_SIGNING_SECRET` is an optional first-start seed.
- **Official versions.** Designate one current or historical version as official from the
  viewer, upload confirmation, My sites, CLI or MCP. Latest links keep following updates; fixed
  shares and immutable snapshots stay unchanged.
- **Share link management.** Sharing settings open in a large window; newly created links can be
  retrieved and copied after reopening; link settings and guest-list changes require an explicit
  save with an audience-impact confirmation. Links carry names, creation sources and version
  summaries, drafts are protected, historical links are grouped, and site visibility changes are
  confirmed. Historical hash-only links remain valid but cannot be recovered.
- Version-aware ZIP downloads in the viewer, My sites, editor, version history and platform site
  administration. Administrative downloads require a reason and record an export audit. Owners and
  editors can export saved content after a takedown; deleted sites remain unavailable. ZIPs include
  all saved files (including document originals), not editor drafts.
- Home-page **Recently viewed / Recently updated** tabs (updates show only owned sites, newest
  first). Browser history now covers unlisted sites and shared/pinned entrances, forgets sites
  that turned out inaccessible, and stays local to the browser (up to 50 sites).
- View counts: My sites lists total recorded views; new opens across direct/share entrances are
  collapsed per reader and site for 30 minutes, preview crawlers are filtered consistently,
  lifetime opens are distinguished from seven-day external visits, and optional view-detail
  retention drains in time-budgeted batches while preserving cumulative counts.
- Platform-admin **audit retention** setting (0–3650 days, default 0 = forever) for site, admin
  and RBAC logs, with time-budgeted maintenance cleanup and a manual System action. Console
  settings override `ARTIFACT_AUDIT_RETENTION_DAYS`; expired deletions are permanent.
- Opt-in **GA4 browser analytics** with runtime configuration, public-URL hostname defaults,
  redacted page context and explicit account/publishing/sharing events. Configuration errors
  never break pages; failure telemetry is limited to write-request failures.
- An installable **agent skill** (`npx skills add lexmount/artifact-site`) and a streamlined README
  in all six languages with a hosted-product comparison and clearer CLI/MCP entry points. README
  in 简体中文, 日本語, Deutsch, Français and Español under `docs/`.
- CLI: `artifact-site --version` (and `-v`) prints the installed package's version.
- The header links to the project's GitHub repository on every page that shares the header.

### Changed

- Viewer version status, snapshot navigation and official designation are consolidated into a
  compact toolbar menu; side actions dock to the edge behind a slim, initially collapsed handle.
- RBAC is enforced consistently across browser, API, CLI and MCP: title editing for account
  owners/admins, anonymous management token validation, retired owned-site tokens, disabled disown,
  explicit RBAC actions for report APIs and one version-range rule for previews and comments.
  Credentials and roles are rechecked during upload staging and final publication; share edits are
  merged under the authorization transaction and revision-aware clients reject stale settings.
  Read-only OAuth sessions no longer advertise writes.
- MCP/personal-token authentication is preserved; clients gain tenant/share context and share
  mode/version controls. `email` remains a compatible alias of the `people` share policy.
- The CLI only falls back after confirmed pre-publication 413 errors and no longer automatically
  retries unsafe writes on server errors.

### Fixed

- Artifact resource queries are kept separate from preview controls so CSS, scripts, images,
  fonts and data with `?v=` cache tags load correctly.
- Public and unlisted artifact viewers now need editor-or-higher source-export permission to fork
  (Save a copy), download original files or export ZIPs. Rendered content remains readable.
- Concurrent RBAC operations no longer exhaust the PostgreSQL connection pool while waiting for
  the administration lock; version access checks are free of duplicate read audits.
- Follow-share preview keys are rechecked after publication; official-version subresources are
  served; inaccessible latest-version IDs are omitted from agent comment context.
- Tenant and same-report version constraints are added without rewriting historical ownership or
  visibility; retired edit-policy values no longer affect sharing responses.
- Home tab headings use the original section-heading typography; comment quotations are limited to
  30 characters, whole-file comments are labelled, and reaction tooltips no longer clip. Comment
  refresh sits with the header actions, the rail marker toggle stays while the panel is open, and
  expanded filters sit above the read tabs.

## 0.1.0 — 2026-09-14

The first public release.

### Added

- Administrators can assign unowned sites to an existing verified account from the console,
  including email administrators on deployments without PUBLISH_API_TOKEN.
- Remote MCP at `/mcp` with authenticated Streamable HTTP, full artifact operations, bounded
  binary upload/download chunks, and independent CLI/MCP onboarding. Personal tokens can be
  created in the browser and revoked in My sites.
- An explicit Home link in the main navigation, highlighted on the home page.
  Narrow headers keep account controls together and navigation on a scrollable second row;
  administrators can use the account menu instead of a duplicate navigation entry.
- Agent guide with prompt, CLI and MCP tabs, deployment-aware authentication instructions,
  copyable commands and Cursor configuration, complete tool reference and troubleshooting.
  Home and README entries link directly to the connection guide. Installation uses npm's global
  prefix; token input supports Bash and zsh. Authentication guidance distinguishes public reads,
  the default anonymous setup, and operator-token verification.
- **Search and read for agents.** `GET /api/search?q=` finds sites by what they say (every word
  must occur; title matches first; Chinese works without any database extension) among the sites
  the caller may list, and `GET /api/sites/:slug/text` returns a site's current version as plain
  text — HTML stripped, pdf/docx/pptx text extracted — or one file of it. CLI `search` / `read`,
  MCP `artifact_site_find` / `artifact_site_read`, and a section in the agent guide. Text is
  extracted right after each publish (never in the request path) into a new `site_texts` table.
  Existing sites are indexed by the maintenance tick (now driven by searches as well as
  publishes, 20 seconds per hour) — search is partial until that catches up; the console's
  System page has an "Index search text of existing sites" button to do it now. Reading is
  never partial: an un-indexed site is extracted on the spot. Memory is bounded before anything
  is read — text files are read as a 2 MB prefix, documents over 40 MB are indexed by title only,
  office archives inflate only their text parts (16 MB each, 32 MB total), and at most two
  extractions run at once per process.
- **Console settings.** The "who may do what" policy — who can create, what anonymous creators
  may do, default visibility, anonymous-site expiry and the four quota caps — is editable at
  `/admin/settings` without a rebuild (console > environment > default; "Use environment" hands
  control back; every save is logged). Stored in a new `settings` table keyed by scope, the seat
  reserved for tenants.
- **Anonymous creators can be kept to reading** (`ARTIFACT_ANONYMOUS_SITES=read-only`, or the
  console): the creating browser can open its site; editing, sharing, renaming and deleting ask for
  a sign-in, after which the site belongs to that account.
- **Agent guide version.** `/for-agents.md` carries `skill_version` in its frontmatter and every
  API response the header `X-Artifact-Site-Skill-Version` (a hash of the guide's text, so it changes
  with every edit and needs no bumping). The guide tells agents to refetch it when the two differ,
  so an installed copy cannot silently go stale after an upgrade.
- **"My sites" has a folder rail and a search box.** Folders sit in a left column with their
  counts (All / Unfiled / each folder), the grid filters by title or address, and narrow screens
  fall back to the chip row. Folders themselves are unchanged.
- **Quotas and anonymous-site expiry.** `ARTIFACT_QUOTA_SITES_PER_USER` / `_BYTES_PER_USER` cap an
  account's live sites and stored bytes (every version counts), `_PER_ANON` the same for an
  anonymous browser; a write over a cap answers `403 quota_exceeded` with the numbers. Everything
  is unlimited by default. `ARTIFACT_ANON_SITE_TTL_DAYS` removes sites published without an
  account that many days after their last change unless adopted by an account — a normal delete, restorable by
  an administrator within the retention window; the creator sees the date on the site and the
  create response carries `expiresAt`. The users view shows usage against the caps.
- **Administration console** at `/admin` (Overview, Users, Sites, System; an entry in the account
  menu for administrators, 404 for everyone else) and its API. `ARTIFACT_ADMIN_EMAILS` names
  administrators by sign-in e-mail; `PUBLISH_API_TOKEN` as a Bearer keeps working for scripts.
  `/api/admin/*` lists users (site count, stored bytes) and sites (owner, size, state), disables accounts
  (sign-in refused, sessions and publish tokens revoked), takes sites down (served to the owner
  only; visitors get a removal notice and 410 from the API), deletes and restores sites, and runs
  maintenance. Owners see a banner with the reason on a taken-down site and a chip in "My sites".
  Every act is written to a new `admin_log` table, including an administrator opening a private
  or taken-down site (`site.view`) — administrators can read any site the console lists, but
  cannot write to it. Owners see their site's slice of that log under "Administrator activity"
  in the site's More menu (`GET /api/sites/:slug/admin-activity`): dates, actions and reasons,
  never the administrator's identity. `/api/auth/me` reports `isAdmin`.
- **Deleted sites can be restored.** Deleting a site no longer removes its files at once: they are
  kept for `ARTIFACT_DELETED_RETENTION_DAYS` (default 30) and purged afterwards, automatically
  about once an hour on a replica that sees traffic, or from the administration API.
- **Account-level folders** (#35): "My sites" folders are stored on the account once signed in and follow the user across devices (`/api/me/folders`); the browser-local shelf is imported once after sign-in (folders matched by name, sites filed where the account had no opinion yet) and then retired. Signed-out browsers and deployments without an IdP keep the local behaviour unchanged.
- `ARCHITECTURE.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates, README screenshots,
  and `scripts/export-public.sh` (produces the public-repository tree without internal docs).
- `@artifact-site/cli` (`cli/`): a command-line client (`publish`, `update`, `export`, `share`, `list`, `rollback`, …) with the same artifact operations available through remote MCP, with device sign-in, chunked upload for large trees and PDFs, and `expected_version` locking.
- Apache-2.0 license, `SECURITY.md` (threat model and disclosure process), `CONTRIBUTING.md`.
- GitHub Actions CI (typecheck, lint, unit tests, Postgres integration tests, Docker build) and a
  tag-triggered release workflow that publishes a multi-arch image to GHCR.
- Single-host deployment kit: `make up` with a bundled Postgres 18, optional Gotenberg and Caddy,
  pre-flight `make doctor`, `make backup` / `make restore`, image packaging for offline hosts.
- Startup self-check that prints the effective backends and refuses configurations that could
  not work (missing database URL, incomplete S3 settings, `login` policy without an IdP).
- English as the source language for UI copy, with Simplified Chinese as a selectable locale
  (cookie `ah_locale`, else `Accept-Language`).

### Changed

- **The interface follows the design team's system.** Black on near-white with one light-green
  accent, the system sans font, and a horizontal header (Home · Explore · My sites · Agent guide,
  EN | 中文, a prominent Sign in). The home page leads with the drop zone and the one line to hand
  an agent; My sites has a folder rail, list and grid views, and tabs for created / editable /
  recently viewed (the full history, with remove and clear); the viewer bar carries device
  preview, Edit and Sharing with the rest behind "···"; the editor is one bar with Edit / Preview
  and Save new version; the console, activation and sign-in pages use the same tokens. Signed out,
  My sites still lists the sites this browser created. `globals.css` was consolidated — dead rules,
  stacked overrides and six reduced-motion blocks folded — and two hygiene tests keep it that way
  (every styled class is used, every zh-CN key is referenced). (#105)

- Make MCP upload errors actionable, reuse owner/session resolution per chunk, and count project files independently of transfer chunks. Keep final byte counts consistent; clarify discarded Office/ZIP drafts, verify UI tool labels against discovery, and improve CLI search-limit and share-inspection handling.

- The MCP connection page displays the access token as editable plaintext and provides a separate
  copy-token button, with success/failure feedback and disabled copying when empty.

- Remote MCP now exposes 15 task-oriented tools instead of 24, with usage examples, parameter
  guidance and server instructions. List/search, identity/limits, details/history/shares and
  export/download are consolidated; uploads use start/write/cancel and commit via publish/update.
  Refresh client tool discovery after upgrading; see docs/MCP.md for migration. Staged publish
  now follows inline publish's public-share default; pass `share: false` to keep it unshared.
- CLI recommends `find` for listing/search and `update --title` for renaming. Old commands remain
  compatible but are hidden from top-level help. Add `edit`, `fork` and `info --shares` to expose
  the existing client capabilities; remove obsolete local MCP setup instructions.

- Removed open claiming by URL; the old claim API returns 410. Use personal-token publication,
  original-browser sign-in, or Administration → Sites → Assign owner for unowned sites.
- Removed the local `artifact-site mcp` stdio command. Configure a remote URL and Bearer token
  instead; the standalone CLI retains its artifact operations.
- **`ARTIFACT_CLOUDDESK_URL` is now `ARTIFACT_ASSISTANT_URL`.** The optional embedded assistant lost its
  product name in code, docs and the environment; the old variable is still read, so nothing breaks
  on upgrade. Weekly Dependabot updates (npm, CLI, actions, Docker) are enabled.
- **Viewer action bar.** The brand ("Sites") is visually separated from the site title, and the
  title keeps its width on narrow windows instead of running under the controls. Edit, upload a new
  version, version history, save as new site, share editable link and the reveal-mode switch are
  folded into a "More" menu; device preview, sharing and "open in new window" stay on the bar.
- **Postgres is the only metadata store.** SQLite remains for the test suite and is refused at
  runtime. Deployments that relied on the SQLite default must provide `ARTIFACT_DATABASE_URL`;
  existing SQLite data is not migrated.
- **Default visibility no longer depends on the hostname.** `ARTIFACT_DEFAULT_VISIBILITY`
  decides; unset it is `public` only when `ARTIFACT_PUBLIC_URL` is empty (local development) and
  `private` otherwise. Intranet deployments that want open links set `public` explicitly.
- File storage is inferred from `ARTIFACT_S3_BUCKET` when `ARTIFACT_STORAGE_DRIVER` is unset.
- Default upload ceiling raised to 300 MB per version (streamed upload path); `.env.example`
  suggests 100 MB for internet-facing hosts.
- Package renamed to `artifact-site`; company-specific deployment documentation removed from the public tree.
- Dependencies: Next.js 16.3.4 (pulls in sharp 0.35 / libvips fixes), postcss 8.5.28 override,
  transitive updates — `npm audit` reports no known vulnerabilities.
- API error mapping: an unexpected server-side failure now answers `500 {"error":"internal error"}`
  (logged server-side) instead of echoing the exception message with status 400. Validation
  errors (bad upload, path, title, edit shape, malformed JSON) keep their 400 and message.

### Fixed

- Preserve staged uploads after version conflicts, so an explicitly approved retry can reuse bytes.
  MCP dispatch skips only duplicate caller limits, retaining independent secret-scoped limits.
- Operator uploads no longer turn derived credentials into anonymous ownership cookies, quotas
  or expiry. Upload creation rejects callers denied by the create policy before storing files.
- Office-document updates enforce atomic expected-version checks; chunked conflicts return the
  same structured recovery details as inline updates. MCP counts each operation once and gives
  file chunks a separate transfer budget. Unexpected storage errors are logged server-side.
- CLI uploads retain the server-issued upload identity across requests, fixing chunked uploads
  with an operator token. Invalid MCP credentials are rate limited before database lookup.
- Chunked updates recheck permissions and enforce optional expected-version conflicts, shared
  by CLI and MCP. Upload chunk metadata uses compare-and-set to reject concurrent overwrites.
- Inline JSON and multipart uploads enforce the byte limit while reading the body, even without
  Content-Length or with an understated value; new sites, version uploads and source edits share
  the guard. Oversized streams are cancelled before parsing.
- Server-side PDF text extraction keeps PDF.js and its worker together in the runtime image.
  Existing text indexes for all sites (including HTML and folders) are refreshed once, lazily on reads or through the bounded maintenance backfill
  using an additive extractor-version column, repairing previously empty PDF text and search results.
- The container includes the project's Apache/MIT license texts and NOTICE. CI boots the final
  image with disposable Postgres and runs browser and PDF read/search acceptance checks.
- Browser tests use current thumbnail/search controls and an explicit English locale. The CLI
  documents and declares Node 24+ to match its dependencies, with a packed-install check in CI.
- **Publish tokens are stored per server** (`~/.config/artifact-site/tokens/<host>`), by the CLI
  and by the agent guide alike; the legacy single `token` file is adopted on first use. Two
  deployments no longer overwrite each other's token — the cause of "sign in again every session".
  The guide now checks `ARTIFACT_SITE_TOKEN` first (sandboxes with a fresh HOME), verifies the token
  with `GET /api/auth/me` before uploading, and a refused token answers `401` with a reason:
  `token_unknown` (issued by another deployment — authorise here, keep the other) or
  `token_revoked`. `artifact-site whoami` says the same in words.
- The chunked upload path (`/api/uploads`, per-file `PUT`, commit) now applies the same CSRF rule
  as `POST …/versions` when it targets an existing site: cookie-authenticated requests must carry
  a matching `Origin`; edit tokens, publish tokens and the admin bearer are exempt. Sessions for a
  new site follow the deployment create policy, checked before upload and again at commit.
- `SECURITY.md` and `ARCHITECTURE.md` claimed hosted pages cannot reach the network by default;
  they can, and `CSP_CONNECT_SRC` is the opt-in restriction. The agent guide's extension allow
  list now includes the audio/video types the server has served all along.
- `.env.example` shipped `ARTIFACT_MAX_BYTES=100MB` as an active value while every document
  states the 300MB default; the limits are now commented examples of the real defaults.

### Licensing

- **Dual-licensed: Apache-2.0 OR MIT, at your option.** `LICENSE` became `LICENSE-APACHE` and
  `LICENSE-MIT` was added (root and `cli/`); package metadata says `(Apache-2.0 OR MIT)`.
  Contributions are accepted under both (CONTRIBUTING.md).

### Renamed

- **artifact-hub is now artifact-site.** The name collided with CNCF's Artifact Hub. Everything
  public-facing follows: the npm package `@artifact-site/cli` with the `artifact-site` command,
  MCP tools `artifact_site_*`, the agent guide `publish-to-artifact-site`, the CLI's config
  directory `~/.config/artifact-site`, the `ARTIFACT_SITE_*` environment overrides, the image
  `ghcr.io/lexmount/artifact-site`, container names, and the `X-Artifact-Site-Skill-Version`
  header. Nothing is lost on upgrade: the CLI still reads `~/.config/artifact-hub` and the
  `ARTIFACT_HUB_*` variables, API responses carry the old header name as well for one release,
  and the bundled database keeps its `artifact_hub` role and name (a rename there would orphan
  existing data). The first public release is 0.1.0.

### Removed

- Dark mode and the palette switch (Paper / Mineral / Ledger): one light theme, as designed.
- The "Paste HTML" entry on the home page; publish a file, a folder or a zip, or hand the agent line to an agent.

- Company-specific defaults (intranet hostname sniffing, vendor-specific S3 examples, internal
  addresses in the agent skill).
- The unfinished server-side build feature and its `ARTIFACT_BUILD*` settings (`ARTIFACT_BUILD`,
  `ARTIFACT_BUILD_NPM_REGISTRY`, `ARTIFACT_BUILD_TIMEOUT_MS`, `ARTIFACT_BUILD_MAX_SOURCE_BYTES`,
  `ARTIFACT_BUILD_MAX_SOURCE_FILES`, `ARTIFACT_BUILD_CONCURRENCY`, `ARTIFACT_BUILD_WORK_DIR`).
  Nothing consumed the detector or the switch; the variables are now ignored.
