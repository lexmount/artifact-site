# Tenants and artifact authorization

Runtime permissions come from the database catalog (`permissions`, `roles`, `role_permissions`)
and scoped `role_bindings`. Built-in roles are seeded by migration; this release does not expose
custom-role creation. `src/lib/rbac.ts` provides the typed vocabulary and a pure fixture catalog.
Comments, reactions and private read progress use the same authorization boundaries.

## Resources and identities

- Users are global identities. `users.tenant_id` is their default creation destination, not an access grant.
- `tenants` are resource boundaries. `tenant_members` records membership only; it has no role column.
  A `tenant-admin` binding supplies administrative authority.
- Every site has a `tenant_id` and at most one `owner_id`. Versions, files, shares and audit records
  are scoped through their site. A version from another site is never a valid version selector.
- A site binding grants `viewer`, `commenter`, `editor` or `site-admin`. Its subject is an active
  user in that site's tenant, all members of that tenant, or global `everyone`. Other tenants
  and their users cannot be named directly. `everyone` uses null subject IDs, never `*`.
- `everyone` may receive viewer/commenter/editor, never administrator. Anonymous visitors receive
  read access only. Logged-in outsiders receive the granted role. Public discovery still follows
  visibility; global grants alone do not list private/unlisted sites in search or My sites.
- A tenant binding grants `tenant-admin` to one existing active member. Whole-tenant site-admin
  grants are allowed, but only someone with `site.admins.manage` can assign or revoke them.
- Shares grant independent access to an exact site and either its latest version or one fixed version.
  A share does not add a tenant or site membership. External collaboration therefore needs no directory membership.
- Anonymous browser identities remain cookie-bound. They have no user or tenant-member row.

## Role matrix

| Role | Scope | Read / source editing | Site settings and sharing | Membership | Ownership / deletion |
| --- | --- | --- | --- | --- | --- |
| Platform administrator | Platform | Administrative access | All | Tenants and their administrators | All; existing moderation console remains available |
| Tenant administrator | Own tenant | Explicit site management access | Yes, in management mode | Tenant members and site roles | Yes, in management mode |
| Tenant member | Own tenant | May create sites; no blanket access to existing sites | No | No | Only sites they own |
| Site owner | One site | All versions and editing | Rename, rollback, shares, audit | Site administrators and editors | Transfer to an active member of the same tenant; delete |
| Site administrator | One site | All versions and editing | Rename, rollback, shares, audit | Viewers, commenters and editors | No |
| Site editor | One site | All versions and editing | No | No | No |
| Site viewer / commenter | One site | Current and official versions; no source export or history | No | No | No |
| Editable link visitor | One link | Latest version; editing requires sign-in | No | No | No |
| Commentable link visitor | One link | Read its permitted version | No | No | No |
| View-only visitor | One link or public main address | Read its permitted version | No | No | No |

Content editing creates immutable versions. Editors cannot rename or roll back the current pointer.
Site-level authority and a link grant are independent: a member does not lose their own role by opening
an inferior link. Tenant membership alone never makes all tenant sites visible.

## Links and resource outlets

- `/s/:slug` is the canonical site page. Public/unlisted sites expose the current version; private
  sites require a site role, creator identity or administrative access.
- `/v/:token` is a share entry. `policy` (`public`, `login`, `people`, `passcode`) answers who may
  enter; `mode` (`view`, `comment`, `edit`) answers what an admitted visitor may do.
- API clients supply `X-Artifact-Share: <token>`; browser editor/preview requests carry `?share=<token>`.
  Being listed on some other share, or possessing a passcode cookie without the link, grants nothing.
- `versionId: null` follows the latest version. A fixed `versionId` must belong to the site and is
  incompatible with `mode: edit`. Changing content through an editable link changes the same site's
  latest version, including what every other latest link shows.
- `/api/preview`, version APIs, source/export and edit-frame routes enforce site/version scope.
  Unknown or foreign version selectors are rejected rather than treated as cache busters.
