---
name: publish-to-artifact-site
description: Publish a finished piece of work to artifact-site and get back a shareable link. It takes front-end artifacts (a single HTML file, a multi-file directory, a zip, Vite/CRA build output) and documents (pdf / pptx / ppt / docx / doc, viewable online as soon as they are uploaded, original downloadable). Use this skill whenever the user says "publish this", "put it online", "give me a link", "share this page/report/dashboard/deck/document", "deploy it to our platform", or when you have just generated HTML or a document and the user wants to show it to someone. Do not guess the API - the publishing identity is a long-lived token obtained through a one-time device authorisation (the site belongs to the user from birth); anonymous publishes can only be modified with the cookie handed out at creation; and artifacts run in a sandbox without allow-same-origin (absolute-path assets always 404, cookie/IndexedDB/Service Worker all throw). Guessing wrong typically ends in a 403 or a blank page. Document updates go through the whole-file re-upload endpoint, not /edit. Also use it for authorized ownership transfer of an existing site.
---

# Publishing artifacts to artifact-site

Hand a finished front-end artifact to the platform to host, and get back a `/s/<slug>` share link. **There is no build step** — the artifact is uploaded as is and served as is; the platform does not rewrite your code.

**Base URL**: written as `$BASE` below. The default is `https://artifact-site.example.com` (the platform rewrites it to its own address when it serves this file; if you still see example.com, this file did not come from the platform — ask the user for the address). If the user explicitly gives another address, use the user's. Strip the trailing `/` before calling the API or building share links, to avoid double slashes.

**Is this copy current?** The frontmatter of this file carries `skill_version` (absent = this copy did not come from a platform), and every API response carries the header `X-Artifact-Site-Skill-Version` with the version the server serves. When they differ, fetch `$BASE/for-agents.md` again, follow that one, and replace any installed copy — the platform changed something you are about to rely on.

Skim the limits in section 3 before publishing — **most failures are the artifact itself violating a limit, not a wrong API call**.

> **Shortcut**: if the `artifact-site` CLI is installed (built from the repository's `cli/` directory; see its README), `artifact-site login --base $BASE` once and then `artifact-site publish <path>` / `artifact-site update <slug> <path> --expected-version <id>` do everything in sections 1–2 for you (mode selection, chunked upload, share link, optimistic locking). Agents with MCP support connect directly to `$BASE/mcp` over Streamable HTTP with a personal or operator Bearer token, without a CLI install. Use `artifact_site_find` to list your artifacts (no query) or search discoverable work (with query), and `artifact_site_read` to reuse earlier content. Use `artifact_site_publish` / `artifact_site_update` for inline content; for files above the MCP request limit, call `artifact_site_upload_start`, then sequential `artifact_site_upload_write` calls per relative path (zero-based index, base64, at most 256 KiB decoded, `final: true` on each file's last chunk). Finish by calling `artifact_site_publish` with `upload_id` and `share: false` if unshared, or `artifact_site_update` with `slug`, `upload_id` and `expected_version`. All paths are relative uploaded filenames, never paths on the server. `artifact_site_export` returns a manifest, or file bytes when given `path`, `version_id` and `offset`. `artifact_site_connection` reports identity and deployment limits. See `docs/MCP.md` in the repository for the 15-tool catalog and migration. The old local stdio command is removed. The rest of this document is the contract both of them implement.

## 1. Publishing

`POST $BASE/api/sites`; success always returns **200** (not 201).

### Step one: confirm the identity token (once per machine, per server)

Tokens are issued **per server**: one obtained on `https://a.example` is meaningless on `https://b.example`. Look for this server's token, in this order — the environment first (sandboxes and CI inject it there, and a fresh HOME every session would otherwise mean a sign-in every session), then the per-host file, then the old single-file location:

```bash
HOST=$(printf %s "$BASE" | sed -E 's#^https?://##; s#/.*$##')
TOKEN="${ARTIFACT_SITE_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN="${ARTIFACT_HUB_TOKEN:-}"                                          # the product's previous name, still honoured
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-site/tokens/$HOST" 2>/dev/null)
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-hub/tokens/$HOST" 2>/dev/null)    # previous name
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-site/token" 2>/dev/null)   # legacy, pre per-host
[ -z "$TOKEN" ] && TOKEN=$(cat "$HOME/.config/artifact-hub/token" 2>/dev/null)    # legacy, previous name
```

**Then verify it before uploading anything** — it is one cheap call, and it tells you whose identity you are about to publish under:

