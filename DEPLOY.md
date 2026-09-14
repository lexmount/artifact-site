# Deploying to a new environment: multi-replica + login

This document covers exactly one combination — **multi-replica (Postgres + object storage) with OIDC login enabled**, i.e. a production deployment for a team.
The single-machine `make up` route (bundled Postgres, files on local disk) is in [SELFHOST.md](SELFHOST.md).

Work through it in order; every step has a "how to confirm this step really worked". The app refuses to start and says why when the backend combination is invalid, but **insufficient bucket permissions, an unregistered IdP callback and errors of that kind do not stop the app from starting** — they only blow up the first time a feature is used, so the verification steps cannot be skipped.

---

## 0. Decide three things first

| Decision | Impact |
| --- | --- |
| **Who can create sites** | `ARTIFACT_CREATE_POLICY` = `open` (any visitor) / `login` (must be logged in) / `token` (must carry a Bearer). Team intranets are usually `login`. |
| **Public address** | Once `ARTIFACT_PUBLIC_URL` is set it should not change: the OIDC callback, the `Origin` comparison of the CSRF gate on write routes, and the API address `/for-agents.md` hands to agents all come from it. Changing it means updating the IdP allow list too. |
| **Object storage bucket** | **Must be a brand-new empty bucket**. Reusing a bucket that has been experimented with makes orphan collection unable to tell "my data" from "someone else's"; see "Orphan collection" in section 5. |

---

## 1. Prepare the external dependencies

### 1.1 Postgres

```sql
CREATE ROLE artifact_hub LOGIN PASSWORD '<strong random password>';
CREATE DATABASE artifact_hub OWNER artifact_hub;
```

**The role must have DDL (create table) permission**. Tables, indexes and the column changes of later versions are all applied by the app at startup via `CREATE TABLE / CREATE INDEX / ALTER TABLE ... IF NOT EXISTS` — **there is no separate migration command and no migration to run by hand**. A DML-only role fails on the first request.

### 1.2 Object storage bucket (S3 / Tencent COS / MinIO)

Create a **brand-new empty bucket**. The credentials need more than "read/write objects":

| Action used | Purpose |
| --- | --- |
| `PutObject` / `GetObject` / `DeleteObject` | Read, write and delete artifact files |
| `ListObjectsV2` (i.e. `ListBucket`) | List directories, measure size, delete a whole version tree by prefix, orphan collection |
| `HeadObject` | Tell whether a path is a file or a directory |
| `CopyObject` | Server-side copy of version trees (both fork and edit rely on it) |

**A COS sub-account with only "object read/write" is not enough**: without `ListBucket`, listing files after an upload is the first thing to fail.

### 1.3 Register the OIDC application at the IdP

Obtain the three values **issuer / client id / client secret**. Then add the following to the IdP's redirect allow list, **verbatim**:

```
<ARTIFACT_PUBLIC_URL>/api/auth/callback
```

> The other OIDC endpoints are **discovered automatically** by the app from the issuer; there is nothing to configure one by one.
>
> **An unregistered callback looks very misleading**: the IdP returns 400 directly, the browser stops on the IdP page, and **this app logs nothing** — it is easily mistaken for the app not being up.

One deployment has one identity provider: everyone who clicks "Sign in" is sent to it. Which one is up to you.

#### Google

Google is a standard OIDC provider, so it needs no code and no extra settings — only an OAuth client:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), pick or create a project, then **Create credentials → OAuth client ID**, application type **Web application**.
2. Under **Authorized redirect URIs** add `<ARTIFACT_PUBLIC_URL>/api/auth/callback` verbatim (for a local trial, `http://localhost:4300/api/auth/callback` is accepted).
3. If the project has no OAuth consent screen yet, the console asks for one; the `openid`, `email` and `profile` scopes this app requests are non-sensitive, so no verification review is needed. An **Internal** consent screen limits sign-in to your Google Workspace organisation; **External** lets any Google account in (combine with `ARTIFACT_CREATE_POLICY=login` plus share policies, or keep it Internal, on a public host).
4. Copy the client id and secret:

```bash
ARTIFACT_OIDC_ISSUER=https://accounts.google.com
ARTIFACT_OIDC_CLIENT_ID=<…>.apps.googleusercontent.com
ARTIFACT_OIDC_CLIENT_SECRET=<client secret>
```

Accounts are keyed by Google's stable subject id, so a user who changes their email keeps their sites. Google sends no `sid` claim and no back-channel logout, so signing out of Google does not end an artifact-site session; the app's own logout does.

#### An identity platform you already run