- Sandboxed documents receive a signed, short-lived **read-only, version-pinned** resource key in
  their base path. Resource keys cannot authorize editing or comments; share revocation, expiry,
  access-policy changes and account/tenant disablement are rechecked. They cannot mint new keys.
  Before any uploaded HTML is served, a share-bearing preview URL redirects to its read-only key URL,
  so artifact JavaScript cannot read an edit-link token from its own location. Anonymous browser
  secrets are represented only by hashes in keys. A latest-link document already loaded keeps
  its snapshot for the key lifetime (30 minutes).
- A random preview key is persisted in the shared database and survives restarts. Optional
  `PREVIEW_SIGNING_SECRET` seeds only the first initialization; stored keys take precedence.
  Platform administrators can rotate it from Settings, with immediate invalidation and an audit log.

## Administration and revocation

The tenant management API requires a browser session with the tenant administrator role, or a platform
administrator credential. Delegated publish/OAuth tokens do not inherit tenant or platform administration.
For ordinary site endpoints, a tenant administrator must supply a nonempty `X-Management-Reason`
(maximum 500 characters); that explicitly enables scoped management and writes an RBAC audit record.
Explicit tenant management takes precedence over an ordinary site role, so the elevated action is
audited. Owners keep their ownership authority even when supplying a reason: their access does not
require an administrative override. Authorization reads record a management event; authorization
mutations record one mutation event with the reason instead of duplicating that event.
The existing platform moderation console retains its audited administrative read path.

Removing tenant membership deletes the user's individual site bindings in that tenant and tenant-admin binding. It refuses
removal while the user owns a live site: transfer ownership first. Independent share grants remain
independent and must be revoked separately if desired. Demotion/removal and account disablement cannot
leave an active tenant without its last active administrator. Membership changes serialize across replicas.

Disabled tenants fail closed for ordinary site reads and writes, including public sites and resource keys.
Only platform administrators can disable or restore tenants. `anonymous` is a protected system tenant;
its membership cannot be edited. Existing platform moderation and deletion retention still apply.

## HTTP API and UI

`/tenants` (Workspaces, linked from My sites) lists memberships, manages members, creates tenants for
platform administrators and explicitly claims this browser's anonymous artifacts.

| Endpoint | Contract |
| --- | --- |
| `GET /api/tenants` | Current memberships; platform admins see all tenants |
| `POST /api/tenants` | Platform-only; `{id, name, adminEmail}` or `adminUserId`; requires an active initial administrator |
| `GET /api/tenants/:id` | Scoped administrator site inventory and RBAC audit (latest 200 each) |
| `PATCH /api/tenants/:id` | `{name}`; platform-only `{disabled: boolean}` |
| `GET /api/tenants/:id/members` | Scoped member list |
| `PUT /api/tenants/:id/members` | `{email, role}` or `{userId, role}`; `admin`, `member`, or `null` to remove |
| `POST/PATCH /api/sites/:slug/shares[/shareId]` | Existing policy fields plus `mode` and `versionId` |
| `GET /api/me/adopt` | This browser's claimable anonymous sites |
| `POST /api/me/adopt` | Explicit `{tenantId}`; browser cookie plus destination membership required |

Creation and chunk-upload APIs accept `X-Artifact-Tenant`. Omitted means the user's default tenant;
anonymous creation always uses `anonymous`. Chunk sessions retain the selected tenant and recheck it
on commit. MCP forwards explicit share and tenant headers to the same API gates.

Cookie-authenticated writes retain the same-origin CSRF checks. Agent credentials retain their existing
scope checks; knowing a tenant ID, site slug or version ID never creates authorization.

## Comment permissions

See [the comment contract](COMMENTS.md) for scope, provenance and adapter requirements.

The catalog includes read, create, reply, edit/delete/resolve-own, resolve, moderate and aggregate actions.
Owners/site admins/tenant admins can moderate; no role may edit another author's message body.
Commenters and editors may read/reply and operate on their own messages. Permanent editors may
also resolve/reopen others' visible threads through `comment.resolve`; share-derived editors may
only resolve their own. The permission catalog alone does not verify this provenance. View-only share visitors cannot
read that share discussion. Moderation is separate from changing another author's text.

