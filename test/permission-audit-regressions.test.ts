import { afterAll, expect, it, vi } from 'vitest';
import { createSite } from '@/lib/sites';
import { closeDbForTests, createId, upsertUser, getSite, rbacQuery, updateSiteSharing, createShare, getShare } from '@/lib/db';
import { mintSession } from '@/lib/session';
import { authorizePreview } from '@/lib/preview-access';
import { canReadVersion, hashToken } from '@/lib/share';
import { PATCH } from '@/app/api/sites/[slug]/shares/[shareId]/route';
const origin='https://audit.test';
afterAll(closeDbForTests);
async function fixture() {
 const user=await upsertUser({authProvider:'audit',providerSubject:createId('u'),email:createId('e')+'@test.com',emailVerified:true});
 const {cookie}=await mintSession(new Request(origin),user.id);
 const {site}=await createSite({mode:'paste',html:'<html><head></head><body>old secret</body></html>'},{ownerId:user.id});
 await updateSiteSharing(site.id,'private','owner');
 return {site:(await getSite(site.id))!,user,cookie:cookie.split(';')[0]};
}
async function advance(site: Awaited<ReturnType<typeof fixture>>['site']) {
 const id=createId('ver');
 await rbacQuery("INSERT INTO versions(id,site_id,entry,file_count,byte_size,source,created_at) VALUES($1,$2,'index.html',1,1,'upload',$3)",[id,site.id,Date.now()]);
 await rbacQuery('UPDATE sites SET current_version_id=$1 WHERE id=$2',[id,site.id]);
 return (await getSite(site.id))!;
}
it('follow-share preview must stop serving a version that is no longer latest or official',async()=>{
 const {site,user}=await fixture();const token=createId('link');
 await createShare({id:createId('shr'),siteId:site.id,tokenHash:hashToken(token),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 const req=new Request(origin,{headers:{'x-artifact-share':token}});
 const grant=await authorizePreview(req,site,null);expect(grant?.key).toBeTruthy();
 const fresh=await advance(site);
 expect(await canReadVersion(req,fresh,site.currentVersionId)).toBe(false);
 expect(await authorizePreview(new Request(origin),fresh,grant!.key)).toBeNull();
});
it('public official version preview grant must work for subresources',async()=>{
 const {site}=await fixture();await updateSiteSharing(site.id,'public','owner');
 await advance(site);await rbacQuery('UPDATE sites SET official_version_id=$1 WHERE id=$2',[site.currentVersionId,site.id]);
 const fresh=(await getSite(site.id))!;
 const grant=await authorizePreview(new Request(origin+'/?v='+site.currentVersionId),fresh,null);
 expect(grant?.key).toBeTruthy();
 expect(await authorizePreview(new Request(origin),fresh,grant!.key)).not.toBeNull();
});
it('a stale label-only share PATCH must not restore old public/edit permissions',async()=>{
 const {site,user,cookie}=await fixture();const id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'edit',versionId:null});
 const req=new Request(origin+'/api/sites/'+site.slug+'/shares/'+id,{method:'PATCH',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({label:'new label'})});
 // After handler loaded the old share, another administrator restricts it.
 req.json=async()=>{await rbacQuery("UPDATE site_shares SET policy='login',mode='view' WHERE id=$1",[id]);return {label:'new label'};};
 const res=await PATCH(req,{params:Promise.resolve({slug:site.slug,shareId:id})});expect(res.status).toBe(200);
 expect((await getShare(id))?.policy).toBe('login');expect((await getShare(id))?.mode).toBe('view');
});
it('fixed-share Agent context must not disclose the ungranted latest version',async()=>{
 const {site,user}=await fixture();
 const reader=await upsertUser({authProvider:'audit',providerSubject:createId('u'),email:createId('e')+'@test.com',emailVerified:true});
 const {cookie}=await mintSession(new Request(origin),reader.id);
 const shareId=createId('shr'),token=createId('link');
 await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(token),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'comment',versionId:site.currentVersionId});
 const req=new Request(origin,{headers:{origin,cookie:cookie.split(';')[0],'x-artifact-share':token}});
 const {createComment}=await import('@/lib/comments/service');
 const result=await createComment(req,site.slug,{scope:{siteId:site.id,versionId:site.currentVersionId,entry:{kind:'share',shareId}},anchor:{kind:'document',schemaVersion:1,filePath:'index.html'},body:'review',clientRequestId:crypto.randomUUID()});
 const fresh=await advance(site);
 const {getAgentContext}=await import('@/lib/comments/agent-context');
 const bundle=await getAgentContext(req,site.slug,result.detail.thread.id);
 expect(await canReadVersion(req,fresh,fresh.currentVersionId)).toBe(false);
 expect(JSON.stringify(bundle)).not.toContain(fresh.currentVersionId);
});
it('stale confirmed share settings return a conflict without widening access',async()=>{
 const {site,user,cookie}=await fixture();const id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'edit',versionId:null});
 const change=(body:unknown)=>PATCH(new Request(origin+'/api/sites/'+site.slug+'/shares/'+id,{method:'PATCH',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({slug:site.slug,shareId:id})});
 expect((await change({policy:'login',mode:'view',expectedRevision:0})).status).toBe(200);
 expect((await change({policy:'public',mode:'edit',label:'stale',expectedRevision:0})).status).toBe(409);
 expect((await getShare(id))?.policy).toBe('login');
});
it('database rejects tenant and version references outside the report',async()=>{
 const {site}=await fixture(),other=(await fixture()).site;
 await expect(rbacQuery('UPDATE sites SET tenant_id=$1 WHERE id=$2',['missing-tenant',site.id])).rejects.toThrow();
 await expect(rbacQuery('UPDATE sites SET official_version_id=$1 WHERE id=$2',[other.currentVersionId,site.id])).rejects.toThrow();
 await expect(createShare({id:createId('shr'),siteId:site.id,tokenHash:hashToken(createId('link')),policy:'public',passcodeHash:null,label:null,createdBy:null,createdAnonId:null,expiresAt:null,mode:'view',versionId:other.currentVersionId})).rejects.toThrow();
});
it('retired edit policies, collaborator rows and owned edit tokens cannot grant access',async()=>{
 const {site,user}=await fixture(), stranger=await fixture();
 await rbacQuery("UPDATE sites SET edit_policy='login',edit_token='retired-token',claim_token='retired-claim' WHERE id=$1",[site.id]);
 await rbacQuery('INSERT INTO site_collaborators(site_id,user_id,granted_by,granted_at) VALUES($1,$2,$3,1)',[site.id,stranger.user.id,user.id]);
 const {describePermissions}=await import('@/lib/authz');
 const request=new Request(origin,{headers:{cookie:stranger.cookie,'x-edit-token':'retired-token'}});
 const permissions=await describePermissions(request,(await getSite(site.id))!);
 expect(permissions.canEditContent).toBe(false);expect(permissions.canManageSharing).toBe(false);
});
it('read-only OAuth permissions never advertise write capabilities',async()=>{
 const {site,cookie}=await fixture();
 const {resolveSession}=await import('@/lib/session');
 const {describePermissions}=await import('@/lib/authz');
 const request=new Request(origin,{headers:{cookie}}),session=(await resolveSession(request))!;
 const permissions=await describePermissions(request,site,{...session,scopes:['artifacts:read']});
 expect(permissions.canEditContent).toBe(false);expect(permissions.canDelete).toBe(false);expect(permissions.canManageSharing).toBe(false);
 expect(permissions.canReadSource).toBe(true);
});