```bash
curl -sS "$BASE/api/auth/me" -H "authorization: Bearer $TOKEN"
# 200 {"user":{"email":"…"},…}          → good: tell the user which account the site will belong to
# 401 {"error":"…","code":"token_unknown"} → this server has never seen the token: it belongs to ANOTHER deployment.
#                                            Do the device authorisation below for $BASE and store the result under
#                                            tokens/$HOST. Do NOT delete or overwrite the other server's token.
# 401 {"error":"…","code":"token_revoked"} → revoked here (account page, or the account was disabled): authorise again.
```

**Present and verified** → every request from here on carries `-H "authorization: Bearer $TOKEN"`. The published site **belongs to the user directly** (visible and manageable in their account page); no cookie is needed and no claiming afterwards.

**Absent, or refused** → walk the user through a one-time device authorisation (half a minute, and every session on this machine is spared afterwards):

```bash
curl -sS -X POST "$BASE/api/device/start"
# → {"device_code":"…","user_code":"XXXX-XXXX","verification_url":"…",
#    "verification_url_manual":"…","user_message":"…","interval":5,"expires_in":600}
```

**Paste the `user_message` from the response verbatim into the body of your reply to the user, on its own line, at the very top.** This is the only place in this step where the user can get stuck — if the authorisation link stays buried in command output for the user to dig out, the publish usually dies right here. Do not paraphrase it, do not just say "I need you to authorise this", and do not bury the link in the middle of a sentence.

When the user is running you on their own computer (macOS / Linux / desktop Windows), **open the authorisation page for them while you are at it**: `open <verification_url>` (`xdg-open` on Linux, `start` on Windows). Even if that succeeds, still paste `user_message` — in a sandbox, a headless environment or a remote session that command silently does nothing, and you cannot tell the difference.

Then poll with the `device_code` every 5 seconds (for up to 10 minutes), and tell the user you are waiting for them to click "Allow":

```bash
curl -sS -X POST "$BASE/api/device/poll" -H 'content-type: application/json' \
  -d '{"device_code":"<device_code returned by start>"}'
# not clicked yet → {"status":"pending"}; allowed → {"status":"approved","token":"ahp_…","user":{"email":"…"}}
```

Once you have the `token`, **store it immediately — the plaintext is shown only this once** — under this server's host, and report `user.email` to the user so they can confirm which identity is bound:

```bash
mkdir -p "$HOME/.config/artifact-site/tokens" && printf %s '<token>' > "$HOME/.config/artifact-site/tokens/$HOST" && chmod 600 "$HOME/.config/artifact-site/tokens/$HOST"
```

If `$HOME` does not survive between your sessions (a sandbox rebuilt each time), say so to the user: the platform can set `ARTIFACT_SITE_TOKEN` for them once, and this step never comes back.

Only fall back to anonymous publishing when the user **explicitly declines to bind** (or the authorisation times out and the user does not want to retry): modifications rely on a cookie, and ownership can be transferred by its authorized owner or administrator (see below). A deployment may also give anonymous sites an expiry: the create response then carries `expiresAt` (epoch ms; null = no clock) — say so when delivering the link, and explain original-browser sign-in or authorized ownership transfer.

### Which mode to pick

| Artifact shape | Recommended | Request |
|---|---|---|
| A single HTML file | `paste` (JSON) | `{"mode":"paste","html":"…","title":"optional"}` |
| An existing local .html file | `file` (multipart) | `-F mode=file -F 'file=@index.html'` |
| **A document: pdf / pptx / ppt / docx / doc** | `file` (multipart) | `-F mode=file -F 'file=@quarterly-report.pptx'` |
| Multiple files, **all text** | `folder` (JSON) | `{"mode":"folder","files":[{"path":"index.html","content":"…"},{"path":"assets/app.css","content":"…"}]}` |
| Multiple files, **with binaries such as images/fonts** | `zip` | `-F mode=zip -F 'file=@site.zip'` |
| **A project over 24MB** (pages with video, large image sets) | chunked upload | See the next section — the one-shot endpoints above accept at most 24MB per request |

In JSON `folder` mode, `content` is always written to disk as UTF-8 text; there is no base64 option — anything with a binary asset must go through zip or multipart. JSON `file` mode takes one of two fields: `content` (UTF-8 text, for HTML) or `base64` (bare base64, for pdf/office binaries) — **a binary sent through `content` gets mangled by UTF-8 transcoding**, and sending both fields is a 400.

The `base64` of a JSON zip must be **bare base64** (`base64 -w0 site.zip`). A `data:application/zip;base64,` prefix does not raise an error; it just decodes into garbage bytes and ends in a "not a valid zip archive" 400.

Multipart `folder` mode: multiple `files` fields, optionally paired with the same number of `paths` fields giving relative paths. **The number of `paths` must equal the number of `files` exactly**; one off and the whole batch is silently dropped, falling back to file names as paths (no error), which flattens the directory structure or breaks entry detection. Either pair every file or pair none.

