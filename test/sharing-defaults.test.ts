import { afterEach, expect, it, vi } from "vitest";
import {
  closeDbForTests,
  createId,
  getSite,
  rbacQuery,
  upsertUser,
} from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { createUserFolder, assignUserSite } from "@/lib/user-folders";
import { canReadSite } from "@/lib/share";
import {
  setSharingPreference,
  scopeChange,
  siteSharingChange,
  moveSharing,
  getSiteSharing,
} from "@/lib/sharing-defaults";
const origin = "https://sharing.test";
async function actor() {
  const user = await upsertUser({
    authProvider: "test",
    providerSubject: createId("user"),
    email: createId("mail") + "@test.example",
    emailVerified: true,
  });
  const { cookie } = await mintSession(new Request(origin), user.id);
  const request = new Request(origin + "/api/me/sharing", {
    method: "POST",
    headers: { origin, cookie: cookie.split(";")[0] },
  });
  return { user, request };
}
const tenantPolicy = { audience: "tenant" as const, comments: true };
const privatePolicy = { audience: "private" as const, comments: false };
afterEach(async () => {
  await closeDbForTests();
  vi.unstubAllEnvs();
});
it("snapshots per-tenant user defaults for new documents only", async () => {
  vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "private");
  const a = await actor(),
    b = await actor();
  const old = (
    await createSite({ mode: "paste", html: "old" }, { ownerId: a.user.id })
  ).site;
  await setSharingPreference(a.request, "init", tenantPolicy);
  const fresh = (
    await createSite({ mode: "paste", html: "new" }, { ownerId: a.user.id })
  ).site;
  expect(await canReadSite(b.request, (await getSite(fresh.id))!)).toBe(true);
  expect(await canReadSite(b.request, old)).toBe(false);
  await setSharingPreference(a.request, "init", privatePolicy);
  expect((await getSiteSharing(fresh)).policy).toEqual(tenantPolicy);
});
it("applies scopes, manual overrides, confirmed moves and current-default restoration", async () => {
  const a = await actor();
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  const folder = await createUserFolder(a.user.id, "Project");
  await assignUserSite(a.user.id, site.slug, folder.id);
  const input = { enabled: true, policy: tenantPolicy };
  const preview = await scopeChange(a.request, folder.id, input);
  await scopeChange(a.request, folder.id, {
    ...input,
    confirmation: preview.confirmation,
  });
  expect((await getSiteSharing(site)).source).toBe("folder");
  await siteSharingChange(a.request, site.id, {
    action: "custom",
    policy: privatePolicy,
  });
  const changed = await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: { audience: "login", comments: false },
  });
  await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: { audience: "login", comments: false },
    confirmation: changed.confirmation,
  });
  expect((await getSiteSharing(site)).policy).toEqual(privatePolicy);
  const out = await moveSharing(a.request, [site.slug], null);
  await moveSharing(a.request, [site.slug], null, out.confirmation);
  const back = await moveSharing(a.request, [site.slug], folder.id);
  await moveSharing(a.request, [site.slug], folder.id, back.confirmation);
  expect((await getSiteSharing(site)).source).toBe("folder");
  await setSharingPreference(a.request, "init", tenantPolicy);
  const stop = await scopeChange(a.request, folder.id, { enabled: false });
  await scopeChange(a.request, folder.id, {
    enabled: false,
    confirmation: stop.confirmation,
  });
  expect((await getSiteSharing(site)).policy).toEqual(tenantPolicy);
  expect((await getSiteSharing(site)).source).toBe("default");
});
it("does not give anonymous readers login access or cross-tenant readers tenant access", async () => {
  const a = await actor(),
    b = await actor();
  await rbacQuery("INSERT INTO tenants(id,name) VALUES('other','Other')");
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [b.user.id]);
  await rbacQuery(
    "INSERT INTO tenant_members(tenant_id,user_id) VALUES('other',$1)",
    [b.user.id],
  );
  await setSharingPreference(a.request, "init", tenantPolicy);
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  expect(await canReadSite(b.request, (await getSite(site.id))!)).toBe(false);
  await siteSharingChange(a.request, site.id, {
    action: "custom",
    policy: { audience: "login", comments: true },
  });
  expect(await canReadSite(b.request, (await getSite(site.id))!)).toBe(true);
  expect(
    await canReadSite(new Request(origin), (await getSite(site.id))!),
  ).toBe(false);
});