it('share grants and their revision roll back together', async () => {
 const {site,user}=await fixture(), id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 const {rbacTransaction,addShareGrant,listShareGrants}=await import('@/lib/db');
 await expect(rbacTransaction(async () => {
   await addShareGrant(id,{email:'rollback@example.com'},user.id);
   throw new Error('abort grant');
 })).rejects.toThrow('abort grant');
 expect(await listShareGrants(id)).toHaveLength(0);
 expect((await getShare(id))?.revision).toBe(0);
});

it('standalone grant mutations roll back when the revision write fails', async () => {
 const {site,user}=await fixture(), id=createId('shr');
 const {addShareGrant,removeShareGrant,listShareGrants}=await import('@/lib/db');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 await addShareGrant(id,{email:'keep@example.com'},user.id);
 const before=(await getShare(id))!.revision;
 const postgres=process.env.ARTIFACT_DB_DRIVER==='postgres';
 // Force the second half of the mutation to fail, after the grant write was attempted.
 if(postgres) await rbacQuery(`ALTER TABLE site_shares ADD CONSTRAINT test_revision_failure CHECK (id <> '${id}' OR revision=${before})`);
 else await rbacQuery(`CREATE TRIGGER test_revision_failure BEFORE UPDATE OF revision ON site_shares WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT, 'revision failure'); END`);
 try {
   await expect(addShareGrant(id,{email:'reject@example.com'},user.id)).rejects.toThrow();
   await expect(removeShareGrant(id,{email:'keep@example.com'})).rejects.toThrow();
   expect((await listShareGrants(id)).map(g=>g.email)).toEqual(['keep@example.com']);
   expect((await getShare(id))!.revision).toBe(before);
 } finally {
   await rbacQuery(postgres ? 'ALTER TABLE site_shares DROP CONSTRAINT test_revision_failure' : 'DROP TRIGGER test_revision_failure');
 }
});

