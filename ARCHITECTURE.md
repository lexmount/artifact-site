# Architecture

artifact-site hosts **finished front-end artifacts and documents** that people and AI agents
upload, and serves them back as sandboxed, versioned, shareable pages. There is no build step and
no source control inside the product: what you upload is what gets served. This page is the map
a new contributor needs before opening `src/`.

## Shape of the system

```
                 ┌───────────────────────────── Next.js 16 (one process, standalone) ─────────────────────────────┐
 browser ──────▶ │  src/app/**            pages (server components) + client components (src/components/**)     │
 agent / CLI ──▶ │  src/app/api/**        route handlers: thin — auth, parsing, response shaping                 │
                 │  src/lib/**            everything that matters: sites, versions, storage, authz, sharing …     │
                 │        │                                                                                        │
                 │        ├── MetadataStore (src/lib/db.ts)  ──▶  Postgres (db-postgres.ts)  [SQLite: tests only] │
                 │        └── Storage      (src/lib/storage.ts) ─▶  local disk under $ARTIFACT_DATA_DIR            │
                 │                                                 or an S3-compatible bucket (storage-s3.ts)     │
                 └────────────────────────────────────────────────────────────────────────────────────────────────┘
                 optional sidecars: Gotenberg (office → pdf previews), an OIDC identity provider (sign-in)
```

Two pluggable seams, chosen at startup from the environment and reported in the boot log
(`src/lib/runtime.ts`, `src/instrumentation.ts`):

