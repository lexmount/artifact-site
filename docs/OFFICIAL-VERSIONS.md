# Official versions

A report has two independent pointers: `current_version_id` (latest) and
`official_version_id` (optional designation). There is no report-wide content lock.
Snapshots remain immutable. Setting a historical version as official does not roll back,
copy files, change the latest pointer, or change an existing fixed-version share.

## Storage and concurrency

The additive migration adds `official_version_id`, `official_set_at`, `official_set_by`
and `official_revision` to `sites`. The pointer references `versions(id)`. Existing sites start without a designation. The actor
is resolved on the server, and anonymous identifiers are never returned in public responses.

Set/clear verifies that the version belongs to the live site under the site's row lock,
updates the pointer and revision, and writes an audit record in one transaction. Supplying
`expectedRevision` rejects stale changes with HTTP 409, including set/clear/set races.
Setting the already-designated version is idempotent when the revision matches.
Uploading with `official: true` inserts the version, advances latest, designates it and
records both actions in the same transaction. A failed upload does not remove the old designation.

## HTTP

| Endpoint | Contract |
| --- | --- |
| `GET /api/sites/:slug/official` | Accessible version IDs/numbers, official/latest pointers, setting time, manager-only display name; management flag and revision |
| `PUT /api/sites/:slug/official` | `{ versionId, expectedRevision? }` |
| `DELETE /api/sites/:slug/official` | Optional `{ expectedRevision }` |
| `POST /api/sites` | Existing JSON/multipart upload plus optional `official` |
| `POST /api/sites/:slug/versions` | Same flag, alongside existing `expected_version` query |
| `POST /api/uploads/:id/commit` | Optional `official` in the final JSON commit |
| `GET /api/sites/:slug`, `/text`, `/export` | Optional `version` query selects the authorized snapshot |
| `POST /api/sites/:slug/edit` | Optional `baseVersionId` selects the source tree; requires `expected_version` to protect latest |

Use JSON booleans or multipart `true`/`false`; omitted means no designation change.
Setting is subject to `site.version.official.manage` (owner/site admin and explicit governance
access); content editors cannot designate. CSRF checks match existing write routes.

Ordinary report readers and unpinned view links can open latest and the designated official
snapshot. Fixed-version links remain restricted to their fixed version. Historical access
otherwise remains restricted to authorized members. Designation is never an access grant.

## UI

- Home drop target size is unchanged. Picking, dropping or pasting opens a native modal with
  an unchecked official option, Cancel and Upload. Escape cancels. Large uploads use the same flow.
- Viewer chrome shows separate latest/official labels and a shortcut for management users.
- `/s/:slug?version=:id` is a version-specific reader with the same sandbox and access checks.
  Returning to the plain address resumes latest. A pinned reader never automatically advances.
- History lists independent current and official badges and direct designation actions.
- Lists show the official version number without changing the card's default latest link.
- Formal snapshots can be used as the base of a new version. Source and visual saves preserve
  the source tree, refuse a concurrent latest change, and leave the formal snapshot unchanged.
  On HTTP 409, edits remain in the editor with a prompt to copy them before refreshing.
- Sharing keeps its existing fixed/latest choices, adding official labels to version options.
- Only managers poll designation metadata every ten seconds. Reader status bars refresh on
  page load, window focus and local changes; history refreshes when opened. Version events
  describe content changes only.

## Verification

`test/official-version.test.ts` covers the store contract. `test/official-api.test.ts` covers
permissions, CSRF, stale revisions, replacement uploads, chunk commits, fixed shares and
historical-tree editing/export. Both run against SQLite and in `make test-pg`.
Remote MCP and CLI suites exercise publication, replacement, historical designation and removal.
`test/official-version.e2e.test.ts` is gated by `VIEWER_E2E_URL` and checks real browser flows.

View totals count retained direct and share-link view records. No view-log pruning job currently runs; enabling retention later would make this a retained-history total rather than a lifetime counter.