it("gives folder rules priority over all-sites rules and excludes other people's documents", async () => {
  const a = await actor(),
    b = await actor();
  const folder = await createUserFolder(a.user.id, "Mixed");
  const owned = (
    await createSite({ mode: "paste", html: "owned" }, { ownerId: a.user.id })
  ).site;
  const other = (
    await createSite({ mode: "paste", html: "other" }, { ownerId: b.user.id })
  ).site;
  await (
    await import("@/lib/role-bindings")
  ).putUserSiteRole(rbacQuery, other.id, a.user.id, "editor", b.user.id);
  await assignUserSite(a.user.id, owned.slug, folder.id);
  await assignUserSite(a.user.id, other.slug, folder.id);
  let preview = await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: tenantPolicy,
  });
  expect(preview.excluded).toBe(1);
  await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: tenantPolicy,
    confirmation: preview.confirmation,
  });
  preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: { audience: "login", comments: false },
  });
  expect(preview.items).toHaveLength(0);
  await scopeChange(a.request, null, {
    enabled: true,
    policy: { audience: "login", comments: false },
    confirmation: preview.confirmation,
  });
  expect((await getSiteSharing(owned)).policy).toEqual(tenantPolicy);
  const fresh = (
    await createSite({ mode: "paste", html: "new" }, { ownerId: a.user.id })
  ).site;
  expect((await getSiteSharing(fresh)).source).toBe("all");
  preview = await scopeChange(a.request, folder.id, { enabled: false });
  await scopeChange(a.request, folder.id, {
    enabled: false,
    confirmation: preview.confirmation,
  });
  expect((await getSiteSharing(owned)).source).toBe("all");
  expect((await getSiteSharing(other)).source).toBe("default");
});
it("rejects stale confirmations and unauthorized changes", async () => {
  const a = await actor(),
    b = await actor();
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  const preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: tenantPolicy,
  });
  await siteSharingChange(a.request, site.id, {
    action: "custom",
    policy: privatePolicy,
  });
  await expect(
    scopeChange(a.request, null, {
      enabled: true,
      policy: tenantPolicy,
      confirmation: preview.confirmation,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    siteSharingChange(b.request, site.id, {
      action: "custom",
      policy: tenantPolicy,
    }),
  ).rejects.toThrow();
  await expect(
    setSharingPreference(b.request, "init", tenantPolicy, true),
  ).rejects.toThrow();
  const cross = new Request(origin, {
    method: "POST",
    headers: {
      cookie: a.request.headers.get("cookie")!,
      origin: "https://evil.test",
    },
  });
  await expect(
    setSharingPreference(cross, "init", tenantPolicy),
  ).rejects.toThrow();
});
it("keeps independent links until explicit stop-all and does not expose hidden collection titles", async () => {
  const a = await actor(),
    b = await actor();
  const site = (
    await createSite(
      { mode: "paste", html: "Secret", title: "Secret title" },
      { ownerId: a.user.id },
    )
  ).site;
  const { POST } = await import("@/app/api/sites/[slug]/shares/route");
  const response = await POST(
    new Request(origin, {
      method: "POST",
      headers: a.request.headers,
      body: JSON.stringify({ policy: "public" }),
    }),
    { params: Promise.resolve({ slug: site.slug }) },
  );
  expect(response.status).toBe(201);
  const { token } = await response.json();
  const preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: privatePolicy,
  });
  await scopeChange(a.request, null, {
    enabled: true,
    policy: privatePolicy,
    confirmation: preview.confirmation,
  });
  const { getScope, sharingCollection } = await import(
    "@/lib/sharing-defaults"
  );
  const scope = await getScope(a.request, null);
  const collectionToken = scope.url!.split("/").pop()!;
  const collection = await sharingCollection(b.request, collectionToken);
  expect(collection.state).toBe("empty");
  expect(JSON.stringify(collection)).not.toContain("Secret title");
  const { resolveShareAccess } = await import("@/lib/share");
  expect((await resolveShareAccess(new Request(origin), token)).ok).toBe(true);
  await (
    await import("@/lib/role-bindings")
  ).putUserSiteRole(rbacQuery, site.id, b.user.id, "viewer", a.user.id);
  expect(await canReadSite(b.request, (await getSite(site.id))!)).toBe(true);
  await siteSharingChange(a.request, site.id, { action: "stop" });
  expect(await canReadSite(b.request, (await getSite(site.id))!)).toBe(false);
  expect((await resolveShareAccess(new Request(origin), token)).ok).toBe(false);
});

