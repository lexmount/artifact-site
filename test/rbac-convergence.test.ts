import { resolveRole } from "./fixtures/authorization-role";
import { restorePreCleanupSchema } from "./fixtures/pre-cleanup-schema";
import { putTenantAdmin, putUserSiteRole } from "@/lib/role-bindings";
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { closeDbForTests, createId, upsertUser, getSite, rbacQuery, updateSiteVisibility, setEditToken, createShare } from '@/lib/db';
import { createSite } from '@/lib/sites';
import { mintSession } from '@/lib/session';
import { resolveViewer } from '@/lib/authz';
import { authorizePreview } from '@/lib/preview-access';
import { hashToken, canReadSite } from '@/lib/share';
import { DELETE as disown } from '@/app/api/sites/[slug]/ownership/route';
import { POST as fork } from '@/app/api/sites/[slug]/fork/route';
import { POST as openUpload } from '@/app/api/uploads/route';
import { PUT as putFile } from '@/app/api/uploads/[versionId]/files/[...relpath]/route';
import { POST as commit } from '@/app/api/uploads/[versionId]/commit/route';
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'audit.test' }), cookies: async () => ({ get: () => undefined }) }));
const origin = 'https://audit.test';
const temporaryTenants: string[] = [];
afterAll(async () => {
  for (const tenant of temporaryTenants) {
    await rbacQuery('DELETE FROM sites WHERE tenant_id=$1',[tenant]);
    await rbacQuery('DELETE FROM tenant_members WHERE tenant_id=$1',[tenant]);
    await rbacQuery('DELETE FROM tenants WHERE id=$1',[tenant]);
  }
  await closeDbForTests();
});
afterEach(async () => { await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id='init'"); await closeDbForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function identity() { const user = await upsertUser({ authProvider: 'audit', providerSubject: createId('u'), email: createId('e') + '@example.com', emailVerified: true }); const { session, cookie } = await mintSession(new Request(origin), user.id); return { user, session, cookie: cookie.split(';')[0] }; }
function req(path: string, method = 'GET', cookie = '', body?: unknown) { return new Request(origin + path, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
it('disown must not reactivate old edit token', async () => {
    vi.stubEnv('ARTIFACT_ENFORCE_OWNERSHIP', 'off');
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>private</html>' }, { ownerId: owner.user.id });
    const tokenReq = new Request(origin, { headers: { 'x-edit-token': site.editToken } });
    expect(await resolveRole(resolveViewer(tokenReq), site)).toBe(null);
    expect((await disown(req('/api/sites/' + site.slug + '/ownership', 'DELETE', owner.cookie), ctx(site.slug))).status).toBe(410);
    const fresh = (await getSite(site.id))!;
    expect(fresh.ownerId).toBe(owner.user.id);
    expect(await resolveRole(resolveViewer(tokenReq), fresh)).toBe(null);
});
it('rotating anonymous edit token must invalidate private preview grant', async () => {
    vi.stubEnv('ARTIFACT_ENFORCE_OWNERSHIP', 'off');
    const { site } = await createSite({ mode: 'paste', html: '<html>private</html>' }, {});
    await updateSiteVisibility(site.id, 'private');
    const fresh = (await getSite(site.id))!;
    const access = await authorizePreview(new Request(origin, { headers: { 'x-edit-token': site.editToken } }), fresh, null);
    expect(access?.key).toBeTruthy();
    await setEditToken(site.id, 'rotated');
    expect(await authorizePreview(new Request(origin), (await getSite(site.id))!, access!.key)).toBeNull();
});
it('revoked editor must not keep uploading bytes', async () => {
    const owner = await identity(), editor = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>one</html>' }, { ownerId: owner.user.id });
    await putUserSiteRole(rbacQuery, site.id, editor.user.id, 'editor', null);
    const opened = await openUpload(req('/api/uploads', 'POST', editor.cookie, { slug: site.slug }));
    expect(opened.status).toBe(201);
    const { versionId } = await opened.json();
    expect((await putFile(new Request(origin + '/api/uploads/' + versionId + '/files/index.html', { method: 'PUT', headers: { origin, cookie: editor.cookie }, body: '<html>staged before revocation</html>' }), { params: Promise.resolve({ versionId, relpath: ['index.html'] }) })).status).toBe(200);
    await rbacQuery('DELETE FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2', [site.id, editor.user.id]);
    const put = await putFile(new Request(origin + '/api/uploads/' + versionId + '/files/index.html', { method: 'PUT', headers: { origin, cookie: editor.cookie }, body: '<html>two</html>' }), { params: Promise.resolve({ versionId, relpath: ['index.html'] }) });
    expect.soft(put.status).toBe(403);
    expect((await commit(req('/api/uploads/' + versionId + '/commit', 'POST', editor.cookie, {}), { params: Promise.resolve({ versionId }) })).status).toBe(403);
});
it('fork must respect login creation policy', async () => {
    const { site } = await createSite({ mode: 'paste', html: '<html>one</html>' }, {});
    await updateSiteVisibility(site.id, 'public');
    vi.stubEnv('ARTIFACT_CREATE_POLICY', 'login');
    expect((await fork(req('/api/sites/' + site.slug + '/fork', 'POST'), ctx(site.slug))).status).toBe(401);
});
it('share metadata must not expose a disabled tenant report', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html><head><title>SECRET TITLE</title><meta name="description" content="SECRET DESCRIPTION"></head></html>' }, { ownerId: owner.user.id });
    const token = createId('t');
    await createShare({ id: createId('s'), siteId: site.id, tokenHash: hashToken(token), policy: 'public', passcodeHash: null, label: null, createdBy: owner.user.id, createdAnonId: null, expiresAt: null, mode: 'view', versionId: null });
    await rbacQuery("UPDATE tenants SET disabled_at=1 WHERE id='init'");
    expect(await canReadSite(req('/'), (await getSite(site.id))!)).toBe(false);
    const { generateMetadata } = await import('@/app/v/[token]/page');
    const meta = await generateMetadata({ params: Promise.resolve({ token }) });
    expect(JSON.stringify(meta)).not.toContain('SECRET');
});
it('editor metadata must not expose private report title', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html><title>PRIVATE SECRET TITLE</title></html>' }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, 'private');
    const { generateMetadata } = await import('@/app/s/[slug]/edit/page');
    const meta = await generateMetadata(ctx(site.slug));
    expect(JSON.stringify(meta)).not.toContain('PRIVATE SECRET');
});
it('revocation during storage write must prevent publishing', async () => {
    const owner = await identity(), editor = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>one</html>' }, { ownerId: owner.user.id });
    await putUserSiteRole(rbacQuery, site.id, editor.user.id, 'editor', null);
    const { getStorage } = await import('@/lib/storage');
    const storage = getStorage();
    const write = storage.writeVersionFiles.bind(storage);
    vi.spyOn(storage, 'writeVersionFiles').mockImplementationOnce(async (...args) => { await rbacQuery('DELETE FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2', [site.id, editor.user.id]); return write(...args); });
    const { POST } = await import('@/app/api/sites/[slug]/edit/route');
    const response = await POST(req('/api/sites/' + site.slug + '/edit', 'POST', editor.cookie, { content: '<html>changed after revocation</html>' }), ctx(site.slug));
    expect.soft(response.status).toBe(403);
    expect((await getSite(site.id))!.currentVersionId).toBe(site.currentVersionId);
});
it('owner must be able to read takedown audit', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>one</html>' }, { ownerId: owner.user.id });
    await rbacQuery('UPDATE sites SET taken_down_at=1 WHERE id=$1', [site.id]);
    const { GET } = await import('@/app/api/sites/[slug]/admin-activity/route');
    expect((await GET(req('/api/sites/' + site.slug + '/admin-activity', 'GET', owner.cookie), ctx(site.slug))).status).toBe(200);
});
it('cookie-authenticated creation must reject opaque origin', async () => {
    const owner = await identity();
    const form = new FormData();
    form.set('mode', 'paste');
    form.set('html', '<html>forged creation</html>');
    const { POST } = await import('@/app/api/sites/route');
    const response = await POST(new Request(origin + '/api/sites', { method: 'POST', headers: { origin: 'null', cookie: owner.cookie }, body: form }));
    expect(response.status).toBe(401);
});
it('MCP ZIP commit must retain the tenant selected at upload start', async () => {
    const owner = await identity();
    const tenant = createId('tenant');
    temporaryTenants.push(tenant);
    await rbacQuery('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, 'Upload target']);
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant, owner.user.id]);
    const { insertPublishToken, getSiteBySlug } = await import('@/lib/db');
    const { createPublishTokenSecret, hashTokenSecret } = await import('@/lib/publish-token');
    const token = createPublishTokenSecret();
    await insertPublishToken({ id: hashTokenSecret(token), userId: owner.user.id, name: 'audit', createdAt: Date.now() });
    const headers = { origin, authorization: 'Bearer ' + token };
    const start = await openUpload(new Request(origin + '/api/uploads', { method: 'POST', headers: { ...headers, 'x-artifact-tenant': tenant, 'content-type': 'application/json' }, body: '{}' }));
    expect(start.status).toBe(201);
    const { versionId } = await start.json();
    const { zipSync } = await import('fflate');
    const data = zipSync({ 'index.html': new TextEncoder().encode('<html>zip</html>') });
    expect((await putFile(new Request(origin + '/api/uploads/' + versionId + '/files/site.zip', { method: 'PUT', headers, body: Buffer.from(data) }), { params: Promise.resolve({ versionId, relpath: ['site.zip'] }) })).status).toBe(200);
    const { commitUpload } = await import('@/lib/mcp/files');
    const result = await commitUpload(new Request(origin + '/mcp', { headers }), versionId);
    expect((await getSiteBySlug(result.slug))!.tenantId).toBe(tenant);
});
it('owned creation retires tokens while anonymous management remains available', async () => {
    const owner = await identity();
    const { POST } = await import('@/app/api/sites/route');
    const owned = await POST(req('/api/sites', 'POST', owner.cookie, { mode: 'paste', html: '<html>Owned</html>' }));
    expect(owned.status).toBe(200);
    const body = await owned.json();
    expect(body).not.toHaveProperty('editToken');
    expect(body).not.toHaveProperty('claimToken');
    const { getSiteBySlug } = await import('@/lib/db');
    expect((await getSiteBySlug(body.slug))!.ownerId).toBe(owner.user.id);
    const anonymous = await POST(req('/api/sites', 'POST', '', { mode: 'paste', html: '<html>Anonymous</html>' }));
    expect(anonymous.status).toBe(200);
    expect((await anonymous.json()).editToken).toHaveLength(24);
});
it('migration retires only owned credentials and preserves ownership, visibility and shares', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>Keep</html>' }, { ownerId: owner.user.id });
    const { site: anonymous } = await createSite({ mode: 'paste', html: '<html>Anonymous</html>' }, {});
    await updateSiteVisibility(site.id, 'unlisted');
    await restorePreCleanupSchema();
    await rbacQuery("UPDATE sites SET edit_token='historical',claim_token='receipt' WHERE id=$1", [site.id]);
    const share = await createShare({ id: createId('shr'), siteId: site.id, tokenHash: hashToken(createId('token')), policy: 'public', passcodeHash: null, label: null, createdBy: owner.user.id, createdAnonId: null, expiresAt: null });
    const before = (await getSite(site.id))!;
    const { rbacTransaction, getShare } = await import('@/lib/db');
    const { bootstrapAuthorization } = await import('@/lib/migrations/bootstrap-authorization');
    const { migrateNumbered } = await import('@/lib/migrations');
    await rbacQuery("CREATE TABLE rbac_migrations(id TEXT PRIMARY KEY)");
    await rbacQuery("INSERT INTO rbac_migrations(id) VALUES('initial')");
    const migrateRbac = async (q: typeof rbacQuery) => { await bootstrapAuthorization(q, process.env.ARTIFACT_DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite'); };
    await rbacQuery("DELETE FROM rbac_migrations WHERE id='retire-owned-edit-tokens'");
    await rbacTransaction(migrateRbac);
    await rbacTransaction(migrateRbac);
    await rbacTransaction(q => migrateNumbered(q, process.env.ARTIFACT_DB_DRIVER === "postgres" ? "postgres" : "sqlite"));
    expect(await getSite(site.id)).toEqual({ ...before, editToken: '' });
    expect((await getSite(anonymous.id))!.editToken).toBe(anonymous.editToken);
    expect((await getShare(share.id))!.revokedAt).toBeNull();
    expect((await getShare(share.id))!.policy).toBe('public');
});
it('anonymous receipt exchange enables SSR but cannot bypass cookie CSRF or claim ownership', async () => {
    const { site } = await createSite({ mode: 'paste', html: '<html>Anonymous</html>' }, {});
    await updateSiteVisibility(site.id, 'private');
    const { POST, GET } = await import('@/app/api/sites/[slug]/permissions/route');
    const exchange = await POST(new Request(origin + '/api/sites/' + site.slug + '/permissions', { method: 'POST', headers: { 'x-edit-token': site.editToken } }), ctx(site.slug));
    expect(exchange.status).toBe(200);
    expect((await exchange.json()).permissions.canRename).toBe(true);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0];
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await (await GET(req('/api/sites/' + site.slug + '/permissions', 'GET', cookie), ctx(site.slug))).json()).permissions.canEditContent).toBe(true);
    const { PATCH } = await import('@/app/api/sites/[slug]/route');
    expect((await PATCH(new Request(origin + '/api/sites/' + site.slug, { method: 'PATCH', headers: { cookie, origin: 'null' }, body: JSON.stringify({ title: 'forged' }) }), ctx(site.slug))).status).toBe(401);
    const account = await identity();
    const { POST: adopt } = await import('@/app/api/me/adopt/route');
    expect((await adopt(req('/api/me/adopt', 'POST', cookie + '; ' + account.cookie, { tenantId: 'init' }))).status).toBe(403);
    expect((await getSite(site.id))!.ownerId).toBeNull();
});
it('session revocation invalidates a derived private preview grant', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>Private</html>' }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, 'private');
    const fresh = (await getSite(site.id))!;
    const grant = await authorizePreview(req('/s/' + site.slug, 'GET', owner.cookie), fresh, null);
    expect(grant?.key).toBeTruthy();
    const { revokeSession } = await import('@/lib/db');
    await revokeSession(owner.session.id);
    expect(await authorizePreview(req('/api/preview/' + site.slug), fresh, grant!.key)).toBeNull();
});
it('rename rechecks ownership after parsing the request body', async () => {
    const owner = await identity(), other = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html>Original</html>' }, { ownerId: owner.user.id });
    const request = req('/api/sites/' + site.slug, 'PATCH', owner.cookie, { title: 'Unauthorized rename' });
    const parse = request.json.bind(request);
    vi.spyOn(request, 'json').mockImplementationOnce(async () => {
        await rbacQuery('UPDATE sites SET owner_id=$1 WHERE id=$2', [other.user.id, site.id]);
        return parse();
    });
    const { PATCH } = await import('@/app/api/sites/[slug]/route');
    expect((await PATCH(request, ctx(site.slug))).status).toBe(403);
    expect((await getSite(site.id))!.title).toBe(site.title);
});
it('view shares read fixed text but never expose source or fork permissions', async () => {
    const owner = await identity();
    const { site } = await createSite({ mode: 'paste', html: '<html><body>Original snapshot</body></html>' }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, 'private');
    const token = createId('share');
    await createShare({ id: createId('shr'), siteId: site.id, tokenHash: hashToken(token), policy: 'public', mode: 'view', versionId: site.currentVersionId, passcodeHash: null, label: null, createdBy: owner.user.id, createdAnonId: null, expiresAt: null });
    const { POST: edit } = await import('@/app/api/sites/[slug]/edit/route');
    expect((await edit(req('/api/sites/' + site.slug + '/edit', 'POST', owner.cookie, { content: '<html><body>New snapshot</body></html>' }), ctx(site.slug))).status).toBe(200);
    const { GET: text } = await import('@/app/api/sites/[slug]/text/route');
    const response = await text(req('/api/sites/' + site.slug + '/text?share=' + token), ctx(site.slug));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.versionId).toBe(site.currentVersionId);
    expect(body.text).toContain('Original snapshot');
    expect((await text(req('/api/sites/' + site.slug + '/text?share=' + token + '&file=index.html'), ctx(site.slug))).status).toBe(403);
    const { GET: source } = await import('@/app/api/sites/[slug]/route');
    expect((await source(req('/api/sites/' + site.slug + '?share=' + token), ctx(site.slug))).status).toBe(403);
    expect((await fork(req('/api/sites/' + site.slug + '/fork?share=' + token, 'POST'), ctx(site.slug))).status).toBe(404);
});