Every comment operation authorizes the exact discussion scope:
`site + version + (main scope OR share ID)`. The main address supports its own discussion. Different
links on the same version never expose each other's threads. Aggregation is a management capability,
not a separately assignable cross-link access role. Main comments set to `off` override ordinary
commenter grants; managers retain moderation access. A commenter grant qualifies for `members`.
The existing `login` policy permits signed-in readers to participate, including view-only site readers.

## Database schema and grant API

| Table | Columns and invariants |
| --- | --- |
| `permissions` | `code` PK, `resource_type`, `description` |
| `roles` | `id` PK, `code`, `resource_type`, nullable `tenant_id`, `is_builtin`, `description`, `created_at`; unique code globally for built-ins / within tenant for future custom roles |
| `role_permissions` | `role_id` + `permission_code` composite PK and FKs |
| `role_bindings` | `id` PK; `subject_type` + nullable `subject_user_id` / `subject_tenant_id`; `resource_type` + nullable `resource_tenant_id` / `resource_site_id`; `role_id`, `created_by`, `created_at`, `updated_at`, positive `revision` |

Foreign keys and checks reject ambiguous subject/resource shapes, wrong role scope and global admin
grants. One direct role per subject/resource is unique. Multiple sources combine; the built-in site
roles are nested, so the strongest applies. Membership, disablement, link restrictions and comment
settings are additional gates. Custom roles would require relaxing the built-in binding whitelist and
replacing the strongest-role projection with an arbitrary permission union; the four-table storage
layout is already in place, but arbitrary roles are deliberately not exposed yet.

`authorization_tenant_members` and `authorization_site_members` are read-only SQL projections,
not additional storage tables. They keep authorization and list/search queries on the same bindings.
No authorization cache is introduced: role catalog and grants are queried on every request, and
mutations recheck inside the shared RBAC transaction. Revocation is visible to the next request,
including previously minted preview credentials and in-progress upload commits.

All list APIs accept numeric `cursor` and return up to 50 rows plus `nextCursor`; resource and subject
pickers accept `q`. Roles and effective permissions are small unpaginated results.

| Endpoint | Contract |
| --- | --- |
| `GET /api/authorization/resources?type=site\|tenant&q=…` | Resources caller can administer |
| `GET /api/authorization/subjects?resourceType=…&resourceId=…&type=user\|tenant&q=…` | Active own-tenant candidates; only the resource tenant for `type=tenant` |
| `GET /api/authorization/roles?resourceType=…&resourceId=…&subjectType=…` | Assignable role IDs and permission codes |
| `GET /api/authorization/bindings?resourceType=…&resourceId=…` | Direct bindings, identity, revision and timestamps |
| `POST /api/authorization/bindings` | `{resource:{type,id},subject:{type,id?},roleId}`; `everyone` omits `id` |
| `PATCH /api/authorization/bindings/:id` | `{roleId,expectedRevision}` |
| `DELETE /api/authorization/bindings/:id` | `{expectedRevision}` JSON body |
| `GET /api/authorization/effective?resourceType=…&resourceId=…` | Current user's site action flags and binding sources, or tenant role |

Stale revisions return 409. Duplicate POST of the same role is idempotent; changing an existing
binding requires PATCH. Site-admin changes require `site.admins.manage` in both directions.
Tenant-admin removal cannot remove the last active administrator. Mutations retain CSRF and token
scope checks and record actor, resource, subject, role and management reason atomically in `rbac_audit`.

Administration → Authorization provides a resource picker and audited management reason.
Site Sharing → The site itself embeds the same grant editor for owners/site admins; Workspaces
links to `/authorization`, the same resource picker scoped to the caller's manageable sites and tenants.
Share-link editing remains separate. Grant management exclusively uses `/api/authorization/*`;
the old `/api/sites/:slug/collaborators` endpoint is removed. Tenant membership APIs remain active:
they manage membership and use bindings for the administrator role. `/api/sites/:slug/sharing` now
accepts and returns visibility only (GET also returns `siteId`); retired `editPolicy` requests are rejected. Permission descriptions expose `canManageGrants`
in place of `canManageCollaborators` and omit the constant `enforced`/`legacyGrandfathered` flags.
CLI/MCP use the existing publication/share APIs and do not call the removed collaborator endpoint.
Agent tokens remain
credentials acting for their user within granted OAuth scopes; they are not independent principals
or new resource types in this release.