it("inherits tenant defaults, isolates per-tenant overrides, and restores inheritance", async () => {
  const a = await actor();
  const tenant = createId("tenant");
  await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Default test')",[tenant]);
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",[tenant,a.user.id]);
  const { putTenantAdmin } = await import("@/lib/role-bindings");
  // A tenant manager can set organization-wide defaults, an ordinary member cannot.
  await putTenantAdmin(rbacQuery, tenant, a.user.id, true, a.user.id);
  await setSharingPreference(a.request, tenant, tenantPolicy, true);
  const { getSharingPreference } = await import("@/lib/sharing-defaults");
  expect(await getSharingPreference(a.request, tenant)).toMatchObject({
    inherited: true,
    policy: tenantPolicy,
  });
  await setSharingPreference(a.request, tenant, privatePolicy);
  await rbacQuery("INSERT INTO tenants(id,name) VALUES('two','Two')");
  await rbacQuery(
    "INSERT INTO tenant_members(tenant_id,user_id) VALUES('two',$1)",
    [a.user.id],
  );
  expect((await getSharingPreference(a.request, "two")).inherited).toBe(true);
  expect((await getSharingPreference(a.request, tenant)).policy).toEqual(
    privatePolicy,
  );
  await setSharingPreference(a.request, tenant, null);
  expect((await getSharingPreference(a.request, tenant)).policy).toEqual(
    tenantPolicy,
  );
});
it("grants comments without editing, and retains read access when comments are paused", async () => {
  const a = await actor(),
    b = await actor();
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  await siteSharingChange(a.request, site.id, {
    action: "custom",
    policy: { audience: "login", comments: true },
  });
  const { resolveCommentAccess } = await import("@/lib/comments/access");
  const { describeCommentPermissions } = await import(
    "@/lib/comments/permissions"
  );
  const scope = {
    siteId: site.id,
    versionId: site.currentVersionId,
    entry: { kind: "main" as const },
  };
  expect(
    describeCommentPermissions(
      await resolveCommentAccess(b.request, site, scope),
    ),
  ).toMatchObject({ canRead: true, canCreate: true, canModerate: false });
  expect(
    (
      await (
        await import("@/lib/authz")
      ).describePermissions(b.request, (await getSite(site.id))!)
    ).canEditContent,
  ).toBe(false);
  await siteSharingChange(a.request, site.id, {
    action: "custom",
    policy: { audience: "login", comments: false },
  });
  expect(
    describeCommentPermissions(
      await resolveCommentAccess(b.request, site, scope),
    ),
  ).toMatchObject({ canRead: true, canCreate: false });
});
it("blocks unconfirmed legacy filing/import and restores on folder deletion", async () => {
  const a = await actor();
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  const folder = await createUserFolder(a.user.id, "Shared");
  let preview = await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: tenantPolicy,
  });
  await scopeChange(a.request, folder.id, {
    enabled: true,
    policy: tenantPolicy,
    confirmation: preview.confirmation,
  });
  await expect(
    assignUserSite(a.user.id, site.slug, folder.id),
  ).rejects.toMatchObject({ statusCode: 409 });
  const { importFolderState } = await import("@/lib/user-folders");
  const result = await importFolderState(a.user.id, {
    folders: [{ id: "local", name: "Shared", createdAt: 1 }],
    assign: { [site.slug]: "local" },
  });
  expect(result.report.sitesSkipped).toBe(1);
  expect(result.state.assign[site.slug]).toBeUndefined();
  preview = await moveSharing(a.request, [site.slug], folder.id);
  await moveSharing(a.request, [site.slug], folder.id, preview.confirmation);
  await setSharingPreference(a.request, "init", {
    audience: "login",
    comments: false,
  });
  preview = await scopeChange(a.request, folder.id, {
    enabled: false,
    deleteFolder: true,
  });
  await scopeChange(a.request, folder.id, {
    enabled: false,
    deleteFolder: true,
    confirmation: preview.confirmation,
  });
  expect((await getSiteSharing(site)).policy).toEqual({
    audience: "login",
    comments: false,
  });
  expect(
    await rbacQuery("SELECT * FROM folder_assignments WHERE site_id=$1", [
      site.id,
    ]),
  ).toHaveLength(0);
});