Logto, Keycloak, Authentik, Okta, Auth0, Microsoft Entra ID and similar all expose the same OIDC contract: register a web application, allow the callback, and set the three values. Point `ARTIFACT_OIDC_ISSUER` at the exact issuer the platform advertises (the app compares it with the discovery document, so a trailing path or a different host is rejected; for Entra ID use the tenant-specific issuer, not `common`). Such a platform can also offer Google or GitHub buttons on *its* sign-in page while artifact-site only ever talks to the platform.

---

## 2. Environment variables

```bash
# ── Required ────────────────────────────────────────────
ARTIFACT_PUBLIC_URL=https://artifacts.example.net   # no trailing slash

# Metadata → Postgres (the only option, required)
ARTIFACT_DATABASE_URL=postgres://artifact_hub:<pw>@<host>:5432/artifact_hub?sslmode=require

# Files → object storage (enabled automatically once BUCKET is set; all four are required)
ARTIFACT_S3_ENDPOINT=https://s3.example.com     # any S3-compatible service, e.g. for COS https://cos.<region>.myqcloud.com
ARTIFACT_S3_BUCKET=<bucket name>
ARTIFACT_S3_ACCESS_KEY_ID=<SecretId>
ARTIFACT_S3_SECRET_ACCESS_KEY=<SecretKey>
ARTIFACT_S3_REGION=<region>              # set explicitly to what the service expects
ARTIFACT_S3_FORCE_PATH_STYLE=false       # false for COS; true for MinIO

# Login
ARTIFACT_OIDC_ISSUER=https://idp.example.net/oidc
ARTIFACT_OIDC_CLIENT_ID=<client id>
ARTIFACT_OIDC_CLIENT_SECRET=<client secret>
ARTIFACT_CREATE_POLICY=login             # open | login | token
ARTIFACT_ENFORCE_OWNERSHIP=on            # a fresh environment can turn this on from day one, see below

# ── Usually left empty ────────────────────────────────────────
PUBLISH_API_TOKEN=                        # admin token; when set, drag-and-drop upload in the browser returns 401 (the web UI never sends it)
CSP_CONNECT_SRC=                          # only when hosted artifacts need to call external APIs

# ── Document preview (office→pdf conversion, optional) ──────────────────
GOTENBERG_URL=                            # e.g. http://gotenberg:3000. Empty = no conversion: office uploads still publish,
                                          # shown as a "download card"; pdf online preview does not depend on it and always works
ARTIFACT_CONVERT_TIMEOUT_MS=              # total budget, default 60000: **waiting for a slot + the conversion itself share this one budget**;
                                          # when it runs out the upload degrades to a download card, publishing does not fail — under burst,
                                          # tail requests get a card earlier than the "one conversion takes 60s" intuition suggests; expected
ARTIFACT_CONVERT_CONCURRENCY=             # concurrent conversions per replica, default 2; the queue has a hard cap (concurrency×10),
                                          # and when it is full new uploads degrade to a card **immediately** instead of waiting
```

Triaging conversion degradation: when a batch of download cards shows up in production, the reason text on the card is the classification — "Timed out waiting in the conversion queue" =
never got a slot, queue depth exceeded what the concurrency can absorb (raise CONCURRENCY); "Waiting in the conversion queue used up the time budget" = got a
slot, but the conversions ahead ate the budget, meaning concurrency is fine and single conversions are too slow (raise TIMEOUT_MS, or find out why Gotenberg
slowed down); "The conversion queue is full" = a momentary burst exceeded the concurrency×10 hard cap; "Conversion failed (HTTP …)" = check the Gotenberg
container log; "converted preview too large" = conversion succeeded but would blow the size limit, so the platform dropped the preview to keep the publish. The server log
has the fate of every job under the `[convert]` prefix, including "how much budget the queue ate".

The converter component for document preview: run one `gotenberg/gotenberg:8-libreoffice` on the intranet (stateless, no volume, can be multi-replica;
**the official image ships CJK fonts; Chinese documents have been verified to render without tofu**), network allowing only platform → Gotenberg one way; health check
HTTP `3000` `/health`. Verification after going live: upload a Chinese pptx; opening `/s/<slug>` should show the layout snapshot directly; if a download card with "Conversion failed" appears, check the Gotenberg container log.

Three things that are easy to get wrong:

1. **Numeric variables must be plain byte counts**. `ARTIFACT_MAX_BYTES=50MB` is **silently ignored and falls back to the default**, with no error.
2. **Changing any `ARTIFACT_S3_*` requires a restart**; the credentials are baked into the client at startup.
3. **`ARTIFACT_ENFORCE_OWNERSHIP` can be on from the start in a fresh environment**. The "keep it off on first deployment" note in `.env.example` targets **rolling upgrades where old and new images coexist** (the old image does not know `edit_policy`, and flipping it then makes "revoke access" silently fail on half of the traffic). A fresh environment has no old replicas, so it does not apply.

