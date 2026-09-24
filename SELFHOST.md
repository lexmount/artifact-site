# Single-machine deployment (docker compose)

One Linux machine, one `.env`, one `make up`. Suited to intranet use and small-team deployments on the public internet. For multi-replica / high availability see [DEPLOY.md](DEPLOY.md) (external Postgres + object storage).

## How it works, in one sentence

`make up` reads `.env` and **fills in whatever you left blank**:

| In your .env… | Result |
| --- | --- |
| `ARTIFACT_DATABASE_URL` empty | A bundled Postgres 18 container, data under `POSTGRES_DATA_PATH` |
| `ARTIFACT_DATABASE_URL` set | Your database is used, no container started |
| `ARTIFACT_S3_BUCKET` empty | Uploaded files are written to the host directory `ARTIFACT_DATA_PATH` |
| All four `ARTIFACT_S3_*` set | Files go to the bucket |
| `ARTIFACT_WITH_GOTENBERG=on` | Additionally starts a Gotenberg so office documents can be previewed online |
| `ARTIFACT_WITH_CADDY=on` + `ARTIFACT_DOMAIN` | Additionally starts a Caddy that issues certificates automatically and takes ports 80/443 |

All four "database × files" combinations are valid. **Postgres is the only metadata store** — SQLite serves tests only; setting `ARTIFACT_DB_DRIVER=sqlite` in production refuses to start.

> **Upgrading from a pre-release SQLite deployment**: this version **does not migrate** SQLite data. Sites from the old database will not appear in Postgres; `make up` removes the old container as an orphan and leaves the old named volume (`*_artifact-data`) unmounted. `make doctor` warns when it detects these leftovers. To keep the old data, copy `sites.sqlite` and `sites/` out of the old volume before upgrading (`docker cp <old-container>:/data ./old-data`).

`make doctor` prints the final plan; after `make up` the application log also has a few lines starting with `[runtime]` that say what is in use.

## Prerequisites

- Linux + Docker 24 or later + docker compose plugin 2.24 or later (`docker compose version`).
- A domain name pointing at this machine (public deployment); machines in mainland China need an ICP filing to serve a domain on 80/443.
- Whether the machine can reach Docker Hub and the official npm registry decides how the image gets there; see "Where the image comes from" below.

## First deployment

```bash
git clone https://github.com/lexmount/artifact-site.git && cd artifact-site
cp .env.example .env
${EDITOR:-vi} .env    # at minimum: ARTIFACT_PUBLIC_URL, ARTIFACT_CREATE_POLICY (an empty database password is generated automatically)
make doctor           # see what it complains about
make build up         # build image → preflight → start containers → wait for health
```

The example defaults to a localhost-only anonymous trial with private visibility. Creators can view their work and grant access through share links. RBAC is always enforced; `ARTIFACT_ENFORCE_OWNERSHIP` is deprecated and ignored. Anonymous sites accept their creating browser or management token, subject to the anonymous policy; account-owned sites use account roles. Upgrade all replicas together; old authorization binaries must not keep serving writes. Existing personal and MCP OAuth credentials remain valid. Keep an existing deployment's `.env` when upgrading.

The three decisions that matter most in `.env`:

1. **`ARTIFACT_PUBLIC_URL`**: once set, never change it. The OIDC callback, the CSRF check and the API address handed to agents all come from it.
2. **`ARTIFACT_CREATE_POLICY`**: do not leave it at `open` on a public deployment — that lets anyone upload HTML to your machine. `login` needs the OIDC settings in section four; with `token`, drag-and-drop upload in the browser returns 401 and only scripts and agents can publish.
3. **Where the data lives**: `ARTIFACT_DATA_PATH` and `POSTGRES_DATA_PATH` default to directories under the repository (`./data`, `./pgdata`); if the repository itself is cloned on the data disk there is nothing to change. These two directories are all of the data.

## Where the image comes from