### Large projects (over 24MB, e.g. pages with video): chunked upload

The one-shot endpoints read the whole request into server memory, so a single request is capped at **24MB** and larger ones get a 413. Large projects go in pieces: open a session, upload one file per request, then commit. The whole site is capped at **300MB**, a single file at **250MB**.

```bash
# 1. Open a session. This creates a new site; to add a version to an existing site use -d '{"slug":"<slug>"}' (needs edit rights on that site)
SID=$(curl -sS -X POST "$BASE/api/uploads" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"My site"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["versionId"])')

# 2. Upload file by file. --data-binary makes curl stream from disk, so no memory is used locally either.
#    The path in the URL is the path inside the site; keep the directory structure (media/demo.mp4 stays media/demo.mp4)
for f in index.html media/demo.mp4; do
  curl -sS -X PUT "$BASE/api/uploads/$SID/files/$f" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/octet-stream' --data-binary "@$f"
done

# 3. Commit. This step only picks the entry and writes the record; it does not touch the content — 300MB is as fast as 3KB
curl -sS -X POST "$BASE/api/uploads/$SID/commit" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}'
# → {"slug":"…","url":"/s/…","title":"…","kind":"folder","versionId":"…","editToken":"…"}
```

- **This route does not accept zips**: the server does not unpack. Upload the extracted files one by one, relative paths with directories included. Entry detection is the same as for a whole-tree upload (root `index.html` → the only `.html` in the site → any `*/index.html`); if no entry is found at commit time it is a 400 and the uploaded bytes are reclaimed.
- **A single large PDF also goes this way**: upload just that one `.pdf` in the session; on commit it is recognised as a document site (`kind:"document"`) automatically, the entry is a generated online reader page, visitors can page through and download the original — the PDF is never read into memory, so 250MB goes through. Chunked upload currently **accepts only PDF as a document**; Office (pptx/docx…) has to be converted to a layout in memory, so use one-shot `file` mode (within the per-request limit) or convert it to PDF first.
- **Every PUT must use the same identity as the session was opened with**. `Bearer $TOKEN` satisfies that naturally; an anonymous publish must `-c jar -b jar` to keep the cookie handed out when the session was opened, otherwise the next request is a different person and gets a 404 "upload session not found".
- A session is valid for 6 hours; when it expires it is reclaimed together with the uploaded bytes. Re-uploading the same file name overwrites; if one file fails, re-upload just that one and leave the others alone.
- Commit returns the same `slug / url / editToken` as site creation. Sharing still requires a share link (see below); in the preview page of a large file, video can be scrubbed and played directly.

### Publishing documents (pdf / office)

A single `.pdf` `.pptx` `.ppt` `.docx` `.doc` simply goes through `file` mode and produces a site of `kind:"document"`: visitors open it and **read online** directly (pdf rendered natively; office converted to a PDF layout snapshot on the server, older formats best-effort), and the page has a built-in "download original". Key points:

- **Never send pptx/docx through `zip` mode** — they are zip containers themselves, would be unpacked, and get a targeted error.
- The title defaults to the file name (extension removed); the `title` field overrides it. The file name is kept as is for downloading (non-ASCII names are fine).
- Office conversion is synchronous (the upload response takes a few seconds longer). If conversion fails, times out or this deployment has no converter configured, **the publish still succeeds** and the page degrades to a "download card" — do not hammer it with retries because of that.
- A single PDF/Office file can go through `file` mode only if it **does not exceed the per-request limit** (24MB by default); **a PDF over the limit goes through "chunked upload" in the previous section instead** (upload that one `.pdf` and commit), while Office has to be converted to PDF first. **Updating a large PDF site works the same way**: open the session with `slug`, upload just the new `.pdf` in it, and the commit lands as a new version under the same slug; a document site accepts a single PDF only and a web site accepts no documents — the wrong shape is rejected with an explicit 400.
- Document sites **have no `/edit`**: an update = whole-file re-upload with `POST /api/sites/<slug>/versions` (see section 2), landing as a new version under the same slug; share links already sent out keep working; version history and rollback work as usual.
- xlsx / xls are not accepted; pptx animations and other native interactivity are not preserved (what you see is a layout snapshot).

### The publish request: with the token; a cookie must be kept only when anonymous

With a token (the default path):

```bash
curl -sS -X POST "$BASE/api/sites" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @body.json
```

The site belongs to the user from birth, later changes use the same token, and **no site-level credential needs to be stored**.