it('PATCH returns the committed grant snapshot even if another edit follows immediately', async () => {
 const {site,user,cookie}=await fixture(), id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 const audit=await import('@/lib/audit');
 const {addShareGrant}=await import('@/lib/db');
 const spy=vi.spyOn(audit,'recordSiteAudit').mockImplementationOnce(async()=>{
   await addShareGrant(id,{email:'later@example.com'},user.id);
 });
 try {
   const response=await PATCH(new Request(origin+'/api/sites/'+site.slug+'/shares/'+id,{method:'PATCH',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({label:'snapshot',expectedRevision:0,grants:[{email:'snapshot@example.com'}]})}),{params:Promise.resolve({slug:site.slug,shareId:id})});
   expect(response.status).toBe(200);
   const body=await response.json();
   expect(body.share.revision).toBe(1);
   expect(body.share.grants.map((g: {email: string})=>g.email)).toEqual(['snapshot@example.com']);
   expect((await getShare(id))!.revision).toBe(2);
 } finally { spy.mockRestore(); }
});

it('relationship migration may be re-applied without duplicate constraints', async () => {
 const {up}=await import('@/lib/migrations/0005-rbac-constraints');
 const dialect=process.env.ARTIFACT_DB_DRIVER==='postgres'?'postgres':'sqlite';
 await fixture();
 await up(rbacQuery,dialect);
 await up(rbacQuery,dialect);
});

it('null expectedRevision is invalid and never bypasses conflict detection', async () => {
 const {site,user,cookie}=await fixture(), id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 const response=await PATCH(new Request(origin+'/api/sites/'+site.slug+'/shares/'+id,{method:'PATCH',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({policy:'public',expectedRevision:null})}),{params:Promise.resolve({slug:site.slug,shareId:id})});
 expect(response.status).toBe(400);
 expect((await getShare(id))!.policy).toBe('people');
 expect((await getShare(id))!.revision).toBe(0);
});

it('historical invalid relationships remain renameable and revocable after migration', async () => {
 const {site,user}=await fixture(), other=(await fixture()).site, third=(await fixture()).site;
 const {up}=await import('@/lib/migrations/0005-rbac-constraints');
 const dialect=process.env.ARTIFACT_DB_DRIVER==='postgres'?'postgres':'sqlite';
 const shareId=createId('shr');
 if(dialect==='postgres') {
   await rbacQuery('ALTER TABLE sites DROP CONSTRAINT sites_tenant_fk, DROP CONSTRAINT official_site_version_fk');
   await rbacQuery('ALTER TABLE site_shares DROP CONSTRAINT shares_site_version_fk');
 } else {
   for(const prefix of ['sites_tenant','official_version','shares_version']) for(const event of ['insert','update']) await rbacQuery(`DROP TRIGGER ${prefix}_${event}`);
 }
 try {
   await rbacQuery("UPDATE sites SET tenant_id='historical-missing',official_version_id=$1 WHERE id=$2",[other.currentVersionId,site.id]);
   await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:other.currentVersionId});
 } finally { await up(rbacQuery,dialect); }
 try {
   await rbacQuery("UPDATE sites SET title='Still editable',tenant_id=tenant_id,official_version_id=official_version_id WHERE id=$1",[site.id]);
   await rbacQuery('UPDATE sites SET current_version_id=$1 WHERE id=$2',[site.currentVersionId,site.id]);
   await rbacQuery('UPDATE site_shares SET revoked_at=$1,version_id=version_id WHERE id=$2',[Date.now(),shareId]);
   expect((await getSite(site.id))!.title).toBe('Still editable');
   expect((await getShare(shareId))!.revokedAt).not.toBeNull();
   await expect(rbacQuery("UPDATE sites SET tenant_id='another-missing' WHERE id=$1",[site.id])).rejects.toThrow();
   await expect(rbacQuery('UPDATE sites SET official_version_id=$1 WHERE id=$2',[third.currentVersionId,site.id])).rejects.toThrow();
   await expect(rbacQuery('UPDATE site_shares SET version_id=$1 WHERE id=$2',[third.currentVersionId,shareId])).rejects.toThrow();
 } finally {
   await rbacQuery('UPDATE sites SET tenant_id=$1,official_version_id=NULL WHERE id=$2',[site.tenantId,site.id]);
   await rbacQuery('UPDATE site_shares SET version_id=NULL WHERE id=$1',[shareId]);
 }
});

