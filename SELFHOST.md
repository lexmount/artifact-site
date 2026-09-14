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

The example defaults to a localhost-only anonymous trial with private visibility. Creators can view their work and grant access through share links. `ARTIFACT_ENFORCE_OWNERSHIP=on` takes effect once OIDC is configured; without OIDC, anonymous editing remains available via edit tokens. Keep an existing deployment's `.env` when upgrading.

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
    reverse_proxy 127.0.0.1:4300
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

The whole "who may do what" group — who can create, what an anonymous creator may do, the default visibility, the anonymous-site expiry and the quota caps — is editable from the console at `/admin/settings` and takes effect without a rebuild; a console value overrides the environment variable, and "Use environment" hands control back. The variables below still work and are what a Docker `.env` deployment uses.

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

Every MCP request requires a valid personal or operator token, including discovery. Browser
cookies do not authenticate MCP. Personal tokens are created in the Agent guide or My sites
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