## Migration and deployment order

The supported direct upgrade starts at 0.2.0 (`19f9c3b`), before the four-table RBAC change.
There is no requirement to deploy PR1 separately: the next release includes import and cleanup.

1. Back up metadata, drain requests and stop **all** older instances sharing the database,
   including 0.2.0 instances and pre-release PR1 builds. Different domains do not create separate
   databases or migration boundaries. A rolling upgrade across this boundary is unsupported.
2. Start one cleanup-release instance. For 0.2.0 databases, migrations 0007–0008 first import
   tenant administrators and eligible site roles into bindings. Migration 0009 then drops
   `site_members`, `site_collaborators`, unused `site_invites`, and `rbac_migrations`, and removes
   `tenant_members.role`, `sites.edit_policy`, and `sites.claim_token`. For databases that already
   completed PR1, the import is skipped and existing bindings are preserved. The startup runs
   inside the migration transaction and replica lock; failure rolls back the upgrade.
3. Start the remaining new instances after the first starts successfully. Completed migrations
   are skipped. Neither 0.2.0 nor PR1 binaries may run against the cleaned schema: they still
   depend on retired columns and can recreate old storage on restart.
4. Verify grant/revoke operations across domains, comments, shares, anonymous management and
   CLI/MCP publishing. No manual permission switch is required. Do not roll back an old binary
   against the cleaned database; recovery requires the pre-upgrade backup and matching version.
5. Historical numbered migrations 0001–0008 remain immutable. A historical bootstrap runs only
   before 0007 has been applied, allowing fresh installations and supported historical upgrades
   to execute the same import before cleanup. Normal restarts never recreate retired storage.
   `tenant_members` and the binding-backed authorization views remain: they are active data and
   read projections, not obsolete compatibility tables.

Pre-merge PR1 testing caveat: databases initialized with the intermediate `347d08d` still fail
0007's checksum guard. Only disposable test databases may be recreated; retain backups and
reconcile non-disposable data separately. Never remove tracking rows or overwrite checksums to
rerun the legacy import: that could restore revoked grants.

SQLite and Postgres tests cover migration/restart, scoped binding CRUD, optimistic conflicts, subject
boundaries, permission union, comments-off precedence, preview downgrade, leaving/rejoining, last-admin
protection and authorization API/CLI/MCP behavior. Browser acceptance covers the new grant editor.

### Preview credential confidentiality

Preview grants use AES-256-GCM with a domain-separated HKDF key derived from the persisted preview secret. The payload is encrypted so uploaded JavaScript cannot read viewer or share identity from the resource URL. Concurrent first starts converge on one database key. No process-local key cache delays revocation; every credential mint/verification reads the shared key. Administration → Settings exposes generation time and a confirmed rotation action, never key material. Rotation uses a revision guard and records its audit entry in the same transaction; stale concurrent rotations return 409. Share links and login sessions are unchanged. Public current-version previews without a share use stable credential-free resource URLs. Visual editing of historical HTML intentionally uses the current resource tree, matching save semantics.

### Audit storage and retention

Production audit records live in PostgreSQL: `audit_log` records artifact mutations and their actors/version/request metadata, `admin_log` records platform management actions and administrative reads, and `rbac_audit` records tenant/permission management with tenant, actor, target, reason and timestamp. SQLite mirrors them for tests. These tables intentionally have no cascading site/user foreign keys; normal site deletion and file purging preserve the audit trail.

Platform administrators configure **Administration → Settings → Audit log retention (days)** for all three audit tables. The default is **0 (keep forever)**; valid values are 0–3650 whole days. A console value is persisted in the global `settings` table and overrides `ARTIFACT_AUDIT_RETENTION_DAYS`; “Use environment” removes the override. Every change is audited. Settings-change and maintenance entries follow the same retention window as other administrator logs. Cleanup reads the current persisted value inside its deletion transaction, without the policy cache, and serializes with settings updates across replicas.

