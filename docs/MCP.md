# Remote MCP

CLI and remote MCP offer the same artifact operations. Choose either; MCP never shells out to
the CLI and never reads a path on the server's filesystem supplied by a caller.

## Connect

Open your deployment's `/for-agents#mcp` page. Sign in, create a named personal token, then copy
the configuration. For clients that accept URL/header fields use:

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
chat. For a local config file, restrict access with `chmod 600 ~/.cursor/mcp.json`. Your client
must support Streamable HTTP with an Authorization header; this release does not implement
MCP OAuth discovery. Token creation/list/revocation are browser-session-only. A token cannot
mint another token. Existing device-login tokens also work, and new personal tokens work with
CLI through `ARTIFACT_SITE_TOKEN`.

Every request validates the token. Cookies alone are rejected. Personal tokens inherit the
user's site permissions. Operator tokens use the existing PUBLISH_API_TOKEN override and have
no personal site list. Operator-created sites have no anonymous owner and are not subject
to anonymous-browser quotas or expiry. Their internal upload ownership key is never a cookie
or a site access credential. Default anonymous deployments issue no credentials: configure OIDC or
an operator token before connecting MCP. No token is embedded in a URL.

## Operations

The server exposes **15 tools**. Descriptions state when to use each tool, its inputs and results,
and permission or mutation boundaries. The connection also supplies server instructions for agents.

| CLI | Remote tool |
| --- | --- |
| `whoami` | `artifact_site_connection` (also returns deployment limits) |
| `find [words…]` | `artifact_site_find` (omit query for my works; keywords search discoverable works) |
| `info <slug> [--shares]` | `artifact_site_get_site`, optionally `include: ["versions", "shares"]` |
| `read <slug>` | `artifact_site_read` |
| `publish <path>` | `artifact_site_publish` |
| `update <slug> <path>` / `update <slug> --title <title>` | `artifact_site_update` |
| `edit <slug> <path> --file <relpath> --expected-version <id>` | `artifact_site_edit` |
| `fork <slug>` | `artifact_site_fork` |
| `share <slug>` | `artifact_site_share` |
| `export <slug>` | `artifact_site_export` (manifest or file bytes) |
| `rollback <slug> <version>` / `delete <slug>` | `artifact_site_rollback` / `artifact_site_delete` |
| Automatic CLI upload handling | `artifact_site_upload_start`, `artifact_site_upload_write`, `artifact_site_upload_cancel` |
| `skill` | `artifact-site://skill` resource (not an additional tool) |

Inline publish accepts HTML or `files` containing `path`, `content`, and `encoding` (`utf8` or
`base64`); a single document/ZIP is supported too. Alternatively supply a completed `upload_id`.
Publish defaults to a public share for **both inline and staged uploads**; set `share: false`
(CLI `--share none`) to skip it. Updating never creates a share automatically.

Without search keywords, `find` ignores the search-only `limit` and returns the personal library.

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
`version_id` on every call; a concurrent version change returns 409, so restart the export.

## Migration and verification

Remove old stdio configuration (`command: artifact-site`, `args: [mcp]`, ARTIFACT_SITE_URL env).
Replace it with the remote URL and Authorization header. The `artifact-site mcp` command has
been removed; other CLI commands remain. Local saved CLI tokens are not automatically read
by a remote client: supply a personal token explicitly.

Clients must refresh tool discovery after upgrading from the 24-tool release. Old MCP tool
names are removed rather than kept as advertised aliases. Migrate list/search to `find`, identity
and limits to `connection`, versions/shares to `get_site` includes, rename to title-only `update`,
and file download to `export`. Replace the old six-step upload protocol with the flow above.
CLI `list`, `search` and `rename` remain callable compatibility commands, hidden from top-level help.

Reload the client and confirm exactly 15 tools. In a new conversation, try these requests without
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

Upload errors distinguish concurrent writes (retry the same chunk sequentially) from invalid
indices (`chunk_index`), changed retry bytes (`chunk_mismatch`), and writes after finalization
(`file_finalized`). The latter responses include `nextIndex` and `retryable:false`: correct the
index, or cancel and start over when changing already-uploaded bytes; do not repeat the same
invalid request. Successful writes always return `bytes`, including final writes and retries.
Office/ZIP processing-limit failures discard the draft and say so explicitly; start a new upload
after converting the document or unpacking the web tree. Cancellation accepts only the project
upload ID returned by `upload_start`, not internal chunk-session IDs.