---

## 3. Deploy the component

Run the image (`ghcr.io/lexmount/artifact-site`, or a build of the root `Dockerfile`) on your platform — Kubernetes, Docker, a PaaS — with port `4300` exposed. In multi-replica mode these items differ from a single replica:

| Item | Multi-replica requirement |
| --- | --- |
| `/data` persistent volume | **Do not mount it**. Mounting pins the replicas to one node. (`/data` must still be writable: the entrypoint probes it and exits otherwise, so never mount it read-only; the image pre-creates it owned by uid 1001) |
| Health check | Must be configured: HTTP `4300` `/` |
| Instance count | **Start with 1**, complete all verification, then scale up |
| Memory limit | Leave headroom for the S3 read cache: default **128MB per replica** (`ARTIFACT_S3_CACHE_BYTES`) |
| Gateway request body limit | At least `ARTIFACT_MAX_BYTES` (default 300MB), otherwise large artifacts are rejected at the gateway |

> Session state lives in the database `sessions` table, not in process memory, **so no session affinity is needed**.
> The cookie carries a **plaintext secret** and the database stores its SHA-256 (as the session row's primary key) — so the cookie itself is equivalent to a login credential and must be treated as a secret, while a read-only database export is **not enough** to forge a cookie.

---

## 4. Verify (finish every item before scaling up)

At startup the app prints two lines, `[runtime] metadata: …` / `[runtime] files: …`, describing the backends in use, and refuses to start on an invalid combination — look at those two lines first. But **a misspelt variable name** is still treated as "not set" (metadata has no fallback and startup fails for lack of `ARTIFACT_DATABASE_URL`; file storage falls back to local disk), so confirm once more with indirect signals.

### 4.1 The backends really switched

```bash
BASE=https://artifacts.example.net
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/"          # expect 200
```

After uploading a site:

- **Bucket side**: objects with the prefix `sites/<siteId>/<versionId>/…` appear
- **PG side**: `SELECT count(*) FROM sites;` shows the row
- **`/data` side**: on a fresh deployment it should be empty (no `sites/` directory — if there is one, file storage fell back to local disk)

### 4.2 The login flow

1. Click login → redirected to the IdP → authorise → after coming back, the top right shows you as logged in
2. Stuck on the IdP page = the callback address is not on the allow list (see §1.3)
3. Came back but not logged in = `ARTIFACT_PUBLIC_URL` does not match the domain actually being visited

### 4.3 Ownership enforcement is effective

Log in, create a site, then open it in **another browser (logged out)**:

- The content is visible ✅ (viewing is always public)
- Clicking edit is refused ✅
- A site created anonymously can still be edited from this browser ✅

### 4.4 Multi-replica consistency (after scaling up)

**Do not just refresh the browser** — preview assets carry `max-age=60` and S3 has an in-process cache, so hitting the same replica repeatedly gives false positives. Use the command line:

```bash
for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' "$BASE/s/<slug>"; done; echo
```

**All must be 200**. A 404/500 means some replica is still running the old image or still using local disk.

> The same trick detects a **stuck rolling upgrade**: with old and new images coexisting, the same URL is half 200 and half 404.

### 4.5 The entry point for AI

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/for-agents.md"
```

Expect `200 text/markdown; charset=utf-8`. This also verifies that the publish skill document was packaged into the image.

**Also confirm the API address inside the skill points at this environment** — it is rewritten from `ARTIFACT_PUBLIC_URL`, and if that is misconfigured agents will call someone else's site:

```bash
curl -sS "$BASE/for-agents.md" | grep -m1 'Base URL'
```

The address in the output must be your own domain. **If `artifact-site.example.com` appears, `ARTIFACT_PUBLIC_URL` did not take effect** (misspelt, or not restarted) and agents get a bogus address.

---

## 5. After going live

- **Backups**: in multi-replica mode what needs backing up is **Postgres + the bucket**, no longer `/data`. Only one side is not restorable: the database alone yields records pointing at missing files, the bucket alone yields nothing listable.
- **Orphan collection**: files in the bucket that no version references (a failed upload, a deleted site) can be removed with `POST /api/admin/reconcile?dryRun=1` (Bearer `PUBLISH_API_TOKEN`) to list them, then without `dryRun` to delete; objects younger than one hour are never touched. Only run it when **both** the database and the bucket in use are this deployment's own — a bucket shared with another instance would have that instance's files judged orphans.
- **Rate limiting is per process**: the total allowance across N replicas is roughly N × the configured value. Acceptable on an intranet; a precise global limit needs a shared rate limiter.