The request-driven maintenance tick runs at most once an hour per process when create or search routes are used. Each tick drains expired records in batches of up to 1,000 **per table**, until no batch is full or a 20-second budget is consumed. Each batch has its own transaction, releases the RBAC lock and re-reads retention; queued policy changes can stop or adjust subsequent batches. The budget is soft: an in-flight batch finishes before stopping. Idle deployments do not run a timer; remaining backlogs resume on the next tick, so retention is a target rather than an exact expiration deadline. **Administration → System → Prune expired audit logs** runs the same budgeted job on demand (`POST /api/admin/maintenance` with `{"task":"prune-audit"}`). Only the `reconcile` maintenance task supports `dryRun: true`; all other tasks reject it before execution. Records exactly at the cutoff are retained. Increasing retention or setting it to 0 cannot recover deleted records; database backups have their own retention policy.

API result limits (for example the latest 200 tenant audit entries) limit display only. The one-hour collapse of repeated email-administrator reads is deduplication, not retention, and is currently fixed in code. Deleted-site file retention and the 30-minute preview credential lifetime do not apply to audit records. Direct previews record access at their entry gate, without an additional `site.preview` event.

## Unified enforcement and upgrade compatibility

RBAC is always enforced. `ARTIFACT_ENFORCE_OWNERSHIP` is a deprecated, ignored
configuration value; OIDC configuration no longer selects a different permission system.
All authority (account, operator, explicit administrative management, anonymous management,
and share access) resolves through the role catalog. UI actions use server-returned permissions.

- An unowned site in the `anonymous` tenant accepts its creating browser cookie or its
  exact management token, subject to the anonymous read-only policy. Neither a token nor
  a localStorage key proves authorship. Account-tenant orphans never accept management tokens.
- Account-owned sites never accept management tokens. New owned sites return no edit token
  or claim receipt. The idempotent migration clears only their obsolete token columns;
  ownership, tenant, visibility, versions, shares and memberships are unchanged.
- Signing in does not claim sites. Claim explicitly in Workspaces with the creating browser
  cookie, a signed-in account and active destination membership. Historical token-only sites
  require administrator assignment. Claim/assignment/transfer permanently retires old tokens.
- Ordinary disown (`DELETE /api/sites/:slug/ownership`) returns `410 disown_disabled`.
  Transfer requires ownership permission and an active account in the same tenant.
- Reading rendered content or extracted text does not grant source access. File-list/source
  APIs, `text?file=`, ZIP export and fork require `site.source.export` (editor or higher).
  Preview HTML/JS/assets must still be readable to render a page; this is not DRM.
  `version_id` and fixed shares select exact readable versions rather than substituting latest.
- Cookie/query credentials require a same-origin request for every mutation, including new
  upload sessions and their PUT/commit steps. Only a validated explicit header credential
  bypasses this origin check. An invalid token cannot exempt a valid account cookie.
- Upload staging rechecks access on each request. Version publication rechecks current
  credentials and permissions after storage work, under the RBAC transaction lock, with
  version pointer and audit inserted atomically. Membership/ownership changes and credential
  revocations serialize with that final check. Aborted storage remains subject to normal cleanup.
- Private preview grants bind to their originating session or token. Credential/share revocation,
  ownership change, tenant disablement and anonymous-token rotation are rechecked on resource
  requests. Pre-upgrade unbound grants expire immediately; reloading the authorized page remints
  a grant without asking the user to authorize MCP again.

Personal `ahp_` tokens, MCP OAuth credentials, consent scopes, refresh and device login keep
 their formats and stored identities. Valid owners/editors continue using existing credentials;
 revoked credentials and read-only source requests are rejected consistently. CLI supports
 `--tenant` / `ARTIFACT_SITE_TENANT` and `--share-token` / `ARTIFACT_SITE_SHARE_TOKEN`;
 MCP tools accept optional `tenant_id` and `share_token`. The old `email` share-policy name
 remains an alias of `people`; new share controls expose `mode` and fixed `versionId`.
 A public share opens its `/v/` link without changing the canonical site's visibility.