Anonymous publishing (when the user declines to bind): creating a site needs no credential, but the response sets an anonymous identity cookie, **the only credential that can modify this site afterwards**; lose it and the site can never be changed again (see section 2). With curl, save it with `-c ah-cookies.txt`.

Quotes and newlines in the HTML must be JSON-escaped; **generate `body.json` with a script, do not build the string by hand**.

The response has at least these 6 fields:

```json
{"slug":"k4wey6sCyFcm","url":"/s/k4wey6sCyFcm","title":"Quarterly report",
 "kind":"single","editToken":"…","claimToken":"…"}
```

- `url` is a **relative path**; build the link yourself: `$BASE` + `url`
- `kind` decides how later changes work (see section 2): `paste`/HTML `file` → `single`, `folder`/`zip` → `folder`, document `file` → `document` (**not editable online**; an update = re-upload, see section 3)
- There is no `versionId` field (that one is in the edit response)
- An anonymous publish may carry an extra `notice` field — that is the platform prompting you to switch to the token flow; do what it says

### After creating the site, create a share link too

`$BASE/s/<slug>` is **the site's own address**, and only the site's owner (the user the token is bound to, or the creating cookie when anonymous) can open it. New sites on this deployment are **private** — anyone else who gets this address sees a 404, so sending it out as is means the recipient cannot open it.

So after creating the site, ask for a share link and send **that** to the people who should see it:

```bash
curl -sS -H "authorization: Bearer $TOKEN" \
  -X POST "$BASE/api/sites/<slug>/shares" \
  -H 'content-type: application/json' \
  -d '{"policy":"public"}'
# for an anonymous site use -b ah-cookies.txt -H "origin: $BASE" instead
```

```json
{"share":{"id":"…","policy":"public"},"token":"…","url":"https://…/v/…"}
```

**`policy` must be written explicitly.** Left out, it defaults to `login`, and that link then requires a login to open. Four levels:

| policy | Who can open it |
| --- | --- |
| `public` | Anyone with the link, no login |
| `login` | Any logged-in user (**the default when policy is omitted**) |
| `email` | Only the named email addresses |
| `passcode` | Whoever enters the right passcode (the response carries the generated code back) |

The `url` in the response is a full address, and **this is the one to give the user**. The `token` is readable only in this one response; if it is lost, create a new one
(which is also exactly how an old link is revoked).

> If new sites on this deployment are public by default (usually the case on an intranet), `$BASE/s/<slug>` itself can be sent directly.
> When unsure, verify once as described in section 4 below instead of guessing.

### What the three kinds of address are

- `$BASE/s/<slug>` — the site itself, with the platform chrome (title, version history, edit entry). On a private deployment only the owner and the people it is shared with can open it.
- `$BASE/v/<token>` — the share link, **the one for readers** (the policy decides who can open it).
- `$BASE/api/preview/<slug>` — the raw artifact, suitable for embedding in an iframe. With a trailing slash it **308-redirects** to the form without one and **drops the query string**; use the slash-free form directly in scripts.

## 2. Making changes after publishing

The conclusions first (the two cookie rows are the most counter-intuitive):

| What you hold | Can you change it |
|---|---|
| **The publish token** (`Bearer $TOKEN`, the site belongs to this user) | ✅ No `Origin` needed, no cookie needed |
| The cookie from creation **+ an `Origin` request header** | ✅ |
| The cookie from creation, but no `Origin` | ❌ 401 |
| Only the `editToken` | ⚠️ **403** on deployments with ownership enforcement on |
| Nothing at all | ❌ 403 |

`editToken` is the old mechanism. Once a deployment turns on ownership enforcement (`ARTIFACT_ENFORCE_OWNERSHIP=on`, the recommended setting wherever sign-in exists), carrying it still gets a 403.

**Changing content** (produces a new immutable version; old versions can still be rolled back to). The shape of the request body is decided by `kind`; the wrong shape is a 400. **`kind=document` does not use `/edit`** (that is a 400) — re-upload the whole file to `/versions`, see below:

```bash
# kind=single: replace the whole page (token form; for an anonymous site use -b ah-cookies.txt -H "origin: $BASE" instead)
curl -sS -H "authorization: Bearer $TOKEN" \
  -X POST "$BASE/api/sites/<slug>/edit" \
  -H 'content-type: application/json' \
  -d '{"content":"<!doctype html>…the complete HTML…"}'

# kind=folder: replace just one file in it
curl -sS -H "authorization: Bearer $TOKEN" \
  -X POST "$BASE/api/sites/<slug>/edit" \
  -H 'content-type: application/json' \
  -d '{"path":"assets/app.js","content":"…"}'

# kind=document: re-upload the whole file (a new version under the same slug, share links unchanged; office is re-converted for preview)
curl -sS -H "authorization: Bearer $TOKEN" \
  -X POST "$BASE/api/sites/<slug>/versions" \
  -F mode=file -F 'file=@quarterly-report-v2.pptx'
```

