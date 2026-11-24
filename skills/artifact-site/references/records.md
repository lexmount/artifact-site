# Record collections: forms and shared lists

Choose `dataContract` + `dataChanges` for agent-managed chart/report JSON. Choose `dataCollections`
for individual form submissions, counters stored in records, and shared lists. Both models can
coexist; record writes do not publish another page version. No automatic polling or subscriptions:
call `list()` again on a Refresh button, or reload the page. Collections require an account-owned
HTML/file artifact; documents and moderated works are excluded.

Publish/update/edit accept `dataCollections` as a mapping. CLI uses `--data-collections FILE`.
Omitting it inherits definitions; `{}` disables collections while retaining their records.
Changing definitions requires `site.data.manage`. Example private response collection:

```json
{
  "dataCollections": {
    "responses": {
      "schema": {
        "type": "object",
        "properties": { "message": { "type": "string", "maxLength": 500 } },
        "required": ["message"],
        "additionalProperties": false
      },
      "access": { "read": "managers", "insert": "visitors", "update": "managers", "delete": "managers" }
    }
  }
}
```

Schema roots require `additionalProperties: false`. Supported fields include
strings, numbers/integers, booleans, null, bounded arrays/objects, required fields, enum/const,
length/range bounds, and `email`, HTTP(S) `url`, and `date-time` formats. No references, regex,
conditionals, defaults, coercion or executable validation. The complete resulting record is
validated after every change. Server IDs, revisions and timestamps are separate from `value`.

Each action (`read`, `insert`, `update`, `delete`) chooses `visitors`, `managers` or `disabled`.
New collections default to managers only. Visitors must already pass the work's visibility,
share and password gates. Insert permission does not grant list/get; receipts contain only
ID/revision/timestamps. Public update/delete additionally require `publicMutation: "open"` and
allow visitors to change **other visitors' records**. Use this only for an explicitly requested
shared checklist; private responses remain private by default.

`site.data.edit` lets owners/editors/viewers use opened runtime actions. `site.data.manage`
is granted by default only to the owner and platform administrator, not site/tenant admins.
Only trusted platform UI and authenticated management APIs can use that privilege: opening
untrusted HTML as the owner never gives its JavaScript access to private responses. Management
APIs can inspect/change enabled collections irrespective of runtime action restrictions.

Hosted JavaScript uses the sandbox bridge, never a token or arbitrary platform fetch:

```js
const responses = window.artifactData.collection("responses");
let pending;
async function submit(message) {
  // Keep this exact payload and key after a lost response. Do not clear form input on error.
  pending ??= { value: { message }, operationKey: crypto.randomUUID() };
  const receipt = await responses.create(pending.value, { operationKey: pending.operationKey });
  pending = undefined;
  return receipt;
}
const tasks = artifactData.collection("tasks");
const page = await tasks.list({ limit: 50 }); // { versionId, records, nextCursor }
const record = await tasks.get(page.records[0].id);
await tasks.update(record.id, { done: true }, {
  expectedRevision: record.revision, operationKey: crypto.randomUUID()
});
// tasks.delete(id, { expectedRevision, operationKey })
```

PATCH merges top-level fields only; nested objects/arrays replace the previous field. Omitted
fields stay unchanged; `null` is a value when the schema allows it. Pass `unset: ["optionalField"]`
in update options to remove an optional field. Render user text with `textContent`, not `innerHTML`.
The SDK captures a JSON copy of values/options immediately, including while waiting for host hydration.
Persist pending input/key in your UI if retry must survive navigation. SDK-generated keys are also
returned as `error.operationKey` on errors; explicit saved keys are preferable for form recovery.

Management HTTP endpoints (owner/platform administrator, ordinary authentication):

