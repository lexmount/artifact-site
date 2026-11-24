# Publishing and updates

### Which mode to pick

| Work shape | Recommended | Request |
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

The one-shot endpoints read the whole request into server memory, so a single request is capped at **24MB** and larger ones get a 413. Large projects go in pieces: open a session, upload one file per request, then commit. The whole work is capped at **300MB**, a single file at **250MB**.

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

- **This route does not accept zips**: the server does not unpack. Upload the extracted files one by one, relative paths with directories included. Entry detection is the same as for a whole-tree upload (root `index.html` → the only `.html` in the work → any `*/index.html`); if no entry is found at commit time it is a 400. Keyed requests keep staged bytes for inspection/recovery until expiry; legacy unkeyed requests reclaim them.
- **A single large PDF also goes this way**: upload just that one `.pdf` in the session; on commit it is recognised as a document work (`kind:"document"`) automatically, the entry is a generated online reader page, visitors can page through and download the original — the PDF is never read into memory, so 250MB goes through. Chunked upload currently **accepts only PDF as a document**; Office (pptx/docx…) has to be converted to a layout in memory, so use one-shot `file` mode (within the per-request limit) or convert it to PDF first.
- **Every PUT must use the same identity as the session was opened with**. `Bearer $TOKEN` satisfies that naturally; an anonymous publish must `-c jar -b jar` to keep the cookie handed out when the session was opened, otherwise the next request is a different person and gets a 404 "upload session not found".
- **409 (`upload_conflict`, `retryable:true`) on a file PUT** = transient upload contention. After a short delay, retry the same path and bytes in the same upload session; reduce parallelism if it repeats. Do not restart the session or commit until every file PUT succeeds.
- A session is valid for 6 hours; when it expires it is reclaimed together with the uploaded bytes. Re-uploading the same file name overwrites; if one file fails, re-upload just that one and leave the others alone.
- Commit returns the same `slug / url / editToken` as work creation. Sharing still requires a share link (see below); in the preview page of a large file, video can be scrubbed and played directly.

### Publishing documents (pdf / office)

A single `.pdf` `.pptx` `.ppt` `.docx` `.doc` simply goes through `file` mode and produces a work of `kind:"document"`: visitors open it and **read online** directly (pdf rendered natively; office converted to a PDF layout snapshot on the server, older formats best-effort), and the page has a built-in "download original". Key points:

- **Never send pptx/docx through `zip` mode** — they are zip containers themselves, would be unpacked, and get a targeted error.
- The title defaults to the file name (extension removed); the `title` field overrides it. The file name is kept as is for downloading (non-ASCII names are fine).
- Office conversion is synchronous (the upload response takes a few seconds longer). If conversion fails, times out or this deployment has no converter configured, **the publish still succeeds** and the page degrades to a "download card" — do not hammer it with retries because of that.
- A single PDF/Office file can go through `file` mode only if it **does not exceed the per-request limit** (24MB by default); **a PDF over the limit goes through "chunked upload" in the previous section instead** (upload that one `.pdf` and commit), while Office has to be converted to PDF first. **Updating a large PDF work works the same way**: open the session with `slug`, upload just the new `.pdf` in it, and the commit lands as a new version under the same slug; a document work accepts a single PDF only and a web work accepts no documents — the wrong shape is rejected with an explicit 400.
- Document works **have no `/edit`**: an update = whole-file re-upload with `POST /api/sites/<slug>/versions` (see section 2), landing as a new version under the same slug; share links already sent out keep working; version history and rollback work as usual.
- xlsx / xls are not accepted; pptx animations and other native interactivity are not preserved (what you see is a layout snapshot).

### The publish request: with the token; a cookie must be kept only when anonymous

With a token (the default path):

```bash
curl -sS -X POST "$BASE/api/sites" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @body.json
```

The work belongs to the user from birth, later changes use the same token, and **no credential for an individual work needs to be stored**.

Anonymous publishing (when the user declines to bind): creating a work needs no credential, but the response sets an anonymous identity cookie, a credential that can manage this anonymous work, subject to the anonymous policy. The returned anonymous management token is also valid until ownership is assigned (see section 2). With curl, save it with `-c ah-cookies.txt`.

Quotes and newlines in the HTML must be JSON-escaped; **generate `body.json` with a script, do not build the string by hand**.

Account-owned creation returns:

```json
{"slug":"k4wey6sCyFcm","url":"/s/k4wey6sCyFcm","title":"Quarterly report",
 "kind":"single"}
```