`make up` needs the image `ARTIFACT_IMAGE` (default `artifact-site:local`) to already exist on this machine. Three ways:

| Situation | What to do |
| --- | --- |
| The server can reach Docker Hub and npm | `make build` (build arguments come from `NODE_IMAGE` / `NPM_REGISTRY` in .env and can point at a mirror) |
| The server's outbound network is unreliable (common in mainland China) | `make image` on a dev machine (linux/amd64 by default) → copy `dist/*.tar.gz` to the server → `make load FILE=…` |
| You have an image registry | `ARTIFACT_IMAGE=registry.example.com/artifact-site:1.2.3` in `.env` → `make pull` |

`make image` requires the dev machine's Docker to be able to build amd64 (Docker Desktop / colima can by default).

## Behind a reverse proxy

When not using the bundled Caddy, point your existing reverse proxy at `127.0.0.1:4300`. The app produces its own CSP, Referrer-Policy and other security headers, so the proxy needs no extra configuration, but it **must** pass the client IP through (rate limiting depends on it) and allow a large enough request body (the default upload limit is 300MB; lower it with `ARTIFACT_MAX_BYTES`):

Caddy:

```
artifacts.example.net {
    reverse_proxy 127.0.0.1:4300 {
        flush_interval -1
    }
}
```

Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name artifacts.example.net;
    client_max_body_size 400m;
    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering off; # Stream Next.js loading boundaries immediately.
    }
}
```

`X-Forwarded-Proto: https` decides whether the login cookie carries `Secure`; do not leave it out.

## Sign-in

Leave section four of `.env` empty and the service has no accounts: anyone can view, and `ARTIFACT_CREATE_POLICY` decides who can publish. To give people accounts (sites and folders that follow them across devices, named sharing, agent tokens), point the three `ARTIFACT_OIDC_*` settings at an identity provider. The quickest one is Google — an OAuth client and three lines, no code; any OIDC platform you already run works the same way. Both recipes are in [DEPLOY.md, section 1.3](DEPLOY.md#13-register-the-oidc-application-at-the-idp).

## Administration

Name administrators by sign-in e-mail (`ARTIFACT_ADMIN_EMAILS=you@example.net,ops@example.net`) and they get the administration console at `/admin` (an entry appears in the account menu) and its API: users with their site count and storage, disabling an account (sign-in refused, sessions and agent tokens revoked), taking a site down (served to its owner only; visitors get 410), deleting and restoring sites, and running maintenance. Every act is recorded. Administrators can also open any site the console lists, private ones included, to judge a report — reading only, never editing as the owner, and every such opening of non-public content is written to the same log, so "staff can access your data" means on purpose and on the record — and the owner can check: every site's More menu has "Administrator activity", the owner's view of that log (what happened and when, with the reason; not who). `PUBLISH_API_TOKEN` as a Bearer remains an administrator for scripts.

A deleted site is soft-deleted: its files stay `ARTIFACT_DELETED_RETENTION_DAYS` (30 by default) so it can be restored, then a purge removes them. The purge runs on its own about once an hour on any replica that sees traffic, or on demand from the console.

## Quotas and anonymous sites

The whole "who may do what" group — who can create, what an anonymous creator may do, the default visibility, the anonymous-site expiry, the quota caps and the three MCP OAuth knobs — is editable from the console at `/admin/settings` and takes effect without a rebuild; a console value overrides the environment variable, and "Use environment" hands control back. The variables below still work and are what a Docker `.env` deployment uses.

The simplest public posture is one switch: **Sites created without an account → Read-only until signed in**. Anyone can drop a file and get a link they can open; editing, sharing and deleting ask for a sign-in, after which the site belongs to that account (the browser's earlier sites move over automatically). Pair it with an expiry so unclaimed sites do not pile up.

Everything is unlimited until you say otherwise. On a deployment where strangers can publish, set caps: `ARTIFACT_QUOTA_SITES_PER_USER` / `ARTIFACT_QUOTA_BYTES_PER_USER` for accounts and `ARTIFACT_QUOTA_SITES_PER_ANON` / `ARTIFACT_QUOTA_BYTES_PER_ANON` for anonymous browsers (every version counts towards the bytes; a write over the cap is refused with `403 quota_exceeded`, and the users view shows usage against the cap). Anonymous browsers can reset their id, so the real backstop is `ARTIFACT_ANON_SITE_TTL_DAYS`: a site published without an account is removed that many days after its last change unless its creating browser signs in and adopts it — the creator sees the date on the site, and the removal is an ordinary delete an administrator can undo within the retention window.

## Verifying the deployment

```bash
BASE=$(grep ^ARTIFACT_PUBLIC_URL .env | cut -d= -f2)
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/"                # 200
curl -sS "$BASE/for-agents.md" | grep -m1 'Base URL'                # must be your own domain
```

Then upload an HTML file in the browser (logging in first, or carrying a token, as `ARTIFACT_CREATE_POLICY` requires): it should open and be editable. Open the same link in a different, logged-out browser: what is visible follows the visibility setting, and clicking edit is refused.

`make ps` shows container status, `make logs` the application log.

## Day-to-day operations

| Command | What it does |
| --- | --- |
| `make up` | Start, or apply configuration changes (runs doctor first) |
| `make restart` | Recreate only the app container (after changing `.env`; changing `ARTIFACT_S3_*` requires a restart) |
| `make down` | Stop all containers, data is kept |
| `make logs` / `make ps` | Logs / status |
| `make backup` | Back up to `backups/<timestamp>/` |
| `make restore FROM=backups/<timestamp>` | Restore (stops the app first; the existing file directory is renamed and kept) |
| `make psql` | Open the database |
| `make upgrade` | `git pull` + rebuild the image + stop then start (when the server can build) |

If the server cannot build the image, upgrading is: `make image` on the dev machine → copy the bundle → `make load FILE=…` → `make up`. The image name for that version must match `ARTIFACT_IMAGE` in `.env`.

## Backups

`make backup` produces:

- `db.dump`: the metadata from `pg_dump -Fc` (the bundled database is dumped inside its container; an external one via a one-off container)
- `files.tar.gz`: the file directory, archived (only when files are stored locally)
- `manifest.txt`: a summary of the configuration at that time

When files are in an S3 bucket the bucket contents are **not** copied — use the bucket's own versioning or cross-region replication. Backing up only one side cannot be restored: database only gives you a pile of records pointing at files that do not exist; files only means no site can be listed.

Recommended: a daily `make backup` from cron, with `backups/` synced somewhere else.

## FAQ

- **`make up` reports "the app failed to start" and exits**: look at the last few `[runtime] FATAL` lines it printed; usually a misspelt variable or an invalid combination. `make doctor` catches the vast majority in advance. The container keeps retrying, so fix .env and run `make up` again.
- **The bundled database is up but the app cannot connect (log says `password authentication failed`)**: `POSTGRES_PASSWORD` was changed after the database was initialised. The password in the database does not follow .env; use `make psql` and `ALTER ROLE artifact_hub PASSWORD '…'` to bring them in line, or change it back.
- **Drag-and-drop upload in the browser returns 401**: `PUBLISH_API_TOKEN` is set (or the policy is `token`). This is by design; clear it on intranet deployments.
- **Clicking login gets stuck on the IdP page**: the callback address is not on the IdP's allow list; register `<ARTIFACT_PUBLIC_URL>/api/auth/callback` verbatim. This app will not log anything.
- **Uploading a large file returns 413**: check who sent the response. HTML error page = the reverse proxy refused it, raise the body limit; JSON = the app refused it, adjust `ARTIFACT_MAX_BYTES`.
- **Moving to another machine**: run `make up` once on the new machine so it creates the directories, `make down`, copy `backups/` over and `make restore`; or simply move the two data directories over as a whole and then `make up`.
- **`WARN: /data is not a mounted volume` in the log**: only appears when no directory is mounted. It will not appear with `make up`; if it does, `ARTIFACT_DATA_PATH` did not take effect.


## Remote MCP

`POST /mcp` serves stateless Streamable HTTP using the same business permissions as the HTTP
API. Forward Authorization, Accept and Content-Type through your reverse proxy. Do not cache
responses. GET and DELETE return 405 because there is no persistent server-side MCP session.
Requests are capped at 2 MiB; large files use 256 KiB decoded chunks through MCP tools.
Upload drafts use the configured storage and database and expire after six hours.

Every MCP request requires a valid Bearer token, including discovery: an OAuth access token the
client obtained by signing in (ChatGPT, Claude and every client that implements MCP
authorization — the app is its own authorization server, see [MCP.md](docs/MCP.md)), a
personal token, or the operator token. Browser cookies do not authenticate MCP. For the OAuth
path the reverse proxy must pass `/.well-known/*` and `/oauth/*` through untouched (no
dot-file deny rule, no caching), and `ARTIFACT_PUBLIC_URL` must be the exact address clients
use, because tokens are bound to it. OAuth requires OIDC sign-in; its three knobs (client host
allow-list, dynamic registration, extra application schemes) live in the console next to the
other policies. Personal tokens are created in the Agent guide or My sites
and may be revoked immediately. Without OIDC, configure PUBLISH_API_TOKEN and supply it only
to trusted operators; keep ARTIFACT_CREATE_POLICY=open explicit if anonymous browser creation
should remain enabled. Operator tokens have no personal site list. Their new sites have no anonymous owner, so
anonymous-browser quotas and expiry do not apply. MCP operations use the ordinary per-token
rate budget; byte-transfer chunks and pre-authentication IP admission use 12 times that budget.
Internal HTTP dispatch does not count twice. See the rate-limit details in MCP.md before tuning.

See [MCP.md](docs/MCP.md) for client setup and migration from local stdio.

Open claiming by site URL is disabled. Personal-token uploads are assigned at creation; administrators can assign operator-created or historical unowned sites through authorized ownership transfer. Original-browser adoption on sign-in remains available.

### Administrator assignment of unowned sites

In **Administration → Sites**, open an unowned site's action menu and choose **Assign owner**.
Enter the verified email of an existing, active account and confirm. Email administrators use
this console flow even when PUBLISH_API_TOKEN is unset. Personal agent tokens do not inherit
email-administrator privileges. Existing owners are never overwritten by this action.

For operator scripts, POST `/api/admin/sites/<slug>/owner` with
`Authorization: Bearer <PUBLISH_API_TOKEN>` and JSON `{"email":"recipient@example.com"}`.
This admin endpoint accepts operator tokens without Origin; browser administrators must send
a same-origin request. The separate owner-to-owner `/api/sites/<slug>/ownership` endpoint
still requires a same-origin Origin header, including when called by an operator script.

### Preview credentials

Preview credentials work without additional configuration. On first use, the server creates a random key in the shared database; every replica adopts the same key and restarts retain it. `PREVIEW_SIGNING_SECRET` is an optional initial seed only: once a key is stored, the database takes precedence over the environment.

Platform administrators can rotate the key in **Administration → Settings → Preview access key**. The console displays the last generation time, never the secret. Rotation is audited and immediately invalidates old preview credentials across all replicas; viewers refresh to obtain new credentials. Share links and login sessions remain valid. Public current-version previews use stable credential-free asset URLs. Include the database in normal backups; restoring an old database also restores its preview key.

### Audit retention

Platform administrators configure **Administration → Settings → Audit log retention (days)** for all three audit tables. The default is **0 (keep forever)**; valid values are 0–3650 whole days. A console value is persisted in the global `settings` table and overrides `ARTIFACT_AUDIT_RETENTION_DAYS`; “Use environment” removes the override. Every change is audited. Settings-change and maintenance entries follow the same retention window as other administrator logs. Cleanup reads the current persisted value inside its deletion transaction, without the policy cache, and serializes with settings updates across replicas.

The request-driven maintenance tick runs at most once an hour per process when create or search routes are used. Each tick drains expired records in batches of up to 1,000 **per table**, until no batch is full or a 20-second budget is consumed. Each batch has its own transaction, releases the RBAC lock and re-reads retention; queued policy changes can stop or adjust subsequent batches. The budget is soft: an in-flight batch finishes before stopping. Idle deployments do not run a timer; remaining backlogs resume on the next tick, so retention is a target rather than an exact expiration deadline. **Administration → System → Prune expired audit logs** runs the same budgeted job on demand (`POST /api/admin/maintenance` with `{"task":"prune-audit"}`). Only the `reconcile` maintenance task supports `dryRun: true`; all other tasks reject it before execution. Records exactly at the cutoff are retained. Increasing retention or setting it to 0 cannot recover deleted records; database backups have their own retention policy.

## Publication recovery

The metadata migration adds `publish_operations`. Site/version writes and their idempotency results
commit in the same database transaction, so all replicas can recover a lost response. Results have
seven-day retention; expired key hashes remain as tombstones to prevent accidental reuse. Expired
result payloads are cleared lazily on subsequent keyed writes. Staged upload bytes still expire after
six hours, independently of result retention. Back up this table with the rest of the database.

File PUTs have a separate per-process rate-limit bucket with 12 times the configured write burst
and refill rate. They do not consume creation/commit tokens. Gateway body and timeout limits still
apply to each file; a streamed upload does not bypass the gateway. Keep the inline request ceiling
as a memory safeguard rather than raising it to accommodate an entire project.

## Optional GA4 analytics

Set `ARTIFACT_GA_MEASUREMENT_ID` to your `G-` measurement ID. The allowed hostname
defaults to the existing `ARTIFACT_PUBLIC_URL`, so a single-domain instance needs
no additional domain configuration. For multiple aliases on one instance, set
`ARTIFACT_GA_HOSTS` to the complete comma-separated list of allowed hostnames
(this overrides the default). Separate instances may share the same measurement
ID and each use their own `ARTIFACT_PUBLIC_URL`.
These are runtime settings: restart/recreate the app with the new environment; no
image rebuild is needed for configuration changes. An empty ID disables analytics.
A malformed ID logs one warning and disables analytics without breaking the site;
`make doctor` still reports the configuration error.
Unlisted hosts do not load the Google script or send events. Keep development and
test hosts out of this list. Each installation supplies its own ID.

Use one GA4 web stream for the product's domains. Disable Enhanced Measurement in
that stream: the app sends page views explicitly on pathname changes. For journeys
between different root domains, configure cross-domain measurement in GA4's
Google tag settings and verify linker parameters survive redirects. Sharing a
measurement ID alone does not merge anonymous users across domains.

The browser sends `page_view`, `ui_click` (upload/login/share/download/update),
`login`, `sign_up`, `artifact_publish_success`, `artifact_update_success`,
`artifact_operation_failed`, and `share_link_copy`. `sign_up` means the first
creation of a local OIDC account, not registration at the external identity provider.
A two-minute analytics cookie carries the callback result to the browser and is
cleared after consumption during normal navigation. It is intentionally readable
and writable by JavaScript: a user can recreate it and inflate login/signup events.
It is an untrusted telemetry hint, never proof of authentication or account creation.
Signing this hint would not make GA4 browser events authoritative, since the client
can also send those events directly. Use server-side account records for trusted
signup counts, billing, authorization, or audit decisions.
Login success includes first-time sign-ins; signup is an additional event for them.
Keyboard saves and document replacement report update results; download clicks do
not imply a completed download. Failure events cover non-2xx write responses
(including conflicts) and rejected network requests, not no-op edits, preflight
validation, or UI writeback errors. Visual update success requires an actual write
and completed editor writeback. No CLI/MCP or iframe-content events are collected.
Page views start independently of the auth request; identity is attached when it
becomes available. Initial events can therefore be sent without `user_id`, even
for an already signed-in visitor. They still count as page views; this can happen
on each full page load, not just at the start of a GA4 session. The app does not
resend those events after identification, which would double-count visits.

Google documents [same-session association of events before User-ID is set](https://support.google.com/analytics/answer/9213390?hl=en).
With a reporting identity that includes User-ID (Observed or Blended), earlier
events can be associated with the user once later events carry that ID. This
reporting association is different from the original request containing a
`user_id`; do not assume the first page view is always missing from user reports,
or that setting the ID alone guarantees association without a subsequent event.
If identification never succeeds or no identified event reaches GA4, the visit
can remain anonymous. Previously collected historical data is not reprocessed.
A failed auth read leaves the login hint intact until retry or its two-minute
expiry. Verify a signed-in page reload followed by an identified interaction in
both the collect requests and processed GA4 reports when validating deployment.

Register event-scoped custom dimensions for `page_type`, `button_name`,
`upload_method`, `method`, `operation`, `error_code`, and `share_type` as needed.
Use Hostname to split domains, event reports for actions, funnel exploration for
conversion, and user exploration for individual activity. Enable debug mode with
Google Tag Assistant for DebugView, then verify in Realtime. Standard reporting
can take 24–48 hours.

Before enabling production reporting, validate both explicit and automatic events
with GA4 DebugView and the browser Network panel:

- In a fresh browser session, visit an artifact and a share URL with recognizable
  test-only slug/token/query/title markers, navigate between pages, and leave the
  page after engagement.
- Check `page_view` and automatic `session_start`, `first_visit`, and
  `user_engagement` events when emitted. Their `page_location`, `page_referrer`,
  and `page_title` must contain only the normalized values.
- Inspect the decoded `dl`, `dr`, and `dt` fields in every Google collect request
  (including unload requests). None may contain real slugs, share tokens, query
  credentials, or user-authored titles. Verify this separately from the app's
  command-queue tests: automatic-event behavior depends on the loaded Google tag.
- Repeat across configured domains and with Enhanced Measurement disabled. Treat
  any raw value as a release blocker; command-queue tests alone do not verify live
  Google collection. Recheck after changing the tag's remote configuration.


Only internal user IDs are sent, cleared on logout. URLs retain the current origin
but replace artifact slugs/share tokens with fixed route labels. Query parameters,
fragments, document titles, file names, content, email and raw error text are not
sent. This also intentionally omits UTM/query-based attribution in this first version;
external referrers retain only their origin. Individual artifacts cannot be
identified from the normalized page path. No preview CSP changes are needed.
Keep Enhanced Measurement off to preserve these boundaries. Network or browser
blocking can lose events; this is analytics, not an audit log. Operators should
only enable collection under their site's applicable consent/privacy policy.

### View history retention

`ARTIFACT_VIEW_RETENTION_DAYS` defaults to `0` (keep details). Set it to 7–3650 days to enable
request-driven hourly cleanup. Each tick alternates 1,000-row batches between the two view tables
until both are drained or a soft 20-second budget is consumed. Each batch releases its locks and
yields; an in-flight batch may finish after the deadline. Invalid values disable cleanup. The minimum preserves the seven-day external-audience summary. Idle deployments do not run
a timer; a backlog drains over subsequent ticks. Cleanup atomically archives counts before deleting
details, so cumulative opens do not decrease. The view history and last-open time use retained details;
old identities, IP addresses and user agents are not kept in the archived counts. Backups have their
own retention. This does not change audit-log retention.

New openings are collapsed per reader and site across direct and share links for 30 minutes. The first
entrance in that window is retained as the source. Historical rows keep their previous per-link counting
rules; deployment does not rewrite historical counts. Anonymous viewers without a browser identity fall
back to IP, so viewer counts are approximate rather than a count of individual people.

Direct viewer 404s deliberately do not distinguish a missing site from an inaccessible site.
Opening either removes that exact entrance from this browser's Recently viewed history. This means
an expired session or lost access can also remove a still-existing private site; after signing in,
owners can reopen it from My sites to record it again. Share-link login and passcode prompts keep
history. No client-visible deletion/access-denial signal is added.

## Claiming the MCP connector on Glama

If your deployment's `/mcp` endpoint is listed on [Glama](https://glama.ai/mcp/connectors) (for
example because it was published to the MCP Registry), you can claim the listing with Glama's HTTP
challenge:

1. Copy the `glama_claim_…` value from the claim dialog into `ARTIFACT_GLAMA_CLAIM` and restart the
   app.
2. Confirm `https://<your-host>/.well-known/glama.json` returns the JSON (responses are cached for
   up to 5 minutes).
3. Choose **Check HTTP challenge** in the dialog.

Keep the variable set afterwards so the ownership stays verified. Empty (the default) serves
nothing, and a malformed value logs one warning and serves nothing.

## Navigation performance

The list pages render metadata covers rather than loading every artifact in an iframe. Personal
lists include server-computed permissions and folder data; both directories use bounded SQL
pagination, title search and stable sorting. Search, folder, view and page selection live in the URL.
The browser router reuses pages for 30 seconds. Mutations refresh that cache; signing in or out
navigates the whole document. This short UI cache never replaces authorization on an API operation.

At the **public TLS terminator**, enable HTTP/2 (or HTTP/3). HTTP/1.1 between the proxy and Node is
normal and independent of the browser protocol. Caddy negotiates HTTP/2 automatically. For Nginx,
use the HTTP/2 syntax supported by your installed release. Disable response buffering as above so
loading boundaries can stream. Do not change the artifact CSP or sandbox to reduce console errors.

Run `bash scripts/deploy/performance.sh https://your-domain.example` to inspect protocol, first-byte
and full-response times without credentials. The script needs a curl build with HTTP/2 support;
otherwise it reports that limitation. A local/VPN/intercepting proxy may change protocol negotiation:
compare this result with Chrome Network's **Protocol** and **Timing** columns on the user's path.
Do not treat an anonymous curl result as a signed-in browser benchmark.

In Chrome Performance, `artifact:navigation-commit` measures a primary-navigation click to the
React route commit; `artifact:directory-ready` marks the rendered list. Resource Timing exposes
pre-request, first-byte and response phases. These markers stay local and send no telemetry.
`ARTIFACT_PERF_LOG_MS` (default `1000`, `0` to disable) logs slow standalone RBAC/directory database
queries as `[performance]` with pool wait, query duration and pool queue length. It deliberately
omits SQL, parameters, identifiers and credentials. It does not time every transaction or legacy
store method; use Postgres statistics/slow-query tooling for a full database profile.

Acceptance: at most 12 directory rows per page; zero automatic artifact preview requests; zero
per-site permission requests for signed-in lists; returning within the cache window should not
re-fetch the same list. Record navigation time separately from list readiness and preview loading.
### Collaboration notifications

Discussion authors and first-time repliers follow automatically. Explicit unfollows persist. Reply events and recipient inbox rows commit atomically with comments; no queue or external notification service is required. Browser inbox reads revalidate current discussion permissions. Notifications never contain stored comment bodies or share tokens.

Platform administrators can configure **Settings → Notification retention (days)** (1–3650, default 90), overriding `ARTIFACT_NOTIFICATION_RETENTION_DAYS`. Unlike other retention settings, `0` does not mean forever: notification retention must be 1–3650 days. Maintenance removes expired events and their inbox rows in batches, without deleting comments or subscriptions.

Authenticated visitors who comment or explicitly follow using a verified share link receive a version-specific access receipt lasting at most 30 days and no later than link expiry. Receipts are checked against the original resource tenant, current link rules, grant membership, version policy and account status. Authorization changes invalidate receipts; label changes do not. Following without independently verified access cannot issue a receipt.