it('duplicate grants and absent removals do not advance the share revision', async () => {
 const {site,user}=await fixture(), id=createId('shr');
 const {addShareGrant,removeShareGrant}=await import('@/lib/db');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 for(const target of [{email:'same@example.com'},{userId:user.id}]) {
   await addShareGrant(id,target,user.id);
   const before=(await getShare(id))!.revision;
   await addShareGrant(id,target,user.id);
   expect((await getShare(id))!.revision).toBe(before);
   await removeShareGrant(id,target);
   const removed=(await getShare(id))!.revision;
   expect(removed).toBe(before!+1);
   await removeShareGrant(id,target);
   expect((await getShare(id))!.revision).toBe(removed);
 }
});

it('denials are readable and explicit OAuth scope failures keep their protocol payload', async () => {
 const {site,cookie}=await fixture();
 const {requirePermission}=await import('@/lib/authz');
 const {resolveSession}=await import('@/lib/session');
 const {errorResponse}=await import('@/app/api/_util');
 await expect(requirePermission(new Request(origin),site,'site.content.edit')).rejects.toThrow('Please sign in first');
 const session=(await resolveSession(new Request(origin,{headers:{cookie}})))!;
 let response: Response | undefined;
 try { await requirePermission(new Request(origin,{method:'POST'}),site,'site.content.edit',{...session,scopes:['artifacts:read']}); }
 catch(error) { response=errorResponse(error); }
 expect(response?.status).toBe(403);
 expect(await response!.json()).toMatchObject({code:'insufficient_scope',scope:'artifacts:write'});
});

it('share conflicts identify stale revisions separately from revocation, including races', async () => {
 const {site,user,cookie}=await fixture(), id=createId('shr');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'public',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 const request=()=>new Request(origin+'/api/sites/'+site.slug+'/shares/'+id,{method:'PATCH',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({label:'edit',expectedRevision:0})});
 const context={params:Promise.resolve({slug:site.slug,shareId:id})};
 const first=await PATCH(request(),context); expect((await first.json()).share.revision).toBe(1);
 const stale=await PATCH(request(),context);
 expect(stale.status).toBe(409);expect(await stale.json()).toMatchObject({code:'share_revision_conflict',revision:1});
 const raced=request();raced.json=async()=>{await rbacQuery('UPDATE site_shares SET revoked_at=1 WHERE id=$1',[id]);return {label:'race'};};
 for(const req of [raced,request()]) {
   const revoked=await PATCH(req,context);expect(revoked.status).toBe(409);
   expect(await revoked.json()).toMatchObject({code:'share_revoked'});
 }
 const {shareConflictCode}=await import('@/components/share-model');
 expect(shareConflictCode({code:'share_revoked'})).toBe('share_revoked');
 expect(shareConflictCode({code:'share_revision_conflict'})).toBe('share_revision_conflict');
 expect(shareConflictCode({error:'Other conflict'})).toBeNull();
});

it('DELETE grant returns its committed snapshot rather than a later guest list', async () => {
 const {site,user,cookie}=await fixture(), id=createId('shr');
 const {addShareGrant,listShareGrants}=await import('@/lib/db');
 await createShare({id,siteId:site.id,tokenHash:hashToken(createId('link')),policy:'people',passcodeHash:null,label:null,createdBy:user.id,createdAnonId:null,expiresAt:null,mode:'view',versionId:null});
 await addShareGrant(id,{email:'removed@example.com'},user.id);
 const audit=await import('@/lib/audit');
 const {DELETE}=await import('@/app/api/sites/[slug]/shares/[shareId]/grants/route');
 const spy=vi.spyOn(audit,'recordSiteAudit').mockImplementationOnce(async()=>{
   await addShareGrant(id,{email:'later@example.com'},user.id);
 });
 try {
   const response=await DELETE(new Request(origin+'/api/sites/'+site.slug+'/shares/'+id+'/grants?email=removed@example.com',{method:'DELETE',headers:{origin,cookie}}),{params:Promise.resolve({slug:site.slug,shareId:id})});
   expect(response.status).toBe(200);
   expect((await response.json()).grants).toEqual([]);
   expect((await listShareGrants(id)).map(g=>g.email)).toEqual(['later@example.com']);
 } finally { spy.mockRestore(); }
});

it('unsupported PostgreSQL versions fail clearly before relationship DDL', async () => {
 const {up}=await import('@/lib/migrations/0005-rbac-constraints');
 const query=vi.fn(async()=>[{server_version_num:'140000'}]);
 await expect(up(query,'postgres')).rejects.toThrow('PostgreSQL 15 or newer is required');
 expect(query).toHaveBeenCalledExactlyOnceWith('SHOW server_version_num');
});
