# artifact-site CLI

Publish, update, search, read, share, export and manage sites from a terminal. This client uses
the HTTP API documented at `/for-agents.md` and stores personal credentials per server in
`~/.config/artifact-site/tokens/<host>`.

Remote MCP offers the same artifact operations directly from the platform, without installing
this binary (`artifact-site mcp` also serves them locally over stdio, see [Local MCP](#local-mcp-stdio)). Clients that implement MCP authorization (ChatGPT, Claude) sign in through the
server's own OAuth consent page; others configure its URL and a Bearer credential; see
[MCP setup](../docs/MCP.md).

The deployment's `/for-agents#cli` and `/for-agents#mcp` pages provide copyable connection instructions for its address and authentication settings.

## Install

```bash
npm install -g @artifact-site/cli        # Node 24+
artifact-site login --base https://your-artifact-site.example
```

If the global install fails with `EACCES`, use a user-writable prefix instead:

```bash
npm_config_prefix="$HOME/.local" npm install -g @artifact-site/cli
export PATH="$HOME/.local/bin:$PATH"
```

To run the CLI from a checkout of this repository instead: `npm --prefix cli ci && npm --prefix cli run build && (cd cli && npm link)`.

Keep that PATH entry in your shell startup file and restart your terminal or coding agent.
Remote MCP uses the server URL, plus either the client's OAuth sign-in or an Authorization
header; it does not use a local executable.

To keep anonymous browser creation available alongside an operator token, explicitly set
`ARTIFACT_CREATE_POLICY=open`. If the policy is unset, configuring `PUBLISH_API_TOKEN` changes
the fallback policy to `token`, which rejects anonymous browser creation. Use `open` only where
anonymous creation is intended; existing-site access and editing still follow their own rules.

`login` requires an OIDC-configured server. CLI keyword find, read, info and skill work without a token where access permits. Remote MCP always requires a valid Bearer token — an OAuth access token the client obtained by signing in, a personal token, or the operator token. Publishing, updating, sharing and deleting require a token in the current client. The default open local setup issues no credentials; use browser uploads or the agent publishing guide, or configure OIDC or `PUBLISH_API_TOKEN` for authenticated CLI/MCP use. Supply an operator credential through `ARTIFACT_SITE_TOKEN`; operator tokens have broad privileges and cannot use the personal library (`find` without keywords). `whoami` reports these as operator credentials, with no personal account or folders. Older servers may not identify operator credentials; do not test identity by publishing. Environment tokens override saved tokens. `logout` forgets local credentials but does not revoke server-side tokens.

`login` runs the one-time device authorisation: it prints a message with a link and a code,
opens the browser, and waits for you to click **Allow**. The publish token it receives is stored
with mode 0600; the base URL is remembered so later commands need no `--base`.

Environment overrides (useful in CI and for agents): `ARTIFACT_SITE_URL`, `ARTIFACT_SITE_TOKEN`,
`ARTIFACT_SITE_CONFIG_DIR`.

JSON compatibility: `whoami --json` now returns `tokenStatus: "unidentified"` (previously `"rejected"`) when a credential yields no identified account, and `"operator"` for verified operator credentials. Explicit token rejection codes remain distinct. The top-level `email` comes from the server identity, or is `null`; it no longer uses a potentially stale saved login email. Scripts should handle these values explicitly.

## Commands

A generated slug may begin with `-`. Put options before `--` and positional arguments after
it when passing such identifiers, for example `artifact-site --json read -- -YOUR_SLUG`.

| Command | What it does |
| --- | --- |
| `publish <path>` | New site from an `.html`, a directory (build output), a `.zip`, or a pdf/pptx/ppt/docx/doc. `-` reads HTML from stdin. Creates a **public share link** by default (`--share login\|email\|passcode\|none`). |
| `update <slug> <path>` | Replace the current content. The route follows the site's kind: single page → the new `.html`; file tree → a directory or zip; document → the new file. Required `--expected-version <id>` refuses to overwrite someone else's newer version (exit 4). |
| `export <slug> [--version-id <id>] [-o file]` | Download the selected version (default current) as a zip; prints the version id for `--expected-version`. |
| `share <slug>` | Another share link: `--policy`, `--label`, `--expires 7\|30\|90`, `--passcode`. |
| `find` · `info <slug> [--shares]` | Your remote artifacts · one artifact's kind, files and history, optionally owner-only sharing summaries. |
| `find --public` | Explicit public catalog, not a personal listing. Omit keywords. |
| `folders list` | My flat folder labels with stable IDs; requires a personal account. |
| `move <slug> --folder <id>` / `move <slug> --unfiled` | Change only my folder assignment; content, ownership and sharing stay unchanged. |
| `find <words…>` | Sites whose current text contains every word (title matches first; Chinese works). `-n` caps the results. Searches what you may list: yours, ones you may edit, public ones. |
| `read <slug>` | The current version as plain text (HTML stripped, pdf/docx/pptx text extracted). `--file <relpath>` prints one file verbatim; `--max-chars` cuts the output. |
| `update <slug> --title <title>` | Rename the display title without changing its address or contents. Cannot combine with a replacement path. |
| `edit <slug> <path> --file <relpath> --expected-version <id>` | Replace one remote text file from a local UTF-8 file (`-` for stdin), preserving other files. |
| `fork <slug>` | Create an independent copy with a new address. |
| `rollback <slug> <versionId>` · `delete <slug>` | Restore an earlier version · move an artifact to the trash. |
| `whoami` · `logout` · `skill` | Identity · forget the token · print the platform's agent guide. |

Use `find` without keywords for “my artifacts”; use keywords to search all discoverable works,
including public artifacts. Each keyword result carries `relationship` (owned, collaborating,
anonymous, public) separately from `visibility`; owned artifacts can also be public. JSON output
includes `scope`: mine, discoverable, or public. Never present mixed/public results as "my sites".
A personal-list failure does not automatically load the public catalog. Use `whoami` to diagnose
identity, then explicitly use `find --public` if public content is useful. Browser sign-in is separate
from CLI authentication; an empty list is not a sign-in failure, and network/permission errors do
not establish login state.

File a newly published or existing artifact with:

```bash
artifact-site folders list --json
artifact-site move --folder fld_EXAMPLE -- YOUR_SLUG
artifact-site move --unfiled -- YOUR_SLUG
```

Reuse a saved folder ID on the same server/account. Unknown or inaccessible targets fail explicitly.
If publication succeeded but filing failed, retry only `move`; do not publish a duplicate.

`read` retrieves content; `info` inspects metadata and version history.
CLI handles upload chunking automatically, so there are no separate transfer commands to learn.
`list`, `search` and `rename` remain compatible with existing scripts but are hidden from the main
help. New scripts should use `find`, `find <words…>` and `update --title` respectively.

`--json` on any command prints machine-readable output. Exit codes: `0` ok, `1` server or local
error, `2` usage, `3` not signed in / token rejected, `4` version conflict, `5` site created but the
share link failed.

Directories are zipped in memory when under the one-shot limit (24 MB) and streamed file by file
through the chunked upload route above it — large media sites and large PDFs just work.
`node_modules`, every dot-leading path (`.git`, `.env`, `.DS_Store`, …), `__MACOSX` and `Thumbs.db` are never
uploaded — the platform refuses dot-leading paths anyway, and that is where secrets live. What was left
out is printed before the upload.

```bash
artifact-site publish dist/ --title "Q3 dashboard"        # → prints the site URL and the share link
artifact-site export k4wey6sCyFcm -o site.zip              # → version ver_… to build on
artifact-site update k4wey6sCyFcm dist/ --expected-version ver_…
```

## Remote MCP

MCP is hosted by the platform at `/mcp`; it does not require this CLI or Node on the client.
ChatGPT, Claude and other clients that implement MCP authorization connect with the address
alone and sign in through the server's consent page. For other clients, open `/for-agents#mcp`
on your deployment to create a personal token and copy the remote configuration. See
[the remote MCP guide](../docs/MCP.md) for tools, file transfers and migration.

## Local MCP (stdio)

For clients and directories that only start local MCP servers, `artifact-site mcp` runs one over
stdio. It implements no tools itself: every request is forwarded to your server's `/mcp` with this
CLI's credential, and tool names, schemas, results and server instructions come back unchanged.

```bash
artifact-site mcp [--base <url>]
npx -y @artifact-site/cli mcp
```

The server address and token are resolved like every other command: `--base` >
`ARTIFACT_SITE_URL` > the address saved by `login`; `ARTIFACT_SITE_TOKEN` >
`~/.config/artifact-site/tokens/<host>`. Create a personal token at `/for-agents#mcp` on your
deployment, or run `artifact-site login` once on this machine.

Without an address or token the server still starts and lists its 26 tools (a copy bundled with
the package); each call then returns a tool error explaining how to sign in. A rejected token
(HTTP 401/403) or an unreachable server is reported as a tool error too, and the process keeps
running. stdout carries only JSON-RPC; diagnostics go to stderr.

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "artifact-site": {
      "command": "npx",
      "args": ["-y", "@artifact-site/cli", "mcp"],
      "env": {
        "ARTIFACT_SITE_URL": "https://artifact-site.app.lexmount.com",
        "ARTIFACT_SITE_TOKEN": "ahp_..."
      }
    }
  }
}
```

The configuration holds a credential: keep it in private user settings. If the CLI is already
signed in on this machine, omit `env` (or keep only `ARTIFACT_SITE_URL`).

`cli/src/mcp-tools.json`, the bundled list, is generated from the server's registrations with
`npm run generate:mcp-tools` at the repository root; a test fails when it is out of date.

## Development

```bash
npm ci
npm run typecheck
npm test            # unit + contract tests against an in-memory fake of the API
npm run build       # dist/ (the bin loads it)
```

The fake server in `test/fake-server.ts` mirrors the API contract from `/for-agents.md`; when the
platform changes a response shape, change it there and the tests will tell you what else moved.

### RBAC context

Existing saved personal tokens and login remain unchanged. Use `--tenant <id>` (or
`ARTIFACT_SITE_TENANT`) when publishing into a tenant other than the account default.
Use `--share-token <token>` (or `ARTIFACT_SITE_SHARE_TOKEN`) for access through a share;
this does not grant tenant membership. `share --policy people` replaces the old `email`
spelling, which is still accepted. `share --mode view|comment|edit --version-id <id>`
controls the share role and optional fixed version (edit cannot be pinned).
Source reads, export and fork require editor-or-higher access; plain report text follows
read permissions. Public sharing creates a reader URL without changing site visibility.
## Official versions

```sh
artifact-site publish report.pdf --official
artifact-site update SLUG report.pdf --expected-version BASELINE --official
artifact-site official set SLUG VERSION_ID
artifact-site official clear SLUG
artifact-site info SLUG
```

There is at most one official version. Designating a current or historical version replaces
the old designation without changing the latest version or any snapshot contents. Upload
flags take effect in the same transaction as publication; they require management permission
when updating an existing site. The `official` commands read the current designation revision
and refuse concurrent changes. `info` and `--json` include official version metadata.

## Recoverable publishing

`artifact-site publish ./report --share none` accepts an HTML file, a directory or a ZIP.
Large ZIPs are extracted into a private temporary directory and uploaded file by file. Extraction
rejects unsafe paths, duplicates and expanded content over the deployment limits advertised by
`GET /api/auth/me` (`uploadLimits`). Older servers fall back to 300 MiB / 250 MiB per file /
2000 files. Hidden paths and excluded directories are skipped and reported for both ZIPs and
directories; inline ZIP uploads contain only the filtered files. A tree needs an HTML entry; a folder of images alone is rejected before upload.
Large HTML and PDF files use the same streaming route. Office files still require inline conversion.

With an authenticated client, rerun the same command and unchanged files after an interruption.
The client keeps an atomic, mode-0600 journal in `<config-dir>/uploads/`, resumes completed files,
and checks the commit outcome before retrying. Completed files are matched by SHA-256, and ZIP
packing uses stable timestamps so a retry has the same request fingerprint. Local locks record process
birth identity so a recycled PID cannot block recovery. Journals do not store bearer, edit or claim tokens.
A successful repeat returns the same artifact; use `--operation-key <new-key>` to intentionally
publish a second copy. Reusing an explicit operation key with different files/options is rejected.
The `update` command supports the same option and recovery behavior. Anonymous publication has
no durable cross-process recovery because its cookie is intentionally not saved in the journal.

Results can be recovered for seven days; unfinished upload sessions expire after six hours.
After seven days, inspect the previous artifact before choosing a new operation key. Automatic
fallback happens only on the application's structured pre-publication 413, never an unknown gateway
response. Server errors do not automatically replay non-idempotent POST requests. On legacy servers
without operation-status support, uncertain writes require manual outcome verification.

Library callers can use `client.withOperation(key, () => client.createPaste(html))`,
`client.operationStatus(key)` and `client.uploadStatus(versionId)`. Persist the key before calling.

Cached publication results are checked against the server before reuse. If the artifact was deleted, inspect the previous publication and choose a new `--operation-key` to publish again.

## Revise an artifact from feedback

```bash
artifact-site comments list SLUG --status open --json
artifact-site comments list SLUG --aggregate --all-versions --json
artifact-site comments context SLUG THREAD --json
artifact-site comments read SLUG THREAD --json
artifact-site comments read SLUG THREAD --cursor CURSOR --limit 30 --json
artifact-site read SLUG --version-id ORIGINAL --file index.html --json
artifact-site export SLUG --version-id BASELINE --out source.zip --json
artifact-site update SLUG ./output --expected-version BASELINE --operation-key feedback-fix-001 --json
```

Comments commands return JSON (pretty-printed without `--json`). Lists default to the current
version and main discussion, or the presented share's own scope. Use `--version-id`, `--status`,
`--cursor`, `--limit`, and manager-only `--aggregate` / `--share-id` / `--all-versions` explicitly.
Keep the returned version and filters when paging. Follow discussion `messages.nextCursor`, or
context `continuation.messagesCursor`, using `read --cursor`; those continuation pages return a
top-level `nextCursor`. Reads do not mark anything read. Share credentials can be supplied through
`ARTIFACT_SITE_SHARE_TOKEN`; comment access does not grant source access or editing.

Content `update` now requires `--expected-version` (title-only rename is unchanged). Read the
latest editable version separately from an old comment's evidence, then revise the same slug.
A 409 exits 4: inspect and reconcile the winner, not a blind overwrite or new publication.
Reuse the operation key after uncertain responses; fixed-version shares remain on the old version.