The same usage applies to: rename `PATCH /api/sites/<slug>` `{"title":"…"}`, delete `DELETE /api/sites/<slug>`, roll back `POST /api/sites/<slug>/rollback` `{"versionId":"…"}`, save a copy `POST /api/sites/<slug>/fork`. A delete is soft: the files are kept for a retention window (30 days by default) and an administrator can restore the site. **Cookie-based mutating requests must carry `Origin`** (leaving it out is always a 401); the token form does not need it. The token can only change sites **owned by this user** — changing someone else's site or an anonymous site is still a 403; do not treat it as a master key.

Read-only calls need no credential: `GET /api/sites/<slug>`, `GET /api/sites/<slug>/versions`.

**When the original cookie is unavailable**, do not try to work around it — publish a new site and give the user the new link.

⚠️ Stop saying "the old link still works": on a deployment where new sites default to private, once the cookie is lost that site **cannot be opened by anyone**,
including you and the user, and `editToken` cannot rescue it either (on deployments with ownership enforcement it does not even grant read access). Share links already sent out
keep working, but you can never change it or revoke it again. So **the creation response and the cookie file must be saved on the spot**. `POST /api/sites/<slug>/fork` can also copy it into a new site that you own (the cookie form likewise needs `-b` + `Origin`).

**None of this trouble exists once an identity is bound**: the token lives in `~/.config/artifact-site/tokens/<host>` (or `ARTIFACT_SITE_TOKEN`), stays valid across sessions for a long time, and a site owned by the user can be changed at any time. So prefer the device authorisation of section 1; the cookie is only the fallback when the user declines to bind.

### Editing an existing site again (pull the source → change locally → write the whole tree back)

