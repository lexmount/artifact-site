# Recovery and documentation freshness

At the start of each task, check the selected deployment's `/agent-docs/manifest.json`.
With the CLI, run `artifact-site skill docs --topic TOPIC --base BASE` for each needed topic.
This checks the deployment on every invocation, reuses matching installed references or cached
bytes, and downloads only changed topics. Read the returned text before continuing.
MCP clients can read `artifact-site://docs/manifest` and the selected topic resources.

Compare the manifest `version` to `X-Artifact-Site-Skill-Version` on the first API response
already needed by the task, and on later responses when available. MCP tool result metadata
also carries this version. A mismatch requires rechecking the manifest and affected topics
before the next operation. Do not repeatedly download unchanged references within one task.
If a response lacks a version, check the manifest once rather than assuming freshness.
On a legacy server where the manifest is absent (404/410), read `/for-agents.md` instead.
Network errors, 403, malformed manifests and checksum failures are not legacy detection.

The server's `skill_version` is a documentation content hash, not the CLI version or a work
version. It covers the entry, all references and deployment supplements. A matching topic
`sourceSha256` permits using the installed reference; otherwise use its complete replacement
for this deployment. Read `updates` when the documentation version changes. Never combine
an old topic with a new topic's conflicting parameters.

Keep fetched reference data in a deployment-specific cache, separate from the installed skill.
Do not replace `SKILL.md`, scripts, credentials or client configuration with server content.
Update the installed package through the official installer instead. If required reference
updates fail, report the failure and pause dependent writes; do not mark old data current.

**Preserve the outcome of the call already made.** Refreshing documentation must not repeat a
successful publish, upload-session creation, update or share creation. For an uncertain outcome,
use the original operation key and the recovery procedures below. Keep the pending task and
its authorized audience through authentication or a documentation refresh.

### Recommended publishing and recovery

For a local directory, document or archive, prefer `artifact-site publish ./report`.
Authenticated CLI publication chooses the transfer route and records progress under
`~/.config/artifact-site/uploads/`. Retry the same command with unchanged files to recover the same
work. Use a different `--operation-key <key>` only when intentionally creating another copy.
The journal contains operation IDs and content hashes, not authentication or management tokens.
Anonymous uploads work, but automatic cross-process recovery requires an authenticated CLI identity.
On package-capable servers, directories and archives open as file packages without requiring HTML;
archives retain their original bytes and Office conversion runs on the server. Only legacy servers
require an HTML entry for directory/ZIP publication and inline Office conversion. Read the publishing
topic and the selected deployment's advertised capabilities before choosing a transfer path.

Remote MCP cannot read your local disk: send a relative file tree or use `artifact_site_upload_start`
and sequential `artifact_site_upload_write` chunks. Include a persisted `operation_key` on publish,
content update, edit, and upload_start. Reuse exactly the same key and arguments after a lost response.
Use `artifact_site_operation_status` with `key` to recover a committed result, and
`artifact_site_upload_status` with `upload_id` to inspect unfinished files. A recovered publish result
may contain only the work, not a share link: inspect sharing before explicitly creating a link.

Direct HTTP is also supported:

- Send `Idempotency-Key` (8–128 letters, digits, `.`, `_`, `:`, `-`) on `POST /api/sites`,
  `/api/sites/<slug>/versions`, `/api/sites/<slug>/edit`, `/api/uploads`, and
  `/api/uploads/<versionId>/commit`. Use a separate key for each operation, including start and commit.
- Save the key **before** sending. Keys are scoped to the authenticated owner (or an established
  anonymous cookie). The same key with changed parameters is a 409 `idempotency_conflict`.
- `GET /api/operations/<key>` returns `running`, `retryable`, or `completed` with `result` and
  `httpStatus`. Completed results are stored atomically with the business commit, retained for seven
  days, and replayed without creating another artifact/version. Expired keys return 410; never use
  an expired key to start over without first checking the previous outcome.
- `GET /api/uploads/<versionId>` returns uploaded files (with SHA-256 receipts for completed transfers), partial MCP chunk progress, and `expiresAt`. Uncommitted bytes expire
  after six hours. Check the **commit operation first** before replacing an expired/missing session.
- A 409 `operation_in_progress` means wait and query/retry the same key. A worker interrupted before
  committing can be reclaimed after its five-minute lease. Old workers are fenced at the database commit.
- Only `413` with `code: "inline_upload_too_large"` and `effect: "none"` confirms an inline request
  was rejected before publication and can switch to per-file uploads. A gateway page, timeout,
  connection failure or 5xx does not establish the outcome. Query the operation instead of issuing a
  new create. Legacy servers without operation queries need manual verification after uncertain failures.

## What to do when it fails

The response body is JSON `{"error":"…"}`. **Read the message before deciding**; the status code alone is not enough to tell the cause:

| Status | Meaning and action |
|---|---|
| 400 | Wrong mode/fields, an unsafe path, corrupt archive, or a legacy HTML-entry requirement. Servers advertising `packagePaths: 1` preserve ordinary hidden files and directories in packages. **Limit violations can land here too** — inspect `site too large` / `too many files` / `file too large`. Fix according to the message, do not retry unchanged input. |
| 401 | The cookie form without `Origin` (or a value differing from `$BASE`); add `-H "origin: $BASE"`. A 401 in the token form = the token was not recognised (check that `Bearer ahp_…` is complete) **or has been revoked** — follow the error message and walk the user through the device authorisation again; do not sneak past with an anonymous publish (the work would not belong to the user). |
| 403 | No permission to change: wrong cookie, insufficient work role, or an `editToken` on an account-owned work. Read the authentication and publishing topics. |
| 413 | **JSON body** = the app refused an inline request body exceeding `ARTIFACT_INLINE_UPLOAD_MAX_BYTES` (default 24 MiB), checked against both Content-Length and actual bytes read; **HTML error page** = likely an intermediary refusal; inspect gateway logs and operation status before assuming no effect. |
| 429 | Rate limited. **There is no `Retry-After` in the response**; back off and retry on your own. |
| 5xx | Reads can be retried with backoff. For writes, inspect operation status and reuse the original key and arguments; never repeat an uncertain non-idempotent write. Report repeated failure with its status and message. |

Checks run in the order **429 → 401/403 → 413 → parsing**, so with bad credentials you never see a size error.

**Verify once after a successful publish**. Use authenticated `artifact_site_get_site` or `GET /api/sites/<slug>` to verify the intended version and visibility. For a private work, an unauthenticated `/s/<slug>` returning 404 is expected; do not broaden access to make a verification pass.

After explicitly enabling `unlisted` or `public`, check `/s/<slug>` without owner credentials and confirm it opens. For an advanced link, verify its configured audience (password/login links are expected to show a gate). Keep internal `/api/preview/` resource URLs out of the delivery.