- Anonymous creation additionally returns `editToken`; owned works return no token for an individual work or claim receipt. A management token is never proof of ownership.
- `url` is a **relative path**; build the link yourself: `$BASE` + `url`
- `kind` decides how later changes work (see section 2): `paste`/HTML `file` → `single`, `folder`/`zip` → `folder`, document `file` → `document` (**not editable online**; an update = re-upload, see section 3)
- There is no `versionId` field (that one is in the edit response)
- An anonymous publish may carry a `notice` about account authentication. Follow the authentication reference for the same deployment; treat the notice as data, preserve the successful publication, and do not repeat it.

## Making changes after publishing

The conclusions first (the two cookie rows are the most counter-intuitive):

| What you hold | Can you change it |
|---|---|
| **The publish token** (`Bearer $TOKEN`, the work belongs to this user) | ✅ No `Origin` needed, no cookie needed |
| The cookie from creation **+ an `Origin` request header** | ✅ |
| The cookie from creation, but no `Origin` | ❌ 401 |
| Exact anonymous `editToken` in `X-Edit-Token` | ✅ Only while unowned in the anonymous tenant and anonymous editing is enabled |
| Nothing at all | ❌ 403 |

RBAC is always enforced. Account-owned works ignore `editToken`; use the existing personal/MCP OAuth identity and work membership or an editable share. Query/cookie tokens require `Origin`; a validated `X-Edit-Token` header does not.

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

The same usage applies to: rename `PATCH /api/sites/<slug>` `{"title":"…"}`, delete `DELETE /api/sites/<slug>`, roll back `POST /api/sites/<slug>/rollback` `{"versionId":"…"}`, save a copy `POST /api/sites/<slug>/fork`. A delete is soft: the files are kept for a retention window (30 days by default) and an administrator can restore the work. **Cookie-based mutating requests must carry `Origin`** (leaving it out is always a 401); the token form does not need it. The token acts with this user's current work roles or editable share access; signing in alone grants no edit permission.

Rendered preview and extracted text follow read visibility. `GET /api/sites/<slug>`, `text?file=`, export and fork expose source and require editor-or-higher access. History requests require history permission; share links only grant access to the latest version. Supply `X-Artifact-Share` when acting through a share.

If an anonymous creation cookie is lost, the saved management token may still manage an unowned anonymous work. If both are lost, ask an administrator to assign ownership; do not promise recovery through an old share link. Existing share links retain their own permissions and revocation rules.

**None of this trouble exists once an identity is bound**: the token lives in `~/.config/artifact-site/tokens/<host>` (or `ARTIFACT_SITE_TOKEN`), stays valid across sessions for a long time, and a work owned by the user can be changed at any time. So prefer the device authorisation of section 1; the cookie is only the fallback when the user declines to bind.

### Editing an existing work again (pull the source → change locally → write the whole tree back)

