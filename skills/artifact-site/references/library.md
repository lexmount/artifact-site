# Finding and organizing existing work

For **"my works" / "what have I published?"**, call `artifact_site_find` without `query`
(CLI: `artifact-site find`; API: authenticated `GET $BASE/api/me/sites`). Report `owned`
as the user's works and `collaborating` separately. `GET $BASE/api/sites` is the **public
catalog even when a token is supplied**; it is not a personal listing.

Keyword search (`artifact_site_find` with `query`, CLI `find <words>`, API `/api/search?q=…`)
can include other people's public works. Label each result using `relationship`: `owned`
(my work), `collaborating` (shared with me), `anonymous` (created by this browser), or
`public` (other public work). `visibility` is separate: my own work may also be public.
Do not call a mixed result set "your works". Older servers without relationship metadata
return discoverable results; do not infer ownership from public visibility.

An empty personal list means no personal results, not signed out. If personal listing fails,
use `artifact_site_connection` or `/api/auth/me` to diagnose the current **Agent connection**:
a browser login does not automatically authenticate CLI/MCP, and an operator credential has
no personal library. Explain missing identity before showing an explicitly labeled public
catalog as a fallback: MCP `artifact_site_find {scope:"public"}`, CLI `artifact-site find --public`,
or HTTP `GET $BASE/api/sites`. These listing options omit keywords; keyword search retains its
mixed scope and relationship labels. A revoked token needs reconnection;
a permission error or server/network failure is not proof of being signed out. Never silently
replace a failed personal request with public results, or ask users to paste credentials into chat.

To organize work, use these two MCP tools:

1. `artifact_site_folders {}` → `{scope:"mine", folders:[{id,name,createdAt}]}` for the connected
   account. Match the requested name locally; disambiguate duplicate names by ID. Folder IDs
   are stable and may be saved for later runs on the same server/account.
2. After publishing, `artifact_site_move {slug:"…", folder_id:"fld_…"}` →
   `{ok:true, slug:"…", folderId:"fld_…"}`. Use `folder_id:null` to move to Unfiled.

These are flat personal folders. Moving changes only the caller's organization, never sharing,
ownership or contents. Unknown/inaccessible folders or works fail; there is no default-folder
fallback. If publication succeeded but moving failed, report both outcomes and retry only the move.
Publishing itself takes no folder parameter. Existing works can be moved without republishing.

The equivalent CLI workflow is:

```bash
artifact-site folders list --json
artifact-site move --folder "<folder-id>" -- "<artifact-slug>"
artifact-site move --unfiled -- "<artifact-slug>"
```

Choose exactly one move destination. `--json` returns structured results. CLI `whoami` identifies
operator credentials without publishing a test work; an operator has no personal folders.

The equivalent API workflow is:

```bash
curl -sS "$BASE/api/me/folders" -H "authorization: Bearer $TOKEN"
curl -sS -X PUT "$BASE/api/me/folders/assignments" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"<artifact-slug>","folderId":"<folder-id>"}'
```

## Finding and reading works that already exist

Two read-only calls, for when the user asks "what did we publish about X?", "update the report from last week", or wants the content of a work without a download. Both take the token (or nothing, on a public deployment for public works) and answer with the same `X-Artifact-Site-Skill-Version` header as everything else.

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
# text types only (html, css, js, json, md, csv, …, up to 2MB); anything else answers 415 — download the original file instead
```

- Search covers what the token's owner may list: their own works, works they may edit, and public ones. A private work that is reachable only through a share link is deliberately not searchable.
- A work published seconds ago may not be searchable yet (its text is extracted right after the upload); reading it works immediately.
- To change what you found: `versionId` from the read is the baseline for `expected_version` in section 2, exactly like the export's.
- With the CLI: `artifact-site find <words…>` and `artifact-site read <slug> [--file <relpath>] [--max-chars <n>]`; over MCP: `artifact_site_find` and `artifact_site_read`.

The unkeyed preview entry URL (`/api/preview/<slug>`) accepts legacy `?v=` for an authorized version ID; invalid or foreign IDs return 404. Use `?r=` to cache-bust that entry URL. Resource URLs may use `?v=` as their own cache tag; platform version selection on entry or file URLs uses `__artifact_version`. Historical editing uses the selected snapshot for both entry HTML and its resource tree; saving creates a new latest version.