it("does not reuse stopped collection links and rejects a batch after authority changes", async () => {
  const a = await actor();
  const site = (
    await createSite({ mode: "paste", html: "doc" }, { ownerId: a.user.id })
  ).site;
  const { getScope, sharingCollection } = await import(
    "@/lib/sharing-defaults"
  );
  let preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: tenantPolicy,
  });
  await scopeChange(a.request, null, {
    enabled: true,
    policy: tenantPolicy,
    confirmation: preview.confirmation,
  });
  const original = (await getScope(a.request, null)).url!;
  preview = await scopeChange(a.request, null, { enabled: false });
  await scopeChange(a.request, null, {
    enabled: false,
    confirmation: preview.confirmation,
  });
  preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: tenantPolicy,
  });
  await scopeChange(a.request, null, {
    enabled: true,
    policy: tenantPolicy,
    confirmation: preview.confirmation,
  });
  expect((await getScope(a.request, null)).url).not.toBe(original);
  expect(
    (await sharingCollection(a.request, original.split("/").pop()!)).state,
  ).toBe("unavailable");
  preview = await scopeChange(a.request, null, {
    enabled: true,
    policy: privatePolicy,
  });
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [a.user.id]);
  await expect(
    scopeChange(a.request, null, {
      enabled: true,
      policy: privatePolicy,
      confirmation: preview.confirmation,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await getSiteSharing(site)).policy).toEqual(tenantPolicy);
});

it.each(['default', 'all'] as const)('keeps account-owned private forks closed under permissive %s sharing', async (mode) => {
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY', 'private');
  const a = await actor();
  const source = (await createSite({mode:'paste',html:'private source'},{ownerId:a.user.id})).site;
  if (mode === 'default') await setSharingPreference(a.request,'init',{audience:'anyone',comments:true});
  else {
    const input = {enabled:true,policy:{audience:'anyone' as const,comments:true}};
    const preview = await scopeChange(a.request,null,input);
    await scopeChange(a.request,null,{...input,confirmation:preview.confirmation});
    await siteSharingChange(a.request,source.id,{action:'custom',policy:privatePolicy});
  }
  const { POST } = await import('@/app/api/sites/[slug]/fork/route');
  const response = await POST(new Request(origin,{method:'POST',headers:a.request.headers}),{params:Promise.resolve({slug:source.slug})});
  expect(response.status).toBe(200);
  const copy = (await (await import('@/lib/db')).getSiteBySlug((await response.json()).slug))!;
  expect(copy.visibility).toBe('private');
  expect(await canReadSite(new Request(origin),copy)).toBe(false);
  expect((await getSiteSharing(copy)).source).toBe('manual');
});

it.each(['anyone', 'private'] as const)('preserves requested official designation with %s default sharing', async (audience) => {
  const a = await actor();
  await setSharingPreference(a.request,'init',{audience,comments:true});
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY','unlisted');
  const ctx = (await import('@/lib/audit')).apiAuditContext(a.request,{kind:'user',userId:a.user.id,anonId:null});
  const result = await createSite({mode:'paste',html:'<h1>Official</h1>',official:true},{ownerId:a.user.id},ctx);
  expect((await getSite(result.site.id))!.officialVersionId).toBe(result.version.id);
});