| Seam | Interface | Implementations | Selected by |
| --- | --- | --- | --- |
| Metadata (sites, versions, users, sessions, shares, audit) | `MetadataStore` in `src/lib/db.ts` | `db-postgres.ts` (production, the only one accepted at runtime); `db-sqlite.ts` (the test suite's backend) | `ARTIFACT_DB_DRIVER` (default `postgres`; `ARTIFACT_DATABASE_URL` is the connection string) |
| Files (each version's tree) | `Storage` in `src/lib/storage.ts` | `LocalStorage` (disk); `S3Storage` (any S3-compatible service) | `ARTIFACT_S3_BUCKET` (or `ARTIFACT_STORAGE_DRIVER`) |

Postgres + S3 together means the process holds no state, so it can run as several replicas
behind a load balancer. Postgres + local disk is the single-host deployment (`make up`).

## Data model

- **Site** — the thing a link points at. `slug` (unguessable, in every URL), `title`, `kind`
  (`single` page · `folder` tree · `document`), `visibility` (`public` · `unlisted` · `private`),
  ownership (a user id, or the anonymous browser id that created it), and a pointer to the
  **current version**.
- **Version** — an immutable file tree. Every change — edit, whole-tree write-back, document
  re-upload, rollback, fork — creates a new version; old ones stay and can be rolled back to.
  The files live in `Storage` under `sites/<siteId>/<versionId>/…`; metadata rows record
  provenance (`source`), size and file count. Because keys are immutable, the S3 backend can cache
  reads in memory without invalidation.
- **Share** — a capability link (`/v/<token>`) with a policy: `public`, `login` (any signed-in
  user), `people` (named grants), `passcode`. Tokens and passcodes are stored hashed. A share can
  expire and be revoked; creating a new one is how a leaked link is retired.
- **Identity** — users come from an OIDC provider; sessions are cookie-backed rows (the cookie
  holds a secret, the row holds its SHA-256). Agents get long-lived **publish tokens** through a
  device-authorisation flow (`/api/device/*`); they are bearer credentials stored hashed too.
  MCP clients that implement OAuth (ChatGPT, Claude) get short-lived **access tokens** from this
  app's own authorization server (`src/lib/oauth*.ts`; `/oauth/*`, `/.well-known/*`):
  authorization code with PKCE, a consent page, opaque tokens stored hashed, refresh with
  rotation, and a per-connection disconnect on the account page. All three bearers fold into the
  same session shape in `src/lib/session.ts`, so nothing downstream knows which one it got.
- **Folder** — a per-user shelf for "My sites": `folders` (user, name, order) and
  `folder_assignments` (user, site, folder; one folder per site per user). Owner-perspective data:
  the site itself is untouched, and two people may file the same site differently. Signed-out
  browsers keep a local shelf; it is merged into the account once after sign-in.
- **Audit** — every mutation records who (session, token, or anonymous id), what, and from
  where (`src/lib/audit.ts`). Administrator assignment of an unowned site commits ownership, site audit and admin log
  in one transaction. Open claiming is disabled.

Schema changes are additive and idempotent (`CREATE … IF NOT EXISTS`, `ALTER … ADD COLUMN IF NOT
EXISTS`) and run at startup under a transaction-scoped advisory lock, so several replicas can
boot concurrently. There is no separate migration command.

## Request paths

**Publishing.** `POST /api/sites` accepts JSON or multipart in four modes (`paste`, `file`,
`folder`, `zip`), all normalised in `src/app/api/_util.ts` into one `UploadInput` that
`src/lib/sites.ts` turns into a site + version. Large trees and large PDFs use the **chunked
route** (`/api/uploads`: open a session, `PUT` one file at a time streamed to storage, commit) so
nothing big is ever buffered. Office documents are converted to a PDF layout snapshot by
Gotenberg (`src/lib/convert.ts`, bounded concurrency and a time budget; failure degrades to a
download card, never a failed publish). Documents get a generated viewer page
(`src/lib/document-site.ts`, PDF.js copied from `node_modules` into `public/vendor` at build
time by `scripts/sync-pdfjs.mjs` — nothing under `public/vendor` is committed).

**Serving.** `/api/preview/<slug>/<path>` reads the current version from `Storage` and serves it
with the sandbox headers (below), an injected `<base>` so relative links resolve to the site
root, and a storage shim. `/s/<slug>` is the site page with the platform chrome around that
preview iframe; `/v/<token>` is the reader-facing share page that first evaluates the share
policy (`src/lib/share.ts`).

**Changing.** `POST …/edit` (one page, or one file of a tree), `POST …/versions` (whole tree or
new document), `rollback`, `fork`. Both write paths honour `?expected_version=<id>`: if the
site's current version is not the one the caller started from, the answer is `409` with the
winning id, and the caller re-exports (`GET …/export` → zip + `x-artifact-version`) and retries.
The in-browser editor (`src/components/editor.tsx`, `visual-editor.tsx`) and the agent write-back
loop are the same protocol.

**Authorization.** `src/lib/authz.ts` computes a viewer's capabilities for a site once per
request (`requireCapability` / `requireActor`): owner, collaborator, anonymous creator, edit
token, admin token. Share links grant reading only (`src/lib/share.ts`). Every route that changes
an existing site goes through it; creating a site, forking, administrator assignment and the per-account routes
(`/api/me/*`, `/api/device/*`) have their own gates, described at the top of each route file.
Cookie-authenticated mutations must also carry an `Origin` matching `ARTIFACT_PUBLIC_URL`
(`csrfSafe` in `src/lib/session.ts`); bearer tokens are exempt because they are never sent
ambiently.

**Administration.** `src/lib/admin.ts` decides who is an administrator — the API token, or a
signed-in account whose verified e-mail is in `ARTIFACT_ADMIN_EMAILS` (a device-flow token never
is) — and performs the console's acts: disable an account (sign-in refused, sessions and publish
tokens revoked), take a site down (`canReadSite` then admits only its owner, collaborators and
administrators; everyone else gets 410), delete and restore. Deletes are soft; files stay for
`ARTIFACT_DELETED_RETENTION_DAYS` and `lib/maintenance` purges them. Every act lands in
`admin_log`, a separate table because half of them have no site. `src/lib/settings.ts` resolves the policy settings (console table > environment > default; a
30-second per-process snapshot of the table, refreshed on save) — `scope` on the table is where a
tenant layer would go. `src/lib/quota.ts` holds the
per-owner caps (checked against stored usage at every path that adds a site or a version) and
the anonymous-site clock; `lib/maintenance` runs the expiry.

## The sandbox: why hosted pages cannot hurt the platform

Uploaded HTML is treated as hostile. Every artifact renders in an `<iframe sandbox>` **without
`allow-same-origin`**, and the preview response carries a `Content-Security-Policy: sandbox …`
header so the document has an opaque origin even if it is opened directly. Consequences the
platform relies on, and documents for authors in `src/content/publish-skill.md`:

- the page cannot read the platform's cookies, storage or DOM, and cannot call the platform API
  (only `/api/preview/*` sends CORS headers);
- the network is reachable by default (dashboards fetch APIs); `CSP_CONNECT_SRC` turns on an
  exclusive `connect-src` allow list when an operator wants to restrict it;
- `localStorage`/`sessionStorage` are replaced by an in-memory shim so scripts do not throw;
- `Referrer-Policy: no-referrer` on every platform page, so an edit-token URL never leaks into a
  hosted page's `document.referrer`.

Paths are defended once, in `safeRelativePath` (`src/lib/storage.ts`): no `..`, no dot segments,
no absolute paths, no symlinks, realpath must stay inside the version directory. Zip declared
sizes are checked before decompression; per-version, per-file and file-count limits apply to
every route. `SECURITY.md` has the threat model in full.

## Surfaces for agents

- `/for-agents.md` — the publishing skill, served with this deployment's base URL substituted in.
  It is the contract: modes, limits, sandbox rules, error meanings, the write-back loop.
- `cli/` — `@artifact-site/cli`: the same contract as a command line (`artifact-site publish …`)
  through the HTTP API. Remote MCP runs in the platform at `/mcp`, using Streamable HTTP and
  a fresh server per authenticated request. It dispatches to the same HTTP handlers in process,
  without loopback networking or user-controlled upstream URLs. Personal tokens carry the same
  account permissions; operator tokens retain the existing override. Cookies do not authenticate
  MCP. File chunks use database-backed upload sessions and bounded storage reads/writes; no
  MCP argument is interpreted as a server-local filesystem path. See [MCP.md](docs/MCP.md).
- Optional: an embedded external editing assistant on the site page (`ARTIFACT_ASSISTANT_URL`,
  `src/components/assistant.tsx`) — the page hands it the site's slug, kind and current
  version; off unless configured.
- Search and read: `src/lib/site-text.ts` extracts the text of a site's current version after every
  commit (html stripped; pdf through the bundled pdf.js; docx/pptx from their XML) and stores it in
  `site_texts` with a pre-tokenised string — latin words, CJK character bigrams, all ASCII — so
  Postgres (`tsvector` + GIN) and SQLite (FTS5) index the same thing and no extension is needed for
  Chinese. `GET /api/search` runs under the directory's visibility predicate; `GET /api/sites/:slug/text`
  under the site's read gate. The hourly tick backfills whatever the index missed.

## Internationalisation

English is the source language. UI copy goes through `t("English text")` (the text is the key);
`src/locales/zh-CN/*` holds Simplified Chinese, one file per feature area; a missing entry falls
back to English. Locale comes from the `ah_locale` cookie, then `Accept-Language`
(`src/lib/i18n.ts`, `i18n-server.ts`, `components/locale-provider.tsx`). Server-side and API
messages are English only.

## Repository layout

```
src/app/            routes: pages (s/[slug], v/[token], me, activate, for-agents) and api/**
src/components/     client components (uploader, viewer chrome, editors, sharing UI)
src/lib/            domain: sites, storage, db, authz, share, session, oidc, convert, audit, i18n …
src/locales/        translations
src/content/        the agent skill (served at /for-agents.md)
test/               vitest suites (SQLite-backed; *.integration.test.ts need a real service)
cli/                the CLI + MCP server package (own dependencies and tests)
scripts/deploy/     make up / doctor / backup / restore for the single-host deployment
compose/, Makefile  the single-host deployment kit; Dockerfile builds the server image
```

## Where to start reading

1. `src/lib/sites.ts` — create / edit / replace / rollback: the lifecycle in one file.
2. `src/lib/storage.ts` — `safeRelativePath` and the `Storage` interface.
3. `src/lib/authz.ts` — who may do what.
4. `src/app/api/preview/[slug]/[[...path]]/route.ts` — how a hosted page is served.
5. `src/content/publish-skill.md` — what the platform promises to the things it hosts.