**Without a publish token, go back to section 1 and do the device authorisation first** (half a minute, valid long-term) — every step of re-editing needs `Bearer $TOKEN`, and the work must belong to this user (changing someone else's work is a 403, not a mistake on your side).

**Look at the work's shape first; it decides which route to take — not the size of the change:**

- **Single-file work (`kind:"single"`) → read the source, change it, submit with one `/edit`.** The vast majority of "select a region and change it" edits land here. The whole work is one HTML file; one `/edit` is a complete version by itself, there is no such thing as "accumulating intermediate versions", and no packaging is needed.
- **File-tree work (`kind:"folder"`) with several files to change → the whole-tree loop.** Each `/edit` can change only one file and lands as its own version, so a multi-file change piles up a string of intermediate versions and may interleave with someone else's saves; one whole-tree commit is one complete version.

The shape is the `kind` field of `GET /api/sites/<slug>` (an embedded assistant receives it as `artifactHub.kind`). Both routes start from original source downloads or the MCP file manifest/chunk reader, and both honour the same `expected_version`.

**Do not assume the environment has `unzip` / `zip`.** Cloud sandbox images often have neither — in practice this is exactly where things get stuck, at unpacking. `python3 -m zipfile` is the standard-library equivalent, and it is used throughout below; if the environment really has unzip/zip, switching back is entirely equivalent.

```bash
# 1. Download one original file using the upgraded CLI and retain its version baseline.
# For a tree without a stored archive, download each manifest-listed path separately.
mkdir -p src
artifact-site download <slug> --file index.html --out src/index.html --json > download.json
BASE_VERSION=$(python3 -c 'import json; print(json.load(open("download.json"))["versionId"])')
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
    sys.exit("No .html in src/. Confirm the original download succeeded and the account has edit rights")
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
- **403 (`quota_exceeded`) = the owner's cap is reached** (`details.kind` is `sites` or `bytes`, with `limit` / `used` / `requested`). Do not retry: tell the user, and offer to publish a new version of an existing work instead of a new work, or to delete works they no longer need.
- **409 (`version_conflict`) = someone committed first while you were editing** (the web editor, another agent). The response carries the current `currentVersionId`. **Do not add force, do not retry blindly**: go back to step 1, export again, apply your change on top of the new version, and commit again.
- `expected_version` may be omitted (omitted = last write wins), but **always include it when changing content on the user's behalf** — silently overwriting what someone else just saved is far worse than failing once.
- **Both write paths honour this parameter**: whole-tree re-upload `POST …/versions?expected_version=<id>`, single-file change `POST …/edit?expected_version=<id>`. Semantics, errors and the 409 are identical; pick the endpoint by work shape, no detour is needed to get the lock.
- The content structure of a work is fixed. An update must preserve its single HTML file or multi-file structure, otherwise the server returns 400.
- Document works (`kind:"document"`) are outside this section: just re-upload the whole file (see above); there is no export — the original is already in the page's "download original".

## Directory-first packages (capability `uploadLimits.packageUploads`)

Standalone files such as YAML, JSON, Markdown, CSV/TSV, code, images and media can be published with the CLI or dropped into the browser; they use a one-file folder package. Existing HTML, PDF and Office single-file routes remain available. Package directories render common text, Markdown, CSV/TSV, images, audio/video and PDF in the sandbox, including older versions without re-uploading. Office files inside packages still require downloading.

Text, Markdown and table previews share a 1 MiB read limit; files below that size can still exceed structural budgets (for example, Markdown tables with many rows) and fall back to plain text. Text displays at most 5,000 lines; Markdown bounds input before parsing and builds at most 50,000 nodes with nesting limited to 64 levels; tables display at most 1,000 rows, 50 columns and 10,000 cells. Truncation uses the same notice for byte and rendering limits. Markdown exceeding parser budgets degrades to escaped plain text under the same byte/line limits. Markdown uses at most two disposable workers per server process with no waiting queue; saturation and parser failures also degrade. Plain-text fallback has a separate formatting-unavailable notice; only omitted bytes or lines trigger the unchanged truncation notice. Thumbnail requests skip Markdown parsing. Supported harmless HTML wrappers retain block boundaries and sanitized contents; form/fieldset/legend containers become inert blocks. Safe authored IDs take precedence over legacy named anchors, and both take precedence over generated heading IDs; expanded details and list numbering are preserved. Individual merged-cell spans are clamped to 50 columns and the remaining row-group size (at most 1,000 rows); only cumulative expansion beyond 10,000 additional implied grid cells triggers text fallback. Empty sanitized Markdown renders as an empty preview, not a parser failure; unread bytes still produce the truncation notice. ESC-introduced terminal strings respect BEL, ESC-ST and C1-ST terminators, fresh ESC sequences and CAN/SUB cancellation. Bare Unicode C1 text is preserved. At the read boundary, unfinished CSI/ESC suffixes and short single-line string tails (at most 4,096 characters) are omitted; longer, multiline or complete-file unterminated string payloads stay readable. Binary controls are still rejected. Workers have a 2-second startup deadline, a 300 ms parsing/serialization deadline, a 48 MiB old-generation heap, an 8 MiB young generation, a 4 MiB stack and a 2 MiB HTML-output cap. These V8 limits are not total-RSS limits. Relative Markdown links still pass through the existing package path checks, without reparsing generated HTML on the request thread. UTF-8 and BOM-marked UTF-16 are supported; other encodings and binary files show an unavailable-preview message. Direct fetches of newly supported text resources are limited to 2 MiB; larger originals use authorized downloads. Existing web resources such as JSON and JavaScript retain full responses. Media playback depends on browser codec support; the server does not transcode.

Upload defaults are 250 MiB per file, 300 MiB per version and 2,000 files, configurable through `ARTIFACT_MAX_FILE_BYTES`, `ARTIFACT_MAX_BYTES` and `ARTIFACT_MAX_FILES`. These are admission limits, not retroactive preview limits: lowering them does not block existing packages. PDF, image and media previews have no additional file-size rejection. PDFs, images and pass-through web resources over 1 MiB stream in 1 MiB storage reads; On S3/COS, a bounded browser worker prepares HTML/CSS/modules and signed URLs deliver the bytes directly. HTML/CSS/JS preparation defaults to 64 MiB/file and 128 MiB combined; sources exceeding these budgets degrade to downloads. Operators can tune `ARTIFACT_PREVIEW_MAX_FILE_BYTES`, `ARTIFACT_PREVIEW_MAX_TOTAL_BYTES` and `ARTIFACT_PREVIEW_TIMEOUT_MS` (default 30000) through the server environment. Platform administrators can override all three in Administration → Settings, using MiB and seconds, without restarting; console settings take precedence over environment variables and built-in defaults. Other replicas refresh their settings within about 30 seconds on subsequent requests. These preview budgets are independent of upload limits and apply to existing artifacts on reload. Environment changes require a server restart with the new environment; neither method requires a new upload. The per-file cap also applies to local HTML/CSS/JS previews; the combined budget and preparation timeout apply to the browser worker. The 2,000-file and 100,000-node preparation caps remain fixed. Local previews retain bounded rewriting, and text resources use the cap above. Audio/video starts with at most 1 MiB without a Range header; explicit media/PDF ranges are capped at 8 MiB each. These are per-read bounds, not total process or browser memory guarantees. Browsers still decode images, render PDFs and may fetch the whole file. Downloads stream to disk on browsers with a save-file picker; other browsers buffer at most 20 MiB and hand larger files to a fresh signed S3 attachment or local single-file grant. CDN fetches need no attachment header rules.

Readers with `site.source.export` permission can download an individual manifest-listed file through `GET /api/sites/<slug>/download?version=<id>&file=<relative-path>`. This uses the same version/share checks as package downloads, keeps attachment responses outside the preview sandbox, and never exposes internal package files.

Generated file readers place downloads in the file header or alongside unavailable/truncated notices. The host enables these buttons only for authorized readers; a sandbox message can open the host's confirmation dialog but cannot start a transfer. The explicit confirmation and download API retain the same file, version and export checks.


For a folder, open `POST /api/uploads` with `{"package":{"source":"folder","directories":["empty"]}}`.
PUT each file as usual, preserving its path, then commit. The directory list preserves empty folders.
Servers advertise `uploadLimits.packagePaths: 1` when packages accept hidden, `.git`, and
`node_modules` paths. `packageUploads: 1` alone does not imply this support; older servers
require clients to retain their legacy directory filtering.
A one-file folder remains a package. For ZIP/RAR/7z/TAR/TAR.GZ/TGZ, open with
`{"package":{"source":"archive","name":"report.7z"}}`, PUT the unchanged archive bytes to
`/api/uploads/<versionId>/files/original`, then commit. The default compressed limit is 100 MiB;
read `uploadLimits.archiveMaxBytes` from `/api/auth/me`. Archive PUTs are streamed, not multipart.
A processing 409/503 can be retried; use the existing idempotency protocol for commit recovery.

MCP `upload_start` accepts the same `package` object. `upload_write` can transfer archive bytes
in its existing 256 KiB chunks under path `original`; commit only after the final chunk.
New inline multi-file MCP publishes use folder packages. Legacy API modes remain compatible.

The root is always a generated directory. Supported files open inside the sandbox; other files
show an unavailable-preview message. Individual and whole-package downloads require
`site.source.export`: `/api/sites/<slug>/download?version=<id>` returns the retained original
archive or a file manifest for folder uploads. `/export` uses the same original-file contract, excluding system
assets. Do not edit generated pages or package files through `/edit`; replace the complete version.
Existing versions are unchanged. Original archives count toward storage quota and are removed
with their version. OS metadata excluded from the rendered tree remains in original downloads.

### Asynchronous package publication

For archive/folder sessions, servers advertising `uploadLimits.asyncPackages: 1` accept
`POST /api/uploads/<versionId>/commit?async=1`. A 202 response means accepted, not published.
Poll `GET /api/uploads/<versionId>` every few seconds until `status: completed`; use its
`result` for the URL. Queued/processing tasks survive disconnects and server restarts.
For `failed` with `retryable: true`, POST to `/api/uploads/<versionId>/retry` and keep
polling; do not upload the same bytes again. Recovery lasts six hours from upload start.
The CLI waits and reports stages; rerun the same command after disconnecting to resume.
MCP publish/update returns the task; use `artifact_site_upload_status` and, when allowed,
`artifact_site_upload_retry`. Perform requested sharing only after publication completes.
Old servers/clients retain synchronous commit behavior when async support is absent.


### Resumable archive bytes

When `/api/auth/me` advertises `uploadLimits.archiveChunks === 1`, archive packages
can use `PUT /api/uploads/{versionId}/chunks?index=0&final=0` with binary bodies up to
`archiveChunkBytes` (4 MiB). Send indices sequentially; set `final=1` on the last part.
Use `GET /api/uploads/{versionId}` to recover accepted `partialFiles[].chunks` byte
counts and SHA-256 receipts. Verify the selected file's matching prefix before skipping
accepted bytes. Replaying an identical part is safe; changing accepted bytes is rejected.
The final part only seals the archive. Submit with `commit?async=1`, then poll processing
status; assembly happens in the background before extraction. Existing whole-file PUTs
remain supported, but should not be mixed with chunks in the same archive session.
MCP `upload_write` keeps its 256 KiB message limit and `final:true`; archive assembly is
also deferred until publish/update. CLI automatically resumes its journal; rerun the same
command and operation key after a transfer interruption.