it.each(['taken_down_at','deleted_at','tenant','membership'] as const)('revokes unavailable %s followers across stop, re-enable and folder deletion', async (blocked) => {
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY','private');
  for (const deleteFolder of [false,true]) for (const audience of ['login','anyone','public'] as const) {
    const a = await actor(), b = await actor();
    const site = (await createSite({mode:'paste',html:'blocked follower'},{ownerId:a.user.id})).site;
    const folder = await createUserFolder(a.user.id,'Shared');
    await assignUserSite(a.user.id,site.slug,folder.id);
    const input = {enabled:true,policy:{audience,comments:true}};
    let preview = await scopeChange(a.request,folder.id,input);
    await scopeChange(a.request,folder.id,{...input,confirmation:preview.confirmation});
    if(blocked==='tenant') await rbacQuery('UPDATE tenants SET disabled_at=1 WHERE id=$1',[site.tenantId]);
    else if(blocked==='membership') await rbacQuery('DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2',[site.tenantId,a.user.id]);
    else await rbacQuery(`UPDATE sites SET ${blocked}=1 WHERE id=$1`,[site.id]);
    preview=await scopeChange(a.request,folder.id,{enabled:false,deleteFolder});
    await scopeChange(a.request,folder.id,{enabled:false,deleteFolder,confirmation:preview.confirmation});
    // Re-enabling a rule must not revive a grant skipped while the artifact was unavailable.
    if(!deleteFolder){preview=await scopeChange(a.request,folder.id,input);await scopeChange(a.request,folder.id,{...input,confirmation:preview.confirmation});}
    if(blocked==='tenant') await rbacQuery('UPDATE tenants SET disabled_at=NULL WHERE id=$1',[site.tenantId]);
    else if(blocked==='membership') await rbacQuery('INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)',[site.tenantId,a.user.id]);
    else await rbacQuery(`UPDATE sites SET ${blocked}=NULL WHERE id=$1`,[site.id]);
    const fresh=(await getSite(site.id))!;
    expect(await canReadSite(b.request,fresh)).toBe(false);
    expect(await canReadSite(new Request(origin),fresh)).toBe(false);
    const facts=await (await import('@/lib/comments/access')).resolveCommentAccess(b.request,fresh,{siteId:site.id,versionId:site.currentVersionId,entry:{kind:'main'}});
    expect(facts.canReadMainArtifact).toBe(false);
    const directory=await (await import('@/lib/directory')).readDirectory({}, {scope:'public',folder:'all',q:'',sort:'updated',page:0});
    expect(JSON.stringify(directory)).not.toContain(site.slug);
    // Invalidation withdraws only this scope's grant, not the inaccessible document's settings.
    const [stored]=await rbacQuery('SELECT audience,source_id FROM site_sharing_state WHERE site_id=$1',[site.id]);
    expect(stored.audience).toBe(audience);
    expect(stored.source_id).toBeNull();
    expect((await getSiteSharing(fresh)).policy.audience).toBe('private');
    expect(await (await import('@/lib/preview-access')).authorizePreview(new Request(origin),fresh,null)).toBeNull();
    // Separate direct grants remain effective; scope invalidation is not stop-all.
    await (await import('@/lib/role-bindings')).putUserSiteRole(rbacQuery,site.id,b.user.id,'viewer',a.user.id);
    expect(await canReadSite(b.request,fresh)).toBe(true);
    await siteSharingChange(a.request,site.id,{action:'follow'});
    expect((await getSiteSharing((await getSite(site.id))!)).source).toBe(deleteFolder?'default':'folder');
  }
});

