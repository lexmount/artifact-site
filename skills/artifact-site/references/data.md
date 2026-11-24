# Shared artifact data (HTML and file packages)

Use named JSON datasets when chart values change independently of HTML. Data belongs to the
artifact, shared by its readers. This is not visitor storage. Documents and works requiring
content moderation cannot enable this capability in the first release.

Publish/update/edit (including upload commit) accept `dataContract`, a mapping of dataset names
to JSON Schemas, and `dataChanges`, an array of `{name, expectedRevision, value}` replacements.
Use revision `0` to initialize a dataset. An omitted contract inherits the previous contract;
an explicit mapping replaces it. Omitted datasets are retained internally for later compatible
code changes, but are neither readable nor writable until declared again. They still count
toward limits. There is no dataset deletion or historical-data restore operation in this release.

```json
{
  "dataContract": {
    "sales": {
      "type": "object",
      "properties": { "amount": { "type": "number" } },
      "required": ["amount"],
      "additionalProperties": false
    }
  },
  "dataChanges": [{"name":"sales","expectedRevision":0,"value":{"amount":100}}]
}
```

Hosted JavaScript reads the data loaded with that document:

```js
const sales = await window.artifactData.get("sales");
renderChart(sales);
// artifactData.info(): versionId, mode, updatedAt, revisions
```

The adapter is read-only and needs no credentials or network access. Missing datasets reject
with `data_not_found`; handle the error visibly instead of treating it as an empty dataset.
Data changes appear on opening or refreshing the page. There is no polling, subscription, or
browser write API for these named JSON datasets. Use record collections below for forms. Keep all uploaded HTML inside the existing sandbox and retain its CSP.

For a data-only update, read `GET /api/sites/:slug/data/:name`, then send
`PUT /api/sites/:slug/data/:name?expected_version=VERSION` with
`{"expectedRevision":REVISION,"value":NEW_JSON}`. This advances only the dataset revision,
without a code version. MCP equivalents are `artifact_site_data_list`, `artifact_site_data_get`
and `artifact_site_data_set`. They take `slug`, `name` as appropriate, and the set tool also
requires `expected_version`, `expectedRevision` and `value`. CLI equivalents:

```sh
artifact-site data list SLUG
artifact-site data get SLUG sales --json
artifact-site data set SLUG sales ./sales.json --expected-version VERSION --expected-revision 1
artifact-site update SLUG ./index.html --expected-version VERSION --data-contract ./contract.json --data-changes ./changes.json
```

Publishing code or changing its contract validates the current data and captures a snapshot.
If the schema changes incompatibly, submit transformed **current** data in `dataChanges` with
the code. Everything commits atomically. Rollback uses the target code/schema against current
data, with the same validation and optional transformations; it does not restore old values.
For data-enabled artifacts, update/edit/rollback require the expected current version. A 409
`version_conflict` or `data_revision_conflict` requires rereading and reconciling; never blindly
retry an overwrite. A 422 `data_schema_mismatch` or `data_missing` leaves everything unchanged.

All share links follow the latest accessible publication, including legacy fixed-version links.
History is for authorized review; explicit data `version_id` reads return the saved snapshot.
Reader URLs selecting the current version still load current data. Intentional history previews
use `snapshot=1` and require history access, including when the selected code is still current.
Visual and source editor previews load authorized data without changing the original source.
Editors can request `GET /api/sites/:slug/data?values=1` for one coherent data/contract read;
add `version_id` for a historical snapshot. Bulk values require content-edit permission.
`/download`, `/export`, `artifact_site_download`, `artifact_site_export`, and CLI downloads return
original immutable files or an existing original archive. They never assemble a ZIP or embed
server JSON. A multi-file version without an archive returns a file manifest; download individual
files with `?file=<path>` or `artifact-site download --file <path>`. Historical versions still
require history access. S3/CDN endpoints return a short-lived URL after each authorization;
follow it without forwarding Bearer/share headers. Local storage returns attachment bytes.
A downloaded file that calls `artifactData.get()` needs the hosted runtime; use the explicit snapshot export below to assemble an offline copy with saved data.
Forking creates independent copies of current data; it does not share future writes.

Limits: 16 retained datasets per artifact, 256 KiB JSON per dataset, 1 MiB total current JSON,
64 KiB contract, data nesting 32 levels. Data, contracts and version snapshots count toward the
owner's storage quota. Names match `[a-z][a-z0-9_-]{0,63}` (excluding `constructor`/`prototype`).
The bounded JSON Schema 2020-12 subset supports type, properties, required,
additionalProperties, items, enum, const, numeric min/max, string/array/object size limits,
title and description. Schemas allow at most 256 nodes and 12 nested levels. `$ref`, regex,
formats, defaults, coercion and custom keywords are unsupported. Validation never changes data.

### Original downloads for agents

- For reading or summarizing, use `artifact_site_read`; its bounded text response is not a binary backup.
- For original files, use `artifact_site_download`. Its `url` is ready for an unauthenticated HTTP
  fetch; its legacy `downloadUrl` is a business API endpoint requiring your configured credentials.
  Never forward those credentials to `url`. Save `filename` and `versionId`, and renew an expired
  URL for that same version rather than silently switching to the latest.
- Without external HTTP fetching, use `artifact_site_export` for a manifest and Base64 chunks,
  pinning all chunks to the manifest version and advancing `nextOffset` until `done`.
- CLI `download` and `export` stream to disk through CDN when configured, or S3/local delivery
  otherwise. They clean up temporary files on failure/cancellation and retain an existing output
  until the replacement completes. Neither command assembles archives or embeds live data.

## Download a snapshot with saved data

Original-file downloads remain unchanged. For a runnable copy containing current **saved server**
JSON, use `POST /api/sites/:slug/snapshot` with `{ "collections": [] }`, CLI
`artifact-site snapshot SLUG --out page.zip`, or MCP `artifact_site_snapshot`. Unsaved form input
is excluded. Records are excluded unless explicitly selected, e.g. `--collections responses`;
including any collection requires data-management permission in addition to source-export access.
Anyone receiving the ZIP can read included records: select only the requested export audience.

Documents and moderated works do not support this snapshot export, even with no selected data.
A snapshot captures one current page version and coherent saved data. HTML receives offline
`get/info` and selected collection `list/get`; mutations reject `snapshot_read_only`. Export limits:
200 original files, 20 MiB original bytes, 5,000 selected records, 8 MiB embedded data and 32 MiB
assembled bytes. External resources remain external; the export does not mirror third-party URLs.
HTTP/CLI stream a ZIP; MCP returns base64 only for ZIPs up to 1 MiB and directs larger exports to
HTTP/CLI. The platform data panel offers saved-JSON-only and explicitly selected-collection exports.

If an existing agent connection still shows an older tool list, request fresh `tools/list` or
reconnect. Fresh connections discover current server tools; host-side tool caching is controlled
by the client, not guaranteed to refresh on every prompt. CLI features require a package built
from this release; an already-installed older npm package does not gain them from a server update.
