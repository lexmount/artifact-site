# Tenants and artifact authorization

This is the first phase of artifact annotations: authorization and tenant boundaries are implemented;
comment storage, threads, anchors, notifications and comment UI are not implemented yet.
`src/lib/rbac.ts` defines the fixed permission catalog. No custom-role engine is introduced.

## Resources and identities

- Users are global identities. `users.tenant_id` is their default creation destination, not an access grant.
- `tenants` are resource boundaries. `tenant_members` grants permanent membership (`admin` or `member`).
- Every site has a `tenant_id` and at most one `owner_id`. Versions, files, shares and audit records
  are scoped through their site. A version from another site is never a valid version selector.
- `site_members` grants `admin` or `editor` to an existing member of the site's tenant.
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
| Site administrator | One site | All versions and editing | Rename, rollback, shares, audit | Editors only | No |
| Site editor | One site | All versions and editing | No | No | No |
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
The existing platform moderation console retains its audited administrative read path.

Removing tenant membership also removes the user's site membership rows in that tenant. It refuses
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
| `POST /api/sites/:slug/collaborators` | `{email, role: "admin" \| "editor"}`; owner required for either direction of an admin-role change |
| `DELETE /api/sites/:slug/collaborators?userId=…` | Remove member; owner required to remove a site admin |
| `POST/PATCH /api/sites/:slug/shares[/shareId]` | Existing policy fields plus `mode` and `versionId` |
| `GET /api/me/adopt` | This browser's claimable anonymous sites |
| `POST /api/me/adopt` | Explicit `{tenantId}`; browser cookie plus destination membership required |

Creation and chunk-upload APIs accept `X-Artifact-Tenant`. Omitted means the user's default tenant;
anonymous creation always uses `anonymous`. Chunk sessions retain the selected tenant and recheck it
on commit. MCP forwards explicit share and tenant headers to the same API gates.

Cookie-authenticated writes retain the same-origin CSRF checks. Agent credentials retain their existing
scope checks; knowing a tenant ID, site slug or version ID never creates authorization.

## Reserved comment permissions

The catalog reserves read, create, reply, edit/delete/resolve-own, moderate and aggregate actions.
Owners/site admins/tenant admins can moderate; no role may edit another author's message body.
Commenters and editors may read/reply and operate on their own messages. View-only visitors cannot
read comments. Moderation is separate from changing another author's text.

The next phase must authorize the exact discussion scope before applying these points:
`site + version + (main scope OR share ID)`. The main address supports its own discussion. Different
links on the same version never expose each other's threads. Aggregation is a management capability,
not a separately assignable cross-link access role. No comment route is enabled in this PR.

## Migration and rollout

1. Back up metadata before deployment. Run a coordinated rollout; do not mix old and new authorization
   code behind the same service while changing the role model.
2. The idempotent migration seeds `init` and `anonymous`. Existing accounts and owned sites move to
   `init`; unowned sites move to `anonymous`. New authenticated accounts join `init` once. Removing a
   member does not silently re-add them on their next login or process restart.
3. Legacy collaborator rows become **editors**, losing management rights. Legacy `edit_policy=login`
   no longer grants editing. Use explicit membership or editable links. Old share rows default to
   view-only/latest, preserving their admission policy.
4. Sign-in no longer claims artifacts. Explicit claim atomically changes tenant and owner while
   preserving the site, versions and shares, attributes anonymous versions and records the move.
   Legacy edit tokens cannot retain authority after a site has an account owner.
5. A platform administrator can appoint the first `init` administrator through the members API.
   No first-login race or automatically elevated account is introduced.

SQLite unit and Postgres integration tests cover the same RBAC contract, including concurrent last-admin
protection, cross-tenant rejection, site role boundaries, external editable links, revocation, fixed-version
resource credentials and explicit anonymous claim. Existing publication, preview and CLI tests remain required.

### Preview credential confidentiality

Preview grants use AES-256-GCM with a domain-separated HKDF key derived from the persisted preview secret. The payload is encrypted so uploaded JavaScript cannot read viewer or share identity from the resource URL. Concurrent first starts converge on one database key. No process-local key cache delays revocation; every credential mint/verification reads the shared key. Administration → Settings exposes generation time and a confirmed rotation action, never key material. Rotation uses a revision guard and records its audit entry in the same transaction; stale concurrent rotations return 409. Share links and login sessions are unchanged. Public current-version previews without a share use stable credential-free resource URLs. Visual editing of historical HTML intentionally uses the current resource tree, matching save semantics.

### Audit storage and retention

Production audit records live in PostgreSQL: `audit_log` records artifact mutations and their actors/version/request metadata, `admin_log` records platform management actions and administrative reads, and `rbac_audit` records tenant/permission management with tenant, actor, target, reason and timestamp. SQLite mirrors them for tests. These tables intentionally have no cascading site/user foreign keys; normal site deletion and file purging preserve the audit trail.

There is currently no audit TTL, scheduled audit deletion, or configurable retention setting. API result limits (for example the latest 200 tenant audit entries) limit display only. The one-hour collapse of repeated email-administrator reads is deduplication, not retention, and is currently fixed in code. Deleted-site file retention and the 30-minute preview credential lifetime do not apply to audit records. Direct previews record access at their entry gate, without an additional `site.preview` event.