async function revokedPublicScope(audience: 'tenant' | 'login' | 'anyone' | 'public') {
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY', 'private');
  const owner = await actor();
  const site = (await createSite({ mode: 'paste', html: '<h1>Revoked scope</h1>' }, { ownerId: owner.user.id })).site;
  const input = { enabled: true, policy: { audience, comments: true } };
  let preview = await scopeChange(owner.request, null, input);
  await scopeChange(owner.request, null, { ...input, confirmation: preview.confirmation });
  await rbacQuery('UPDATE sites SET taken_down_at=1 WHERE id=$1', [site.id]);
  preview = await scopeChange(owner.request, null, { enabled: false });
  await scopeChange(owner.request, null, { enabled: false, confirmation: preview.confirmation });
  await rbacQuery('UPDATE sites SET taken_down_at=NULL WHERE id=$1', [site.id]);
  expect(await canReadSite(new Request(origin), (await getSite(site.id))!)).toBe(false);
  return { owner, site };
}
function jsonRequest(request: Request, body: unknown, method: string) {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  return new Request(request.url, { method, headers, body: JSON.stringify(body) });
}
it.each(['anyone', 'public'] as const)('does not reopen a revoked %s scope through the legacy comment-settings route', async (audience) => {
  const { owner, site } = await revokedPublicScope(audience);
  const { PATCH } = await import('@/app/api/sites/[slug]/comment-settings/route');
  const response = await PATCH(jsonRequest(owner.request, { mainPolicy: 'off' }, 'PATCH'), { params: Promise.resolve({ slug: site.slug }) });
  expect(response.status).toBe(200);
  const fresh = (await getSite(site.id))!;
  expect((await getSiteSharing(fresh)).policy.audience).toBe('private');
  expect(fresh.visibility).toBe('private');
  expect(await canReadSite(new Request(origin), fresh)).toBe(false);
});
it.each(['anyone', 'public'] as const)('does not reopen a revoked %s scope on ownership transfer', async (audience) => {
  const { owner, site } = await revokedPublicScope(audience);
  const recipient = await actor();
  const { POST } = await import('@/app/api/sites/[slug]/ownership/route');
  const response = await POST(jsonRequest(owner.request, { email: recipient.user.email }, 'POST'), { params: Promise.resolve({ slug: site.slug }) });
  expect(response.status).toBe(200);
  const fresh = (await getSite(site.id))!;
  expect(fresh.ownerId).toBe(recipient.user.id);
  expect(fresh.visibility).toBe('private');
  expect(await canReadSite(new Request(origin), fresh)).toBe(false);
});
it.each(['tenant', 'login'] as const)('serves real cookie-free resources to a %s reader and revokes the issued key', async (audience) => {
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY', 'private');
  const owner = await actor(), reader = await actor();
  if (audience === 'login') {
    const tenant = createId('tenant');
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Other')", [tenant]);
    await rbacQuery('DELETE FROM tenant_members WHERE user_id=$1', [reader.user.id]);
    await rbacQuery('INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)', [tenant, reader.user.id]);
  }
  const files = {
    'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="image.svg"><script src="app.js"></script><a href="doc.pdf">PDF</a></body></html>',
    'style.css': 'body { color: rgb(12, 34, 56); }',
    'app.js': 'document.body.dataset.resourceLoaded = "yes";',
    'image.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
    'doc.pdf': '%PDF-1.4\n% resource fixture\n%%EOF',
  };
  const site = (await createSite({ mode: 'folder', files: Object.entries(files).map(([relpath, content]) => ({ relpath, bytes: new TextEncoder().encode(content) })) }, { ownerId: owner.user.id })).site;
  const input = { enabled: true, policy: { audience, comments: true } };
  let preview = await scopeChange(owner.request, null, input);
  await scopeChange(owner.request, null, { ...input, confirmation: preview.confirmation });
  expect(await (await import('@/lib/rbac-access')).accountSiteRole((await getSite(site.id))!, { userId: reader.user.id })).toBeNull();
  const { GET } = await import('@/app/api/preview/[slug]/[[...path]]/route');
  const entry = await GET(new Request(origin + '/api/preview/' + site.slug + '/', { headers: reader.request.headers }), { params: Promise.resolve({ slug: site.slug }) });
  expect(entry.status).toBe(200);
  const html = await entry.text();
  const segment = html.match(/\/api\/preview\/([^/"<>]+~v3\.[^/"<>]+)\//)?.[1];
  expect(segment).toBeTruthy();
  async function resource(file: string) {
    return GET(new Request(origin + '/api/preview/' + segment + '/' + file), { params: Promise.resolve({ slug: segment!, path: [file] }) });
  }
  for (const file of ['style.css', 'app.js', 'image.svg', 'doc.pdf'] as const) {
    const response = await resource(file);
    expect(response.status, file).toBe(200);
    expect(await response.text(), file).toBe(files[file]);
  }
  // Keys recheck live account, tenant, session and version restrictions on every request.
  for (const [table, column, id] of [
    ['users', 'disabled_at', reader.user.id],
    ['tenants', 'disabled_at', site.tenantId],
    ['sites', 'taken_down_at', site.id],
  ]) {
    await rbacQuery(`UPDATE ${table} SET ${column}=1 WHERE id=$1`, [id]);
    expect([404, 410]).toContain((await resource('style.css')).status);
    await rbacQuery(`UPDATE ${table} SET ${column}=NULL WHERE id=$1`, [id]);
    expect((await resource('style.css')).status).toBe(200);
  }
  const session = await (await import('@/lib/session')).resolveSession(reader.request);
  await rbacQuery('UPDATE sessions SET revoked_at=1 WHERE id=$1', [session!.id]);
  expect((await resource('style.css')).status).toBe(404);
  await rbacQuery('UPDATE sessions SET revoked_at=NULL WHERE id=$1', [session!.id]);
  if (audience === 'tenant') {
    await rbacQuery('DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2', [site.tenantId, reader.user.id]);
    expect((await resource('style.css')).status).toBe(404);
    await rbacQuery('INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)', [site.tenantId, reader.user.id]);
  }
  expect((await resource('style.css')).status).toBe(200);
  const { insertVersion } = await import('@/lib/db');
  const newer = createId('ver');
  await insertVersion({ id: newer, siteId: site.id, entry: 'index.html', fileCount: 1, byteSize: 1, source: 'upload' });
  await rbacQuery('UPDATE sites SET current_version_id=$1 WHERE id=$2', [newer, site.id]);
  expect((await resource('style.css')).status).toBe(404);
  // An explicitly official version is still within the ordinary reader's range.
  await rbacQuery('UPDATE sites SET official_version_id=$1 WHERE id=$2', [site.currentVersionId, site.id]);
  expect((await resource('style.css')).status).toBe(200);
  preview = await scopeChange(owner.request, null, { enabled: false });
  await scopeChange(owner.request, null, { enabled: false, confirmation: preview.confirmation });
  expect((await resource('style.css')).status).toBe(404);
});

it.each([
  { audience: 'anyone', deployment: 'unlisted', preference: false },
  { audience: 'anyone', deployment: 'public', preference: false },
  { audience: 'public', deployment: 'unlisted', preference: false },
  { audience: 'public', deployment: 'public', preference: false },
  { audience: 'anyone', deployment: 'public', preference: true },
  { audience: 'public', deployment: 'public', preference: true },
] as const)('keeps revoked $audience forks private under $deployment defaults (configured=$preference)', async ({ audience, deployment, preference }) => {
  const { owner, site } = await revokedPublicScope(audience);
  const { editSite } = await import('@/lib/sites');
  const { testAudit } = await import('./helpers');
  await editSite(site.slug, { content: 'Private content after revocation' }, { ...testAudit(), authorizationRequest: owner.request });
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY', deployment);
  if (preference) await setSharingPreference(owner.request, 'init', { audience: 'public', comments: true });
  const { POST } = await import('@/app/api/sites/[slug]/fork/route');
  const response = await POST(jsonRequest(owner.request, {}, 'POST'), { params: Promise.resolve({ slug: site.slug }) });
  expect(response.status).toBe(200);
  const copy = (await (await import('@/lib/db')).getSiteBySlug((await response.json()).slug))!;
  expect(copy.visibility).toBe('private');
  expect(await canReadSite(new Request(origin), copy)).toBe(false);
  expect(await (await import('./helpers')).readVersionFile(copy.id, copy.currentVersionId, 'index.html')).toBe('Private content after revocation');
});

it('rechecks the fork privacy ceiling at the final creation transaction', async () => {
  vi.stubEnv('ARTIFACT_DEFAULT_VISIBILITY', 'public');
  const owner = await actor();
  const site = (await createSite({ mode: 'paste', html: 'Source' }, { ownerId: owner.user.id })).site;
  const input = { enabled: true, policy: { audience: 'public' as const, comments: true } };
  let preview = await scopeChange(owner.request, null, input);
  await scopeChange(owner.request, null, { ...input, confirmation: preview.confirmation });
  const db = await import('@/lib/db');
  const insert = db.insertSiteWithVersion;
  const hook = vi.spyOn(db, 'insertSiteWithVersion').mockImplementationOnce(async (...args) => {
    expect(args[0].visibility).toBe('public');
    await rbacQuery('UPDATE sites SET taken_down_at=1 WHERE id=$1', [site.id]);
    preview = await scopeChange(owner.request, null, { enabled: false });
    await scopeChange(owner.request, null, { enabled: false, confirmation: preview.confirmation });
    await rbacQuery('UPDATE sites SET taken_down_at=NULL WHERE id=$1', [site.id]);
    return insert(...args);
  });
  try {
    const { POST } = await import('@/app/api/sites/[slug]/fork/route');
    const response = await POST(jsonRequest(owner.request, {}, 'POST'), { params: Promise.resolve({ slug: site.slug }) });
    expect(response.status).toBe(200);
    const copy = (await db.getSiteBySlug((await response.json()).slug))!;
    expect(hook).toHaveBeenCalledOnce();
    expect(copy.visibility).toBe('private');
    expect(await canReadSite(new Request(origin), copy)).toBe(false);
  } finally { hook.mockRestore(); }
});

it('returns the actual default publishing tenant rather than the first membership', async () => {
  const owner = await actor();
  const tenantId = createId('tenant');
  await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'ZZ default')", [tenantId]);
  await rbacQuery('INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)', [tenantId, owner.user.id]);
  await rbacQuery('UPDATE users SET tenant_id=$1 WHERE id=$2', [tenantId, owner.user.id]);
  const { GET } = await import('@/app/api/me/sharing/preferences/route');
  let response = await GET(new Request(origin + '/api/me/sharing/preferences', { headers: owner.request.headers }));
  let result = await response.json();
  expect(result.defaultTenant).toEqual({ id: tenantId, name: 'ZZ default', disabledAt: null });
  expect(result.tenants).toHaveLength(2);
  await rbacQuery('UPDATE tenants SET disabled_at=1 WHERE id=$1', [tenantId]);
  response = await GET(new Request(origin + '/api/me/sharing/preferences', { headers: owner.request.headers }));
  result = await response.json();
  expect(result.defaultTenant).toEqual({ id: tenantId, name: 'ZZ default', disabledAt: 1 });
});