| Method and path under `/api/sites/:slug` | Input / output |
| --- | --- |
| `GET /collections` | Schemas, policyRevision, access, counts, bytes, capabilities and limits |
| `PATCH /collections/:name/access?expected_version=VERSION` | `{expectedRevision, access, publicMutation?, rate?}`; current policy, not page history |
| `DELETE /collections/:name?expected_version=VERSION` | `{expectedRevision, deleteRecords:true}`; disabled collections only, permanent cleanup |
| `GET /collections/:name/records?limit=50&cursor=CURSOR` | `{versionId, records, nextCursor}`; optional cursor, max 100 |
| `POST /collections/:name/import?expected_version=VERSION` | `{rows, operationKey, validateOnly?}`; atomic append, at most 200 records; preview returns `{valid:true,count,versionId}`, commit returns `{imported,versionId}` |
| `GET /collections/:name/export?q=TEXT&filter=JSON` | CSV of all matching records, at most 5,000 rows / 8 MiB of stored JSON; optional `expected_version` |
| `GET /collections/:name/records/:id` | Record value and server metadata |
| `POST /collections/:name/records?expected_version=VERSION` | `{value, operationKey}`; minimal receipt |
| `PATCH /collections/:name/records/:id?expected_version=VERSION` | `{value, unset?, expectedRevision, operationKey}` |
| `DELETE /collections/:name/records/:id?expected_version=VERSION` | `{expectedRevision, operationKey}` |

The management dialog displays schema fields as table columns and editable form inputs, with
an advanced JSON editor for complex values. Adding/removing schema fields stays with the agent.
Both editors show the complete record: clearing an optional form input or removing a property
from the JSON draft deletes its saved value. An untouched empty string or null is preserved.
The dialog computes `unset` automatically; HTTP/SDK/MCP/CLI PATCH operations remain partial merges.

List and CSV export accept optional `q` (case-insensitive substring across stored field values,
up to 200 characters) and `filter` (URL-encoded JSON `{ "field": "done", "value": false }`).
Filtering is one exact, typed, top-level scalar match; missing fields do not equal null.
For nullable fields, the dialog offers a separate Null choice. Typing `null` as a string value
matches literal text; selecting Null matches JSON null, not a missing field or an empty string.
Both run across the entire collection before pagination. Keep the query/filter unchanged while
following a cursor; changing them requires starting from the first page. Export captures all
matching rows in one transaction and rejects oversized results without silently truncating.

CSV import in the dialog previews the first ten rows and validates the whole batch before saving.
It accepts UTF-8 CSV up to 2 MiB / 200 data rows; headers must be existing field names and include
required fields. Numbers, booleans, arrays and objects use JSON syntax. Nullable/untyped fields
also use JSON (including quotes for strings). Unquoted empty optional cells are omitted; quoted
empty string cells are preserved. In a file with one optional column, a blank data line represents
an empty record; other blank lines are skipped. Duplicate/unknown headers, malformed quoting, wrong types or
schema constraints stop the import. Commit validates again and appends the entire batch or none.
Preview reserves no capacity; commit consumes one site create allowance per row (1,000/hour).
HTTP/MCP/CLI import accepts a JSON array in `rows`, not CSV bytes (HTTP body limit 4 MiB).
Use `validateOnly:true` first, then commit; retry identical commit input with the same key for
24 hours after a lost response. Do not allocate a new key automatically after page changes.

CSV export includes only declared data fields, with no record IDs. Formula-like text gets a
leading apostrophe for spreadsheet safety; reimport retains this apostrophe and creates new
records. CSV import/export and batch import require data management and have no visitor routes.
No new database tables, migrations or environment variables are required.

The browser bridge calls the corresponding `/runtime/collections/.../records` routes, which
always enforce visitor policy, including for owners. The page version is selected by the trusted
parent. Cross-origin mutations, forged frame identities and management flags cannot bypass this.
Before anonymous writes the bridge obtains a dedicated HttpOnly receipt cookie through
`POST /runtime/identity`, serialized across tabs with Web Locks. Ordinary reads never issue
this cookie; it is independent of anonymous publication/ownership cookies. Raw anonymous HTTP
clients must serialize initialization, supply the same-origin `Origin`, and retain the cookie
before their first mutation. `GET /runtime/identity` only reports `{ready}` and sets no cookie.
Without Web Locks, an existing record identity or signed-in session still works; a fresh anonymous
browser receives `anonymous_identity_unavailable` and must sign in or use an up-to-date browser.
A missing cookie rejects the write with `anonymous_identity_required` without committing it.
This keeps same-key retries stable after a network/IP change; clearing cookies changes identity.
Historical frames cannot read live records; unpublished previews can read opened collections but
cannot write. Standalone raw HTML must be opened in the hosted viewer to use this bridge.

