# Sharing and delivery

### Tenant and role context

Authenticated publication defaults to the `init` tenant; anonymous works belong to `anonymous`.
Use `X-Artifact-Tenant: <id>` to select another tenant where the account is an active member. This
header also applies when starting a chunked upload. Signing in does not claim existing anonymous
works; claiming is explicit from My works and uses the account’s default publishing tenant.

Permanent work editors may publish new versions, but cannot rename, roll back, manage sharing or
manage members. Work administrators may manage sharing and editor memberships; ownership transfer,
work deletion and site-administrator appointments remain owner/administrative operations.

Share creation also accepts `mode: "view" | "comment" | "edit"` (default `view`). All links follow latest; a non-null `versionId` is rejected. `comment` grants access to that share's discussion and permits signed-in users to comment;
anonymous commenting is not supported. Discussions remain isolated by share link and version.
When using link-granted access through an API or MCP, supply **that exact link token** as
`X-Artifact-Share: <token>`. Editable links require a signed-in account and grant no member-management
rights. Membership and sharing are independent: revoking one does not revoke the other.

### Ordinary sharing uses the main address

Return `$BASE/s/<slug>` and its current visibility after creation. Keep it private unless the user asks to open access. To share with anyone holding the link:

```bash
curl -sS -H "authorization: Bearer $TOKEN" \
  -X PUT "$BASE/api/sites/<slug>/sharing" \
  -H 'content-type: application/json' -d '{"visibility":"unlisted"}'
```

The address and main discussion stay unchanged. To inspect access, GET the same endpoint. Copying the address does not change access. `public` additionally enables public discovery; it is not ordinary link sharing.

### Advanced independent links

Only when requested, POST `/api/sites/<slug>/shares` with an explicit `policy` (`public`, `login`, `people`, or `passcode`), optional `mode` (`view`, `comment`, `edit`) and expiry/version settings. This creates a `/v/<token>` entrance with its own isolated discussion. It does not change the main address's visibility. List existing links through GET `/api/sites/<slug>/shares`; DELETE `/api/sites/<slug>/shares/<shareId>` revokes one. Creating a replacement does not revoke the old link.

Use `artifact_site_share` for advanced creation and `artifact_site_revoke_share` for explicit revocation. CLI equivalents are `share` and `revoke-share`. If all external sharing must stop, make the main link private and revoke independent links. Named memberships remain separate authorizations.

`/api/preview/` serves sandboxed work resources internally. Never present it as a user-facing share URL. Presentation mode uses `/s/<slug>?presentation=1` or the corresponding `/v/<token>?presentation=1` and retains access checks.

## Delivering to the user

For account-authenticated publication, deliver:

1. **The main work link** (`/s/<slug>`) and its actual access state. Say **private** when only authorized people can open it. Creation alone does not authorize sharing.
2. The `slug`, for later changes.

When asked to share normally, explicitly set `unlisted`, then return the same main link. When asked to publish to Explore/search, explicitly set `public`. Create an advanced independent `/v/<token>` link only for an explicit independent audience, expiry, password or isolated discussion request, and label its isolation clearly.

The work belongs to the authenticated user's account; no management credential needs to be pasted into chat.

For anonymous publication, also provide the credential file location (for example `ah-cookies.txt`) and explain that losing both the creating session and saved management token requires administrator recovery. Never paste `editToken` into the conversation or a reader URL.

## Official versions

A work can designate one immutable snapshot as official. The normal report URL still opens
the latest version. Setting a different official version replaces only the designation;
no snapshot is edited or deleted, and editing creates a new latest version without moving
the official designation. Owners and work administrators can manage the designation.

- Upload: JSON `official: true` or multipart `official=true` on `POST /api/sites` or
  `POST /api/sites/<slug>/versions`. For chunked uploads, pass it to the commit endpoint.
- Inspect: `GET /api/sites/<slug>/official` returns accessible versions and the revision.
- Set: `PUT /api/sites/<slug>/official` with `{ "versionId": "ver_…", "expectedRevision": 0 }`.
- Clear: `DELETE /api/sites/<slug>/official` with optional `{ "expectedRevision": 1 }`.
- A stale revision returns 409. Refresh and resolve the conflict; do not blindly retry.
- CLI: `publish <path> --official`, `update <slug> <path> --expected-version <id> --official`,
  `official set <slug> <versionId>`, `official clear <slug>`.
- MCP: publish/update accept `official`; use `artifact_site_set_official` or
  `artifact_site_clear_official` for later changes.
- Read a selected version at `/s/<slug>?version=<id>`; API item, text and export endpoints
  also accept `version=<id>`. All access checks still apply. Share links follow the latest
  accessible publication; changing the official designation does not grant history access.
