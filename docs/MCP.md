# MCP

CLI and MCP offer the same artifact operations. Choose either; MCP never shells out to
the CLI and never reads a path on the server's filesystem supplied by a caller.

MCP is served by the deployment at `https://your-server/mcp`. A client that only starts local
commands can run the CLI's `artifact-site mcp` instead: a relay to that same endpoint, not a second
implementation; see [Local MCP (stdio)](#local-mcp-stdio).

## Connect

### Sign in from the client (OAuth)

For ChatGPT, Claude and every client that implements MCP authorization: give it the address
`https://your-server/mcp` and choose OAuth. The client discovers this server's authorization
server, opens the sign-in and a consent page in the browser, and receives an access token it
presents on every request. Nothing to paste. Disconnect at any time from **My sites → Account
tools → Connected applications**; the next request the client makes is refused.

In ChatGPT: Settings → Connectors → Create. Server URL `https://your-server/mcp`; Authentication
**OAuth** (not "mixed": every tool here needs an identity); under Client registration choose
**Dynamic Client Registration** — ChatGPT connects to this server, so it works from any network.
**Client ID Metadata Document** also works, but only when this server can reach `chatgpt.com`
(servers in regions OpenAI does not serve get a 403; the consent page then says the client
metadata document could not be fetched — switch to Dynamic Client Registration). A user-defined
client is not needed. Leave the default scopes empty. Create, then approve the connection in the
window ChatGPT opens. Claude, Cursor and other clients: add the server by address alone and
approve the sign-in when prompted. A JSON-configured client needs only:

```json
{ "mcpServers": { "artifact-site": { "url": "https://your-server/mcp" } } }
```

Requires OIDC sign-in on the deployment (there is nobody to sign in otherwise) and
`ARTIFACT_PUBLIC_URL` set to the exact address clients use: tokens are bound to it, and a
mismatch fails every request with 401. The details are in [OAuth](#oauth) below.

### Paste a token

For clients that take a URL and headers, and for scripts: open `/for-agents#mcp`, sign in,
create a named personal token, then copy the configuration.

- URL: `https://your-server/mcp`
- Transport: Streamable HTTP
- Authorization header: `Bearer YOUR_TOKEN`

Example user-level Cursor configuration (merge with existing `mcpServers`):

```json
{
  "mcpServers": {
    "artifact-site": {
      "url": "https://your-server/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

The configuration contains a credential. Keep it in private user settings, not a repository or
chat. For a local config file, restrict access with `chmod 600 ~/.cursor/mcp.json`. Token
creation/list/revocation are browser-session-only. A token cannot mint another token. Existing
device-login tokens also work, and new personal tokens work with CLI through `ARTIFACT_SITE_TOKEN`.

Every request validates the token. Cookies alone are rejected. Personal tokens inherit the
user's site permissions. Operator tokens use the existing PUBLISH_API_TOKEN override and have
no personal site list. Operator-created sites have no anonymous owner and are not subject
to anonymous-browser quotas or expiry. Their internal upload ownership key is never a cookie
or a site access credential. Default anonymous deployments issue no credentials: configure OIDC or
an operator token before connecting MCP. No token is embedded in a URL.

### Local MCP (stdio)

`artifact-site mcp` (from `@artifact-site/cli`) serves MCP over stdio and forwards `tools/list`,
`tools/call`, `resources/list` and `resources/read` to `<base>/mcp` with `Authorization: Bearer
<token>`; tool names, schemas, results and the server instructions are passed through unchanged.
Address: `--base` > `ARTIFACT_SITE_URL` > the CLI's saved config. Token: `ARTIFACT_SITE_TOKEN` >
`~/.config/artifact-site/tokens/<host>`. Create a personal token at `/for-agents#mcp`.

```json
{
  "mcpServers": {
    "artifact-site": {
      "command": "npx",
      "args": ["-y", "@artifact-site/cli", "mcp"],
      "env": {
        "ARTIFACT_SITE_URL": "https://your-server",
        "ARTIFACT_SITE_TOKEN": "ahp_..."
      }
    }
  }
}
```

With no address or token it still starts and lists the tools from a copy bundled in the package
(generated from the server's registrations; CI fails when it drifts), and each call returns a tool
error explaining how to sign in — which is what MCP directories need to inspect it. A rejected
token (401/403) becomes a tool error asking to sign in again; `insufficient_scope` is passed
through as the server words it; network failures and timeouts are tool errors too. When the
server cannot be reached, `tools/list` falls back to the bundled copy with a warning on stderr.
The process never writes anything but JSON-RPC to stdout.

Files still travel as base64 chunks through `upload_write`, exactly as over remote MCP; the local
server does not read paths on disk. For a whole local folder, the CLI's `publish` is simpler.

## OAuth

This server is its own OAuth 2.1 authorization server, colocated with the resource it protects.
What it implements, and only that:

- **Discovery.** `/mcp` answers an unauthenticated request with `401` and a `WWW-Authenticate`
  challenge naming `/.well-known/oauth-protected-resource/mcp` (RFC 9728; also served at the root
  path). That document points at the authorization server: `/.well-known/oauth-authorization-server`
  (RFC 8414; the same document is served as `/.well-known/openid-configuration`).
- **Clients.** A client identifies itself with a Client ID Metadata Document — its `client_id`
  is an https URL, fetched and validated here; ChatGPT's preferred method — or registers
  dynamically at `/oauth/register` (RFC 7591; `ARTIFACT_OAUTH_DCR=off` disables it). There is no
  static preregistration: every ChatGPT connector has its own callback address, so an
  administrator would be registering clients one person at a time. A client may be sent back to
  an https address, to a listener on the loopback host — on whichever port it managed to open
  (RFC 8252 §7.3) — or to a native application's own scheme: the reverse-domain shape RFC 8252
  §7.1 asks for (`com.example.app:`), `cursor:`, `vscode:` and `vscode-insiders:`, or a scheme the
  operator admits (`ARTIFACT_OAUTH_APP_SCHEMES`, say `windsurf,zed`); any other scheme is refused,
  because a redirect to a scheme runs whatever handles it on the person's machine.
  `ARTIFACT_OAUTH_CLIENT_HOSTS` restricts which hosts may identify themselves or be redirected to
  (comma-separated hostnames, subdomains included); with it set, only https redirects to listed
  hosts pass. All three knobs — hosts, dynamic registration, extra schemes — can also be set from
  the administration console (`/admin/settings`) without a restart, console over environment.
  Registrations that never reach the consent page are swept after a day.
- **The flow.** Authorization code with PKCE (S256 only) at `/oauth/authorize`, which is the
  consent page: it shows who is asking (name and host), what they get, as whom, and where the
  browser will be sent back; it refuses to be framed. The redirect address is checked against the
  client's registration before anything is redirected; refusals of a verified client go back to
  it with `error` and `state`; an unverifiable client or address gets a page here, never a redirect. `resource`
  (RFC 8707) must name this server. `/oauth/token` exchanges the code — single use; a replay
  revokes everything it produced — for an access token and a refresh token, and `/oauth/revoke`
  (RFC 7009) takes them back.
- **Scopes.** `artifacts:read` (find, open, export) and `artifacts:write` (publish, update,
  share, roll back, delete). The challenge asks for both; a client may ask for less, and a
  read-only grant is refused every change with `403` and `insufficient_scope`. Unknown scopes
  are ignored, and the token response says what was granted.
- **Tokens.** Opaque and stored hashed, like sessions and personal tokens, so revocation is
  immediate. Access tokens live an hour; refresh tokens thirty days, rotated on every use, under
  a ninety-day ceiling fixed at consent. A refresh retires the previous access token as well, so
  a narrowed scope takes effect at once; a retired refresh token presented again ends the grant —
  unless it arrives within thirty seconds of the rotation under the same `client_id`, which is
  what an honest client's parallel calls look like, and is merely refused (a public client's id
  proves nothing, so that window is a matter of time, not of identity). Approving a dynamically
  registered client again replaces its previous connection (its `client_id` is one install); a
  metadata-document application is one document for every machine it runs on, so its connections
  stay side by side. Tokens are bound to the deployment address they were issued for, and a
  disabled account cannot redeem or refresh.
- **The account page** lists connections (one per grant) with disconnect; disabling an account
  revokes its OAuth tokens along with its sessions and personal tokens. Like a personal token,
  an OAuth session cannot mint tokens, approve devices or answer a consent page.

Troubleshooting: `401` on every request right after a successful sign-in means the address
clients use differs from `ARTIFACT_PUBLIC_URL` (scheme, host or port). "Could not discover
OAuth" or a `404` on `/.well-known/…` means the reverse proxy does not pass paths beginning with
a dot, or `/oauth/*`. A `403 insufficient_scope` means the connection was made read-only:
disconnect it and connect again. The consent page needs a browser sign-in; a token session
cannot approve.

## Operations

The server exposes **26 tools**. Descriptions state when to use each tool, its inputs and results,
and permission or mutation boundaries. The connection also supplies server instructions for agents.

| CLI | Remote tool |
| --- | --- |
| `whoami` | `artifact_site_connection` (also returns deployment limits) |
| `find --public` | `artifact_site_find` with `scope:"public"`, without query |
| `find [words…]` | `artifact_site_find` (omit query for my works; keywords search discoverable works) |
| `folders list` (API: `GET /api/me/folders`) | `artifact_site_folders` |
| `move <slug> --folder <id>` / `move <slug> --unfiled` | `artifact_site_move` (`slug`, `folder_id`; null = Unfiled) |
| `info <slug> [--shares]` | `artifact_site_get_site`, optionally `include: ["versions", "shares"]` |
| `read <slug>` | `artifact_site_read` |
| `publish <path>` | `artifact_site_publish` |
| `update <slug> <path>` / `update <slug> --title <title>` | `artifact_site_update` |
| `edit <slug> <path> --file <relpath> --expected-version <id>` | `artifact_site_edit` |
| `fork <slug>` | `artifact_site_fork` |
| `share <slug>` | `artifact_site_share` |
| `export <slug> [--version-id <id>]` | `artifact_site_export` (manifest or file bytes) |
| `rollback <slug> <version>` / `delete <slug>` | `artifact_site_rollback` / `artifact_site_delete` |
| Publication recovery | `artifact_site_operation_status`, `artifact_site_upload_status` |
| Automatic CLI upload handling | `artifact_site_upload_start`, `artifact_site_upload_write`, `artifact_site_upload_cancel` |
| `comments list <slug>` | `artifact_site_comments_list` |
| `comments read <slug> <thread-id>` | `artifact_site_comment_read` |
| `comments context <slug> <thread-id>` | `artifact_site_comment_context` |
| `skill` | `artifact-site://skill` resource (not an additional tool) |

Inline publish accepts HTML or `files` containing `path`, `content`, and `encoding` (`utf8` or
`base64`); a single document/ZIP is supported too. Alternatively supply a completed `upload_id`.
Publish defaults to a public share for **both inline and staged uploads**; set `share: false`
(CLI `--share none`) to skip it. Updating never creates a share automatically.

Without search keywords, `find` ignores the search-only `limit` and returns the personal library,
separating owned and collaborative artifacts. Keyword search includes discoverable public works;
`relationship` labels owned, collaborating, anonymous-browser-owned, or other public results,
independently of `visibility`. A public artifact can still be owned by the connected account.
An empty list is not an authentication failure. Diagnose identity failures with `connection`;
if showing the public catalog as a fallback, first establish and explain the missing personal
identity. Use `find` with `scope:"public"` and no query (CLI `find --public`, HTTP `/api/sites`),
and label the result public. Scope is a listing option; omit it for keyword search. Do not silently replace failed personal queries.

`folders` lists the connected account's flat folder labels, including stable IDs. After publication,
call `move` with the returned artifact slug and selected folder ID; save the ID for future runs.
Moving only changes the caller's personal assignment, never content or sharing. Missing or inaccessible
folders/artifacts fail explicitly. If publishing succeeds and moving fails, retry only the move.
Operator credentials cannot list or mutate a personal shelf. Read-only OAuth grants may list folders
but cannot move artifacts. Publishing and updating do not take a destination-folder parameter.

A title-only MCP update accepts only `slug` and `title`. Content replacement requires exactly
one of `html`, `files` or `upload_id`, plus `expected_version`; it replaces the complete contents.
Title changes do not create content versions, so content version IDs cannot protect against
concurrent renames. Do not pass `expected_version` for a title-only update.
Use `edit` to keep other files intact. Listing share records is still owner-only, even when
requested through `get_site`; plain metadata access does not grant sharing permissions.

## Files, folders and large uploads

1. If limits are unknown, inspect `artifact_site_connection` → `limits`.
2. `artifact_site_upload_start`: omit slug for a new site, include it to replace that site.
   Use the returned `versionId` as `upload_id` below.
3. For each relative filename, send sequential `artifact_site_upload_write` calls with
   `upload_id`, `path`, zero-based `index`, `base64` (at most 256 KiB decoded) and `final`.
   Set `final: true` on the last chunk of each file. An empty file uses index 0, empty base64
   and final true. File creation/assembly is automatic. Finish one file before starting another.
   Identical retries, including the final chunk, are safe until the upload is committed or cancelled.
   A finalized file is immutable in this upload; cancel and start over to change it.
4. Call `artifact_site_publish` with `upload_id` and the desired share policy, or
   `artifact_site_update` with `slug`, `upload_id` and `expected_version` from the earlier read.
   Unfinished files and mismatched publish/update targets are rejected.
5. Use `artifact_site_upload_cancel` with `upload_id` if abandoning the draft.

No local CLI is required. The agent/client must be able to read the user's source files and
encode/decode bytes. A client with no file access cannot upload an arbitrary local folder
merely from its path; this is a client capability, not a need for a local MCP process.
The 2 MiB request cap is independent of the deployment's full file/project limits.

Export returns a manifest and an authenticated ZIP URL. To stay entirely within MCP, download
each manifest file with `artifact_site_export` plus `path`, advancing nextOffset until done, and
write decoded bytes to the same relative paths in the agent's environment. Supply the manifest's `versionId` as
`version_id` on every call to keep the snapshot immutable even if a new version is published.
An inaccessible snapshot returns 404; do not silently substitute the latest version.

## Migration and verification

A stdio configuration (`command: artifact-site`, `args: [mcp]`) works again from the CLI release after 0.3.0:
`artifact-site mcp` is now a relay to the remote `/mcp` (see [Local MCP](#local-mcp-stdio)), so it
needs a token — `ARTIFACT_SITE_TOKEN` or a saved `artifact-site login` — besides the address.
Local saved CLI tokens are not read by a remote (URL) client: supply a personal token explicitly.

Clients must refresh tool discovery after upgrading from the 24-tool release. Old MCP tool
names are removed rather than kept as advertised aliases. Migrate list/search to `find`, identity
and limits to `connection`, versions/shares to `get_site` includes, rename to title-only `update`,
and file download to `export`. Replace the old six-step upload protocol with the flow above.
CLI `list`, `search` and `rename` remain callable compatibility commands, hidden from top-level help.

Reload the client and confirm exactly 26 tools. In a new conversation, try these requests without
mentioning MCP or a tool name: “What artifacts have I published?”, “Find last week's report”,
“Read that report”, “Publish this page without sharing it”, and “Rename this artifact”.
For Chinese hosts, also try “我有哪些作品”, “找一下之前的报告”, and “把这份报告发布成链接”.
Check the actual calls and results, not just the assistant's text. Tool descriptions improve
selection context but cannot guarantee a particular host/model's routing. If discovery succeeds
but no tool is chosen, inspect host tool enablement and selection settings before changing tokens.
Then publish a test file, read/export it and delete it.
Verify user permissions with a second account and revoke the test token when finished. Keep
normal webpage uploads and CLI publishing in your deployment smoke tests as separate paths.

Office and ZIP processing retain the platform's single-request processing ceiling (reported as
`officeZipBytes`), even when transferred in small MCP messages. Above that limit, convert Office
to PDF or send unpacked web files. PDF and file-tree uploads use the full file/project limits.
Rate limits are per process. Each credential has the normal operation budget
(`ARTIFACT_RATE_LIMIT_BURST`, default 20; `ARTIFACT_RATE_LIMIT_PER_MIN`, default 30).
Internal HTTP dispatch is counted once. File upload/download chunks have a separate budget
at 12 times those values (240 burst / 360 chunks per minute by default, up to 90 MiB/min
at full chunk size). Pre-authentication admission uses the same larger budget per client IP,
so clients sharing an IP share that ceiling. Increasing the existing settings scales both
budgets; keep proxy-provided client IP headers correct. On HTTP 429, wait before retrying:
MCP clients may surface the error without retrying automatically. Identical chunk retries
are safe; do not restart the entire upload just because one chunk was throttled.

## Ownership and conflict recovery

Open claiming by URL is disabled (the old claim API returns 410). Personal-token publications
belong to the publishing account. Operator publications and historical unowned sites remain
administratively managed; administrators can assign them through authorized ownership transfer.
The original browser still manages its anonymous publications and can adopt them on sign-in.

A version conflict preserves staged upload bytes until the session expires (six hours from
creation). Inspect the current version and reconcile changes first. If you deliberately choose
to submit the same staged content, retry update with the same upload id and the current expected
version. Do not automatically replace expected_version: that would overwrite concurrent edits.
Cancel the draft if abandoning it. Invalid or incomplete commit inputs leave the draft available
for correction. Once commit processing begins, failures other than version conflicts reclaim
the project draft and temporary parts. Retrying an acknowledged final file chunk verifies its
bytes without assembling the entire file again.

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

The file PUT (`upload_file` dispatch) can return 409 `upload_conflict` with `retryable:true`.
After a short delay, retry the same PUT in the same session with the same path and bytes.
For MCP `upload_write`, retry the same final chunk (same index, base64 and `final:true`);
reduce parallelism if contention repeats, and publish only after all writes succeed.
This differs from `version_conflict`, which requires reconciling the current version.

Upload errors distinguish concurrent writes (retry the same chunk sequentially) from invalid
indices (`chunk_index`), changed retry bytes (`chunk_mismatch`), and writes after finalization
(`file_finalized`). The latter responses include `nextIndex` and `retryable:false`: correct the
index, or cancel and start over when changing already-uploaded bytes; do not repeat the same
invalid request. Successful writes always return `bytes`, including final writes and retries.
Office/ZIP processing-limit failures discard the draft and say so explicitly; start a new upload
after converting the document or unpacking the web tree. Cancellation accepts only the project
upload ID returned by `upload_start`, not internal chunk-session IDs.

## Official versions

`artifact_site_publish` and content-bearing `artifact_site_update` accept `official: true`.
The upload and designation commit together, including chunked uploads.
`artifact_site_set_official` takes `slug`, `version_id` and optional `expected_revision`;
`artifact_site_clear_official` takes `slug` and optional `expected_revision`.
Read `officialRevision` with `artifact_site_get_site` before a conditional change.
Designation requires site management permission and never changes the latest version.
See [Official versions](OFFICIAL-VERSIONS.md) for the HTTP and UI contract.

### Durable publication recovery

Pass a unique, persisted `operation_key` to publish, content update, edit or upload_start. Keep the
same key and arguments when retrying; changed arguments conflict. Query `artifact_site_operation_status`
with `key` after an uncertain result. A committed artifact/version is returned without re-creating it,
including when its upload session was already cleaned up. Results remain recoverable for seven days.
A recovered publish may omit the share result: inspect existing shares and explicitly create a link
if needed, rather than re-publishing. Upload sessions still expire after six hours.

`artifact_site_upload_status` takes `upload_id` and returns completed files and session expiry.
For remote MCP, send file bytes via upload_write; it cannot open or unzip paths on your computer.
For local ZIP/directory automation, the CLI performs extraction and transfer selection automatically.

### Comment-driven revisions

Read-only tools `artifact_site_comments_list`, `artifact_site_comment_read` and
`artifact_site_comment_context` expose existing comment permissions without acknowledging read
receipts. List defaults to the current entrance/version, supports `version_id`, `share_id`,
`status`, `cursor`, `limit`, and explicit `aggregate` / `all_versions`. Aggregate access is
management-only through the main entrance; a share token never expands into other discussions.
`comment_read` takes `thread_id`; pass the returned messages cursor to continue. Context includes
untrusted original evidence, author labels, normalized coordinate definitions, source/edit
capabilities and message continuation. It does not claim live anchor verification.

`artifact_site_read` and `artifact_site_export` accept `version_id`, including historical
manifests and immutable file chunks. Read the original comment snapshot and latest editing
baseline separately. Update/edit the same slug with `expected_version` and `operation_key`;
never create a new site to bypass a permission failure or conflict. See the served publishing
Skill for the complete workflow. No Agent comment mutations or notifications are added.

### Comment image feedback

Use `artifact_site_comment_image` with `slug` and `attachment_id` from comment context to read a screenshot as native MCP image content. Each call returns one PNG/JPEG derivative (up to 4 MiB) and untrusted metadata, rechecking discussion access and deletion. Pass the same `share_token` for link access. This read-only tool never marks feedback read. Optional `max_edge` defaults to 1568 pixels (256–4096 accepted); the byte limit can reduce it further. `attachment` retains original dimensions while `image` describes the returned derivative. Stored attachments are unchanged.