it('final rename revalidation does not duplicate the management audit', async () => {
 const owner = await identity(), manager = await identity();
 const {site} = await createSite({mode:'paste',html:'<html>Managed</html>'},{ownerId:owner.user.id});
 await putTenantAdmin(rbacQuery,"init",manager.user.id,true,null);
 const request = new Request(req('/api/sites/'+site.slug,'PATCH',manager.cookie,{title:'Renamed'}),{headers:{origin,cookie:manager.cookie,'content-type':'application/json','x-management-reason':'Requested correction'}});
 const {PATCH} = await import('@/app/api/sites/[slug]/route');
 expect((await PATCH(request,ctx(site.slug))).status).toBe(200);
 expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.management' AND target_id=$1",[site.id])).toHaveLength(1);
});

it('bounds anonymous cookies across many artifacts and keeps list permission reads cookie-free', async () => {
 const {anonymousEditCookie, anonymousEditToken} = await import('@/lib/anonymous-access');
 let cookie = '';
 for (let i = 0; i < 150; i++) {
   const response = anonymousEditCookie(req('/s/site-'+i,'GET',cookie),'site-'+i,'a'.repeat(64));
   expect(response.length).toBeLessThan(3200);
   cookie = response.split(';')[0];
 }
 expect(anonymousEditToken(req('/s/site-149','GET',cookie))).toBe('a'.repeat(64));
 expect(anonymousEditToken(req('/s/site-0','GET',cookie))).toBe('');
 expect(cookie.match(/ah_edit=/g)).toHaveLength(1);
 const {site} = await createSite({mode:'paste',html:'<html>Anonymous</html>'},{});
 const {GET} = await import('@/app/api/sites/[slug]/permissions/route');
 const response = await GET(new Request(origin+'/api/sites/'+site.slug+'/permissions',{headers:{'x-edit-token':site.editToken}}),ctx(site.slug));
 expect(response.status).toBe(200);
 expect(response.headers.get('set-cookie')).toBeNull();
});
it('allows an explicit anonymous token to fork without Origin even with ambient cookies', async () => {
 const {site} = await createSite({mode:'paste',html:'<html>Fork source</html>'},{});
 const {anonymousEditCookie} = await import('@/lib/anonymous-access');
 const cookie = anonymousEditCookie(new Request(origin),site.slug,site.editToken).split(';')[0] + '; __Host-ah_anon=existing-browser';
 const response = await fork(new Request(origin+'/api/sites/'+site.slug+'/fork',{method:'POST',headers:{cookie,'x-edit-token':site.editToken}}),ctx(site.slug));
 expect(response.status).toBe(200);
});
it('preserves rejected bearer diagnostics in the upload origin gate', async () => {
 const {isCrossSiteForTarget} = await import('@/lib/upload-csrf');
 const {TokenRejectedError} = await import('@/lib/auth');
 await expect(isCrossSiteForTarget(new Request(origin+'/api/uploads/x/files/index.html',{headers:{authorization:'Bearer ahp_revoked'}}),{})).rejects.toBeInstanceOf(TokenRejectedError);
 const account = await identity();
 expect(await isCrossSiteForTarget(new Request(origin+'/api/uploads/x',{headers:{cookie:account.cookie,origin:'null'}}),{})).toBe(true);
});
it('checks management uploads on every PUT without repeating the entry audit', async () => {
 const owner = await identity(), manager = await identity();
 const {site} = await createSite({mode:'paste',html:'<html>Managed upload</html>'},{ownerId:owner.user.id});
 await putTenantAdmin(rbacQuery,"init",manager.user.id,true,null);
 const headers = {origin,cookie:manager.cookie,'content-type':'application/json','x-management-reason':'Upload correction'};
 const opened = await openUpload(new Request(origin+'/api/uploads',{method:'POST',headers,body:JSON.stringify({slug:site.slug})}));
 expect(opened.status).toBe(201);
 const {versionId} = await opened.json();
 for(const file of ['index.html','two.html']) {
   expect((await putFile(new Request(origin+'/api/uploads/'+versionId+'/files/'+file,{method:'PUT',headers,body:'<html>chunk</html>'}),{params:Promise.resolve({versionId,relpath:[file]})})).status).toBe(200);
 }
 expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.management' AND target_id=$1",[site.id])).toHaveLength(1);
});
it('records management extracted-text access once', async () => {
 const owner = await identity(), manager = await identity();
 const {site} = await createSite({mode:'paste',html:'<html>Managed text</html>'},{ownerId:owner.user.id});
 await putTenantAdmin(rbacQuery,"init",manager.user.id,true,null);
 const {GET} = await import('@/app/api/sites/[slug]/text/route');
 expect((await GET(new Request(origin+'/api/sites/'+site.slug+'/text',{headers:{cookie:manager.cookie,'x-management-reason':'Read correction'}}),ctx(site.slug))).status).toBe(200);
 expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.read' AND target_id=$1",[site.id])).toHaveLength(1);
});