**Without a publish token, go back to section 1 and do the device authorisation first** (half a minute, valid long-term) — every step of re-editing needs `Bearer $TOKEN`, and the site must belong to this user (changing someone else's site is a 403, not a mistake on your side).

**Look at the site's shape first; it decides which route to take — not the size of the change:**

- **Single-file site (`kind:"single"`) → read the source, change it, submit with one `/edit`.** The vast majority of "select a region and change it" edits land here. The whole site is one HTML file; one `/edit` is a complete version by itself, there is no such thing as "accumulating intermediate versions", and no packaging is needed.
- **File-tree site (`kind:"folder"`) with several files to change → the whole-tree loop.** Each `/edit` can change only one file and lands as its own version, so a multi-file change piles up a string of intermediate versions and may interleave with someone else's saves; one whole-tree commit is one complete version.

The shape is the `kind` field of `GET /api/sites/<slug>` (an embedded assistant receives it as `artifactHub.kind`). Both routes start from the same export (zip is the only read surface), and both honour the same `expected_version`.

**Do not assume the environment has `unzip` / `zip`.** Cloud sandbox images often have neither — in practice this is exactly where things get stuck, at unpacking. `python3 -m zipfile` is the standard-library equivalent, and it is used throughout below; if the environment really has unzip/zip, switching back is entirely equivalent.

```bash
# 1. Pull the complete source of the current version (zip) and note the version baseline from the response headers
curl -sS -D headers.txt -H "authorization: Bearer $TOKEN" \
  -o site.zip "$BASE/api/sites/<slug>/export"
BASE_VERSION=$(grep -i '^x-artifact-version:' headers.txt | tr -d '\r' | awk '{print $2}')

# 2. Unpack (no unzip needed). Keep the site's shape while editing: a single site stays a single HTML file, a folder site stays a file tree
python3 -m zipfile -e site.zip src/
#    …edit the files in src/ as required…

# 3a. Single-file site: one /edit and done, no packaging
#     The `&&` is not optional: if generating body.json fails, the curl after it would submit the leftovers of the previous round,
#     silently writing old content back into the site, which is far worse than failing outright
python3 - <<'PY' > body.json && \
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "$BASE/api/sites/<slug>/edit?expected_version=$BASE_VERSION" -d @body.json
import json, pathlib, sys
htmls = sorted(pathlib.Path("src").rglob("*.html"))
if not htmls:
    # The most common cause is not that the site really has no HTML, but that step 1 never got a zip:
    # on a 403/404 curl still writes the error JSON into site.zip, unpacking fails silently, and src/ is empty
    sys.exit("No .html in src/. First confirm site.zip is really a zip (file site.zip / head -c 4 site.zip) and that $TOKEN has edit rights on this site")
print(json.dumps({"content": htmls[0].read_text(encoding="utf-8")}))
PY

# 3b. File-tree site: write the whole tree back, same as zip mode at creation. The single wrapper directory that -c produces is flattened by the platform automatically;
#     no need to worry about excluding node_modules/.git — the exported tree never contained them
python3 -m zipfile -c site-v2.zip src/ && \
curl -sS -H "authorization: Bearer $TOKEN" \
  -X POST "$BASE/api/sites/<slug>/versions?expected_version=$BASE_VERSION" \
  -F mode=zip -F 'file=@site-v2.zip'
```

- Success returns the new `versionId`; the old version stays in the version history and can be rolled back to at any time — edit with confidence.
- **`expected_version` accepts a version id only (the `ver_…` string), not the version number**. It has two equivalent sources: the export response header `x-artifact-version`, or, when driven from an embedded assistant, `artifactHub.versionId` in the context it is handed. **Do not put the number from `artifactHub.version` in there** — the number is the human-facing "version N", filling it in is guaranteed to 409, and the API stops you with a targeted error.
- **403 (`quota_exceeded`) = the owner's cap is reached** (`details.kind` is `sites` or `bytes`, with `limit` / `used` / `requested`). Do not retry: tell the user, and offer to publish a new version of an existing site instead of a new site, or to delete sites they no longer need.
- **409 (`version_conflict`) = someone committed first while you were editing** (the web editor, another agent). The response carries the current `currentVersionId`. **Do not add force, do not retry blindly**: go back to step 1, export again, apply your change on top of the new version, and commit again.
- `expected_version` may be omitted (omitted = last write wins), but **always include it when changing content on the user's behalf** — silently overwriting what someone else just saved is far worse than failing once.
- **Both write paths honour this parameter**: whole-tree re-upload `POST …/versions?expected_version=<id>`, single-file change `POST …/edit?expected_version=<id>`. Semantics, errors and the 409 are identical; pick the endpoint by site shape, no detour is needed to get the lock.
- The site's shape is immutable: writing back a single site must still be a single HTML file, a folder site must still be a file tree, otherwise 400.
- Document sites (`kind:"document"`) are outside this section: just re-upload the whole file (see above); there is no export — the original is already in the page's "download original".



## 3. Platform limits on artifacts

Artifacts are treated as untrusted content and run in a `sandbox`, an isolated environment **without `allow-same-origin`** (an opaque origin). Everything below is a tested conclusion.

### Must be excluded before packaging

`node_modules` and `.git` (at any depth, case-insensitive) make **the entire upload fail with a 400** — a rejection, not a skip:

```bash
zip -r site.zip dist -x '*/node_modules/*' '*/.git/*'
```

In an environment without the `zip` command (common in cloud sandboxes), use the standard library instead. Note that `python3 -m zipfile -c` does not support exclusion patterns,
while exclusion is a hard requirement (one stray `node_modules` and the whole package is a 400), so this needs the script rather than that one-liner:

```bash
python3 - <<'PY'
import pathlib, zipfile
SKIP = {"node_modules", ".git", "__MACOSX"}
root = pathlib.Path("dist")
with zipfile.ZipFile("site.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in root.rglob("*"):
        if f.is_file() and not SKIP & set(f.parts):
            z.write(f, f.relative_to(root.parent))
PY
```

`__MACOSX`, `.DS_Store` and `Thumbs.db` are stripped automatically; no need to deal with them.

### Paths and references

- **Absolute-path assets always 404** — `/assets/x.js` resolves to the platform root, which is the platform's own routing. **Vite defaults to `base:'/'` and CRA to absolute paths, so uploading `dist/` as is gives a blank page**. Vite needs `base:'./'`, CRA needs `"homepage":"."`, then rebuild before uploading.
- The `<base>` injected by the platform is always the **site root**, regardless of which level the page sits at. So in a multi-page site, `./sub.css` in `sub/page.html` requests `sub.css` in the root directory → 404. **Write every reference as a path relative to the site root**.
- A `<base>` written by the artifact itself is ignored (the injected one comes first).
- **Any path segment starting with a dot** (`.well-known/`, `.nojekyll`) returns 400 and can never be fetched.
- A single wrapper directory is flattened automatically: `dist/index.html` → `index.html`.

### Files and the entry

- Entry selection order: `index.html` in the root → the only `.html` in the site → any `*/index.html`. No `.html` at all, or several `.html` without an `index.html`, is a 400. **Multi-file sites must have an `index.html` in the root**.
- **`.htm` does not count as HTML** — it is served as a binary download and gets no base injected. Always use `.html` for pages.
- Files outside the extension allow list are served as `application/octet-stream` + `nosniff`; **scripts/styles do not execute**. The allow list: `.html .css .js .mjs .json .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2 .ttf .otf .mp4 .webm .mov .mp3 .m4a .ogg .wav .txt .xml .wasm .pdf .doc .docx .ppt .pptx`. Frequent surprises: **`.cjs` `.jsx` `.webmanifest` `.csv` `.md` `.avif` are all missing from it**.
- **The entry HTML must contain a literal `<head>` tag**. Without it the injected content is prepended before `<!doctype>`, the browser enters quirks mode and the layout breaks.

### APIs unavailable at runtime (all throw SecurityError)

- `document.cookie` (both read and write throw)
- `indexedDB.open()` (`typeof indexedDB` is object, **but any open throws**)
- `caches` — reading the property itself throws
- `navigator.serviceWorker` — reading the property itself throws; the whole PWA/offline-cache stack is unusable
- `new Worker('./w.js')` — the URL form throws; **`new Worker(URL.createObjectURL(blob))` works**
- Cross-window access (`parent` / `top` / `opener`)
- `fetch` of the platform's own API (e.g. `/api/sites`) — TypeError; only `/api/preview/*` carries CORS headers

### Usable but not persistent

`localStorage` / `sessionStorage` are backed by an in-memory shim: **calls do not throw, but everything resets on every load**, and only `getItem/setItem/removeItem/clear/key/length` are implemented (property-style writes like `localStorage.foo = 'x'` are not remembered). Artifacts must not rely on them to keep user data.

`Notification` exists but permission requests are dropped; do not treat it as a feature switch.

### Works normally

Inline and external `<script>`, `type="module"` module scripts, dynamic `import()`, JS/CSS/fonts from external CDNs, `fetch` of relative in-site assets and external APIs, `crypto`, form submission, popups, downloads.

> Operations note: if the deployment sets `CSP_CONNECT_SRC`, it is an **exclusive allow list** — once enabled, an artifact's `fetch` of its own files is cut off too. Either leave it unset, or include the artifact's own origin in it.

### Size, count, rate

- One version totals at most **300MB**, a single file **250MB**, at most **2000** files (deployment-adjustable); but the one-shot upload endpoints take **24MB per request**, beyond which use the "chunked upload" section
- Rate limiting defaults to roughly 20 burst / 30 per minute, **counted per client IP, with creation/edit/fork sharing the same allowance**. Several agents behind the same egress IP crowd each other out

## 4. What to do when it fails

The response body is JSON `{"error":"…"}`. **Read the message before deciding**; the status code alone is not enough to tell the cause:

| Status | Meaning and action |
|---|---|
| 400 | The most common, with many causes: wrong mode/fields, no entry HTML found, unsafe path (`node_modules`, `.git`, dot-leading segment), corrupt zip. **Limit violations can land here too** — the messages are `site too large` / `too many files` / `file too large`. Fix according to the message, do not retry. |
| 401 | The cookie form without `Origin` (or a value differing from `$BASE`); add `-H "origin: $BASE"`. A 401 in the token form = the token was not recognised (check that `Bearer ahp_…` is complete) **or has been revoked** — follow the error message and walk the user through the device authorisation again; do not sneak past with an anonymous publish (the site would not belong to the user). |
| 403 | No permission to change: wrong cookie, or only an `editToken` on a deployment with ownership enforcement. See section 2. |
| 413 | **JSON body** = the app refused an inline request body exceeding `ARTIFACT_INLINE_UPLOAD_MAX_BYTES` (default 24 MiB), checked against both Content-Length and actual bytes read; **HTML error page** = the gateway refused it (the request never reached the app; the operator needs to raise the gateway's request body limit). |
| 429 | Rate limited. **There is no `Retry-After` in the response**; back off and retry on your own. |
| 5xx | Retry once; on repeated failure give the user the status code and response body instead of retrying over and over. |

Checks run in the order **429 → 401/403 → 413 → parsing**, so with bad credentials you never see a size error.

**Verify once yourself after a successful publish**; do not stop at the 200:

```bash
# Verify without credentials — this is what the user sees
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/v/<token>"     # share link, expect 200
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/s/<slug>"      # site address, 404 on a private deployment
```

**Do not verify with `-b ah-cookies.txt`**: with the owner's cookie everything is 200, which verifies nothing.
Hand the share link to the user only after it returns 200. To check that the artifact really renders (no blank page), it is best to fetch `$BASE/api/preview/<slug>` once more and confirm the key content is there.

## 5. Delivering to the user

For a token-based publish (the default path), two things are enough:

1. **The share link** (`/v/<token>`; on a public deployment give `/s/<slug>` directly)
2. The `slug`, for later changes

The site is already under the user's account; the user can see it and edit it themselves in their account page, and there is no credential to keep.

For an anonymous publish (when the user declined to bind), give at least three things:

1. **The share link**
2. **The location of the credential file** (e.g. `ah-cookies.txt`), stating clearly: **keep this file: without it, you lose this publishing session's access; an administrator must help recover an unowned site**
3. The `slug`

Do not paste the `editToken` into the conversation body — it is equivalent to the right to modify this site. Write it to a file, or tell the user to keep it safe.

### Attaching an unowned site to an account

**A site published with a personal token is under that user's account from birth; skip this section.** Anonymous publications, operator-token publications and historical unowned sites may need ownership assignment or transfer — ask proactively when delivering: "Do you want to attach this site to your account?" If not, stop here; if yes, use the creating session to transfer ownership, or ask an administrator to assign an unowned site as described below. **Do not improvise with "fork a copy and delete the old site"**: a fork copies only the current version, the history is cut off, the slug changes, and every link already sent out becomes invalid.

**If you still have the creating session: transfer to the user’s account**

```bash
curl -sS -b ah-cookies.txt -H "origin: $BASE" \
  -X POST "$BASE/api/sites/<slug>/ownership" \
  -H 'content-type: application/json' \
  -d '{"email":"login email of the user on the platform"}'
```

- **Read the email back to confirm it** — a transfer hands over control, and if it goes to the wrong person you no longer have the right to transfer it back.
- 404 (`user_not_found`) = this email has never logged in to the platform (or the email is unverified). Have the user log in at `$BASE` once, then re-run the same command.
- **Do it after everything else is finished**: on a deployment with ownership enforcement, the moment the transfer takes effect your cookie and `editToken` can no longer touch this site — finish the changes, let the user accept them, and transfer last.
- Success returns `{"ok":true,"ownerId":"…"}`. The delivery checklist is then shorter: give the link and the `slug`; the credential file is void after the transfer; tell the user the site is in their "My sites" and further changes are made by the user in the page editor.

Open claiming by site address is disabled. Do not send `/me#claim=…` links or call
`POST /api/sites/:slug/claim` (410). Personal-token publications already belong to that user.
Signing in from the original creating browser can still adopt that browser's own anonymous sites.

#### If the creating session is lost: ask the user to contact an administrator

For an operator-created or historical unowned site, tell the user to ask an administrator to
open **Administration → Sites → Assign owner** and enter the verified email of their existing,
active account. Provide the site address and intended recipient email so the administrator can
check the request. This keeps the original address and version history; existing owners cannot
be overwritten through assignment.

A personal Agent token does not carry email-administrator privileges. Do not retry the retired
claim endpoint or ask the user to paste an administrator credential into chat. Email administrators
can use the console even when PUBLISH_API_TOKEN is unset. Administrator API instructions are in
SELFHOST.md; this recovery step requires an authorized administrator.

## 6. Finding and reading sites that already exist

Two read-only calls, for when the user asks "what did we publish about X?", "update the report from last week", or wants the content of a site without a download. Both take the token (or nothing, on a public deployment for public sites) and answer with the same `X-Artifact-Site-Skill-Version` header as everything else.

```bash
# Search: every word must occur in the site's current text (title matches rank first; Chinese works)
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/search?q=quota%20settings&limit=10"
# → {"query":"quota settings","results":[{"slug":"…","title":"…","kind":"single","visibility":"private",
#    "updatedAt":…,"url":"/s/…","snippet":"…the passage around the first match…"}]}

# Read: the current version as plain text (HTML stripped; pdf / docx / pptx text extracted)
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sites/<slug>/text?max_chars=20000"
# → {"slug":"…","url":"/s/…","title":"…","kind":"…","versionId":"…","file":null,"chars":48211,"truncated":true,"text":"…"}
# `truncated: true` means there is more: raise max_chars (up to 300000) or read a single file:
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sites/<slug>/text?file=src/app.js"
# text types only (html, css, js, json, md, csv, …, up to 2MB); anything else answers 415 — export the zip instead
```

- Search covers what the token's owner may list: their own sites, sites they may edit, and public ones. A private site that is reachable only through a share link is deliberately not searchable.
- A site published seconds ago may not be searchable yet (its text is extracted right after the upload); reading it works immediately.
- To change what you found: `versionId` from the read is the baseline for `expected_version` in section 2, exactly like the export's.
- With the CLI: `artifact-site find <words…>` and `artifact-site read <slug> [--file <relpath>] [--max-chars <n>]`; over MCP: `artifact_site_find` and `artifact_site_read`.
