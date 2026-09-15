# artifact-site CLI

Publish, update, search, read, share, export and manage sites from a terminal. This client uses
the HTTP API documented at `/for-agents.md` and stores personal credentials per server in
`~/.config/artifact-site/tokens/<host>`.

Remote MCP offers the same artifact operations directly from the platform, without installing
this binary. Clients that implement MCP authorization (ChatGPT, Claude) sign in through the
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

`login` requires an OIDC-configured server. CLI keyword find, read, info and skill work without a token where access permits. Remote MCP always requires a valid Bearer token — an OAuth access token the client obtained by signing in, a personal token, or the operator token. Publishing, updating, sharing and deleting require a token in the current client. The default open local setup issues no credentials; use browser uploads or the agent publishing guide, or configure OIDC or `PUBLISH_API_TOKEN` for authenticated CLI/MCP use. Supply an operator credential through `ARTIFACT_SITE_TOKEN`; operator tokens have broad privileges and cannot use the personal library (`find` without keywords). `whoami` prints “token present but not recognised by the server” for these tokens; verify them with a successful test publish instead. Environment tokens override saved tokens. `logout` forgets local credentials but does not revoke server-side tokens.

`login` runs the one-time device authorisation: it prints a message with a link and a code,
opens the browser, and waits for you to click **Allow**. The publish token it receives is stored
with mode 0600; the base URL is remembered so later commands need no `--base`.

Environment overrides (useful in CI and for agents): `ARTIFACT_SITE_URL`, `ARTIFACT_SITE_TOKEN`,
`ARTIFACT_SITE_CONFIG_DIR`.

## Commands

A generated slug may begin with `-`. Put options before `--` and positional arguments after
it when passing such identifiers, for example `artifact-site --json read -- -YOUR_SLUG`.

| Command | What it does |
| --- | --- |
| `publish <path>` | New site from an `.html`, a directory (build output), a `.zip`, or a pdf/pptx/ppt/docx/doc. `-` reads HTML from stdin. Creates a **public share link** by default (`--share login\|email\|passcode\|none`). |
| `update <slug> <path>` | Replace the current content. The route follows the site's kind: single page → the new `.html`; file tree → a directory or zip; document → the new file. `--expected-version <id>` refuses to overwrite someone else's newer version (exit 4). |
| `export <slug> [-o file]` | Download the current version as a zip; prints the version id for `--expected-version`. |
| `share <slug>` | Another share link: `--policy`, `--label`, `--expires 7\|30\|90`, `--passcode`. |
| `find` · `info <slug> [--shares]` | Your remote artifacts · one artifact's kind, files and history, optionally owner-only sharing summaries. |
| `find <words…>` | Sites whose current text contains every word (title matches first; Chinese works). `-n` caps the results. Searches what you may list: yours, ones you may edit, public ones. |
| `read <slug>` | The current version as plain text (HTML stripped, pdf/docx/pptx text extracted). `--file <relpath>` prints one file verbatim; `--max-chars` cuts the output. |
| `update <slug> --title <title>` | Rename the display title without changing its address or contents. Cannot combine with a replacement path. |
| `edit <slug> <path> --file <relpath> --expected-version <id>` | Replace one remote text file from a local UTF-8 file (`-` for stdin), preserving other files. |
| `fork <slug>` | Create an independent copy with a new address. |
| `rollback <slug> <versionId>` · `delete <slug>` | Restore an earlier version · move an artifact to the trash. |
| `whoami` · `logout` · `skill` | Identity · forget the token · print the platform's agent guide. |

Use `find` without keywords for “my artifacts”; use keywords to search all discoverable works,
including public artifacts. `read` retrieves content; `info` inspects metadata and version history.
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
The former `artifact-site mcp` stdio command has been removed. CLI commands remain available.

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