it("publishes shared defaults immediately without private review schema", async () => {
  const owner = await actor();
  const policy = { audience: "anyone" as const, comments: true };
  await setSharingPreference(owner.request, "init", policy);
  const context = (await import("@/lib/audit")).apiAuditContext(owner.request, { kind: "user", userId: owner.user.id, anonId: null });
  const { site, version } = await createSite({ mode: "paste", html: "Immediate publication", official: true }, { ownerId: owner.user.id }, context);
  const fresh = (await getSite(site.id))!;
  expect(fresh.officialVersionId).toBe(version.id);
  expect(await getSiteSharing(fresh)).toMatchObject({ policy, pending: false });
  expect(await canReadSite(new Request(origin), fresh)).toBe(true);
  const migrations = await rbacQuery("SELECT id FROM schema_migrations ORDER BY id");
  expect(migrations.map(row => row.id)).toContain("0017-tenant-slugs");
  expect(migrations.map(row => row.id)).toContain("0018-sharing-defaults");
  expect(migrations).toHaveLength(16);
  expect(migrations.some(row => /0015|0016|0019/.test(String(row.id)))).toBe(false);
  const tables = process.env.ARTIFACT_DB_DRIVER === "postgres"
    ? await rbacQuery("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()")
    : await rbacQuery("SELECT name FROM sqlite_master WHERE type='table'");
  expect(tables.filter(row => /^(content_reviews|exposure_requests|moderation_jobs|moderation_notifications)$/.test(String(row.name)))).toEqual([]);
});

it.each(["default", "manual"] as const)("revokes immediate independent links on a private %s document", async source => {
  const owner = await actor();
  const { site } = await createSite({ mode: "paste", html: "Private document" }, { ownerId: owner.user.id });
  if (source === "manual") await siteSharingChange(owner.request, site.id, { action: "custom", policy: privatePolicy });
  const context = { params: Promise.resolve({ slug: site.slug }) };
  const { GET, PUT } = await import("@/app/api/sites/[slug]/main-sharing/route");
  const { POST } = await import("@/app/api/sites/[slug]/shares/route");
  const response = await POST(jsonRequest(owner.request, { policy: "public" }, "POST"), context);
  expect(response.status).toBe(201);
  const { token } = await response.json();
  expect(await (await GET(owner.request, context)).json()).toMatchObject({ source, pending: false, links: 1, canStop: true });
  expect((await PUT(jsonRequest(owner.request, { action: "stop" }, "PUT"), context)).status).toBe(200);
  expect(await (await GET(owner.request, context)).json()).toMatchObject({ pending: false, links: 0 });
  expect((await (await import("@/lib/share")).resolveShareAccess(new Request(origin), token)).ok).toBe(false);
});