Deploy all serving replicas to the new authorization code before considering convergence
complete. Do not leave old images serving writes: the deprecated switch cannot enforce this
policy in those binaries. No account credential rotation or bulk ownership migration is required.


### Publication lock and capacity

Final publication checks and writes share the deployment-wide RBAC advisory lock with
membership changes, credential revocation, tenant administration and audit-prune batches.
Only one such transaction progresses at a time across replicas: approximate maximum
throughput is the inverse of average lock-hold time, and contention adds queueing latency.
There is no fixed requests-per-second promise; measure lock waits and transaction duration
with the deployment's database latency and workload. Storage I/O and request parsing happen
before acquiring the lock. Audit-prune batches release it between batches.

This deliberately prioritizes revocation ordering. A site-row lock alone does not serialize
publication against user disablement, token revocation or tenant membership changes, which
update other rows. Replacing the global lock requires a coordinated lock protocol covering
those credential and membership rows too, with consistent lock ordering.

Anonymous receipt exchange uses one HttpOnly cookie, bounded to eight recently opened
artifacts and 3,000 encoded bytes, with a one-hour lifetime. Listing artifacts only verifies
headers and never mints cookies. Evicted receipts remain in local storage and can be exchanged
again on opening an artifact; the creating-browser cookie remains the normal creator proof.


### Authorization consolidation and upgrade compatibility

Production report routes gate named permissions (`site.content.edit`, `site.rename`,
`site.sharing.manage`, etc.). The old `requireActor`, `requireCapability`, ranked capability projection, and constant
enforcement flags are removed. Retired role storage, edit policy and claim receipt columns are
removed by migration 0009. Anonymous creator
proof still applies only to ownerless reports in the anonymous tenant. Personal tokens and
OAuth/MCP connections keep their existing identities, revocation and scope checks.

Report readers, comment access and keyed previews share `readerVersionAllowed`: an unpinned
reader may read current or official; a fixed share may read only its snapshot. Keyed previews
recheck this range on every request. Members with history permission retain history access.

Share PATCH reloads the row inside the permission transaction before merging omitted fields.
Responses include `revision`; clients should send it as `expectedRevision`. A stale revision
returns HTTP 409 with `code: "share_revision_conflict"` and the current `revision`, without
writes. A revoked share instead returns HTTP 409 with `code: "share_revoked"`; it cannot be
revived. Refresh and review settings before retrying a conflict. If supplied, `expectedRevision` must be a nonnegative
integer; `null` is invalid (HTTP 400), not an instruction to bypass conflict detection. The UI refreshes settings for review. Legacy clients may omit
it; omitted fields still merge against the current row, but conflicting explicit edits remain
last-writer-wins. Grant changes and revocation also invalidate the revision.

Migration 0005 requires PostgreSQL 15 or newer for the column-specific
[`ON DELETE SET NULL` action](https://www.postgresql.org/docs/15/sql-createtable.html).
CI and the default local integration setup use PostgreSQL 18.

Migrations 0004–0005 add share revisions and tenant/same-report version foreign keys. PostgreSQL
constraints start `NOT VALID`: new writes are checked, historical records are preserved rather
than silently transferred or deleted. Operators can locate historical violations with:

```sql
SELECT s.id FROM sites s LEFT JOIN tenants t ON t.id=s.tenant_id WHERE t.id IS NULL;
SELECT s.id FROM sites s LEFT JOIN versions v ON v.id=s.official_version_id AND v.site_id=s.id
WHERE s.official_version_id IS NOT NULL AND v.id IS NULL;
SELECT s.id FROM site_shares s LEFT JOIN versions v ON v.id=s.version_id AND v.site_id=s.site_id
WHERE s.version_id IS NOT NULL AND v.id IS NULL;
```

After resolving any historical violations according to their actual ownership, validate with
`ALTER TABLE sites VALIDATE CONSTRAINT sites_tenant_fk`,
`ALTER TABLE sites VALIDATE CONSTRAINT official_site_version_fk`, and
`ALTER TABLE site_shares VALIDATE CONSTRAINT shares_site_version_fk`.
Recoverable share-link storage remains the explicit exception documented in SECURITY.md;
this change does not rotate credentials or invalidate existing links.