MCP: `artifact_site_collections_list/access/delete`, `artifact_site_records_list/get/create/update/delete`, and `artifact_site_records_import`.
Inputs use `slug`, `name`, `record_id` where applicable; mutations also take `expected_version`,
`operationKey`, and `expectedRevision` for update/delete. Tools expose input descriptions, output
schemas and structured success results. These are management tools, not visitor impersonation.

```sh
artifact-site collections list SLUG
artifact-site records list SLUG responses --limit 50
artifact-site records list SLUG tasks --query meeting --filter '{"field":"done","value":false}'
artifact-site records import SLUG tasks ./rows.json --expected-version VERSION --operation-key IMPORT_KEY --validate-only
artifact-site records import SLUG tasks ./rows.json --expected-version VERSION --operation-key IMPORT_KEY
artifact-site records export SLUG tasks --query meeting --out ./tasks.csv
artifact-site records get SLUG tasks RECORD_ID
artifact-site records create SLUG tasks ./record.json --expected-version VERSION --operation-key UNIQUE_KEY
artifact-site records update SLUG tasks RECORD_ID ./patch.json --expected-version VERSION --expected-revision 1 --operation-key ANOTHER_KEY
artifact-site collections access SLUG responses ./access.json --expected-version VERSION --expected-revision 1
```

Use a new key (8–128 letters/digits/`._:-`) per logical mutation and reuse **identical input** on
uncertain responses for up to 24 hours. Deduplication is caller-scoped and still checks current
permissions. After expiry, inspect saved records before submitting again. Pagination follows
creation time/ID, not an immutable snapshot; concurrent insert/delete can change later pages.

| Error | Recovery |
| --- | --- |
| `record_import_invalid` (422) | No rows added; correct reported row numbers (header is row 1), then preview again |
| `record_export_limit` (413) | Narrow search/filter below 5,000 rows and 8 MiB |
| `invalid_record_filter` / `invalid_cursor` (400) | Correct the typed filter or restart pagination with the same query |
| `record_schema_mismatch` (422) | Correct the reported field paths; preserve input |
| `record_revision_conflict` / `policy_revision_conflict` (409) | Read latest data and reconcile; never force a silent overwrite |
| `version_conflict` (409) | Preserve input and reload the current page |
| `record_access_denied` (403) / `collection_disabled` (409) | Ask the owner for the intended action/access |
| `record_rate_limited` (429) | Wait `Retry-After` / `retryAfter` seconds |
| `collection_limit_exceeded` / `record_limit_exceeded` (413) | Reduce input or free retained capacity |
| `anonymous_identity_required` (409) | Allow cookies, initialize runtime identity, then retry the same input/key |
| `anonymous_identity_unavailable` (SDK) | Sign in or use an up-to-date browser; preserve the pending input/key |
| `record_response_unknown` (SDK) | Keep input and retry with the same saved operation key |
| `collection_schema_incompatible` (409) | Migrate into a new collection before switching code |

Collection rate budgets count attempted reads/writes, including schema errors, missing records
and revision conflicts. Exact successful-operation replays do not spend the collection budget.
HTTP read and mutation throttles are separate from publishing and from one another.

Limits: 10 retained collections/site, 50 schema fields, 64 KiB combined definitions, 16 KiB/record,
25,000 live records/collection, 100,000/site, 100 MiB retained record JSON/site, plus owner storage
quota. Deleted records disappear immediately; bytes remain charged for seven days before bounded
cleanup. This is retention, not an undo UI. Runtime limits default to 600 reads and 10 writes per
hour per collection/client; `rate` can set up to 10,000 reads and 1,000 writes. All callers share
an additional 1,000 creates/site/hour limit. Fixed windows can reset at the hour boundary.
The bridge allows four pending requests, 120 requests/frame/minute and a 30-second response wait.

Code updates preserve records. Populated schemas accept compatible widening (e.g. optional fields)
only. For breaking changes, create a replacement collection, migrate in pages, pause writes for
final reconciliation, verify, then switch. Rollback checks the same compatibility and does not
rewind records or access policies. Forks copy schema, start empty and reset access to managers.
