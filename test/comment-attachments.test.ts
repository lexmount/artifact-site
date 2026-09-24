import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests, createId, createShare, rbacQuery, revokeShare, upsertUser } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { hashToken } from "@/lib/share";
import { getStorage } from "@/lib/storage";
import { uploadCommentAttachment, readCommentAttachment, discardCommentAttachment, sweepCommentAttachments, normalizeCommentImage, COMMENT_ATTACHMENT_TTL_MS } from "@/lib/comments/attachments";
import { createComment, getCommentDetail, replyComment, mutateMessage, listComments } from "@/lib/comments/service";
import { getAgentContext } from "@/lib/comments/agent-context";
import { POST as uploadRoute } from "@/app/api/sites/[slug]/comments/attachments/route";
import { GET as imageRoute } from "@/app/api/sites/[slug]/comments/attachments/[id]/route";
import { createCommentSchema, replyCommentSchema, editCommentSchema, commentAttachmentSchema } from "@/lib/comments/contracts";
import { commentSearchBodySql, fingerprint } from "@/lib/comments/store";
import { listAgentComments } from "@/lib/comments/agent-list";
import { errorResponse } from "@/app/api/_util";
const origin="https://attachments.example";
afterEach(async()=>{vi.restoreAllMocks();await closeDbForTests();vi.unstubAllEnvs();});
async function identity() {
 const user=await upsertUser({authProvider:"attachments",providerSubject:createId("subject"),email:`${createId("mail")}@example.com`,emailVerified:true});
 const {cookie}=await mintSession(new Request(origin),user.id);return {user,cookie:cookie.split(";")[0]};
}
function req(cookie="",token?:string,method="POST") {return new Request(`${origin}/api/comments`,{method,headers:{cookie,origin,...(token?{"x-artifact-share":token}:{})}});}
async function fixture() {
 const owner=await identity(),reader=await identity();
 const {site}=await createSite({mode:"paste",html:"<html><body>Image comments</body></html>"},{ownerId:owner.user.id});
 const scope={siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main" as const}};
 const input={scope,anchor:{kind:"document" as const,schemaVersion:1 as const,filePath:"index.html"},clientRequestId:randomUUID(),body:"hello"};
 const bytes=await sharp({create:{width:3,height:2,channels:3,background:"red"}}).png().toBuffer();
 const file=new File([new Uint8Array(bytes)],"test.png",{type:"image/png"});
 return {site,owner,reader,scope,input,file};
}
describe("private comment image attachments",()=>{
 it("bounds multipart uploads, requires login before parsing, and serves only protected raster bytes",async()=>{
  const {site,owner,scope,file}=await fixture();
  const form=new FormData();form.set("scope",JSON.stringify(scope));form.set("file",file);
  const upload=new Request(`${origin}/api/sites/${site.slug}/comments/attachments`,{method:"POST",headers:{origin,cookie:owner.cookie},body:form});
  const response=await uploadRoute(upload,{params:Promise.resolve({slug:site.slug})});expect(response.status).toBe(201);
  const image=await response.json();
  const read=await imageRoute(req(owner.cookie,undefined,"GET"),{params:Promise.resolve({slug:site.slug,id:image.id})});
  expect(read.status).toBe(200);expect(read.headers.get("cache-control")).toBe("private, no-store");expect(read.headers.get("content-type")).toBe("image/png");expect(read.headers.get("x-content-type-options")).toBe("nosniff");
  const invalid=new Request(origin,{method:"POST",headers:{origin,cookie:owner.cookie,"content-type":"multipart/form-data; boundary=x","content-length":String(6*1024*1024)},body:"x"});
  expect((await uploadRoute(invalid,{params:Promise.resolve({slug:site.slug})})).status).toBe(413);
  const malformed=new Request(origin,{method:"POST",headers:{origin,cookie:owner.cookie,"content-type":"multipart/form-data; boundary=broken"},body:"malformed"});
  expect((await uploadRoute(malformed,{params:Promise.resolve({slug:site.slug})})).status).toBe(400);
  const wrongScope=new FormData();wrongScope.set("scope","{");wrongScope.set("file",file);
  expect((await uploadRoute(new Request(origin,{method:"POST",headers:{origin,cookie:owner.cookie},body:wrongScope}),{params:Promise.resolve({slug:site.slug})})).status).toBe(400);
  const unauth=new Request(origin,{method:"POST",headers:{origin},body:"malformed"});
  expect((await uploadRoute(unauth,{params:Promise.resolve({slug:site.slug})})).status).toBe(401);
 });
 it("replays pre-upgrade create and reply fingerprints after restoring plain empty-image drafts",async()=>{
  const {site,owner,input}=await fixture();
  const legacy=createCommentSchema.parse(input);
  const created=await createComment(req(owner.cookie),site.slug,legacy);
  const root=created.detail.messages.items[0];
  const digest=await fingerprint(rbacQuery,{type:"create",...legacy});
  await rbacQuery("UPDATE comment_messages SET rich_content=NULL,request_fingerprint=$2 WHERE id=$1",[root.id,digest]);
  const restored=createCommentSchema.parse({...legacy,bodyFormat:"plain",attachmentIds:[]});
  const replay=await createComment(req(owner.cookie),site.slug,restored);
  expect(replay.replayed).toBe(true);expect(replay.detail.thread.id).toBe(created.detail.thread.id);
  for(const changed of [{body:"changed"},{bodyFormat:"lightweight" as const},{attachmentIds:["cat_added"]},{anchor:{kind:"document" as const,schemaVersion:1 as const,filePath:"other.html"}}]) await expect(createComment(req(owner.cookie),site.slug,{...restored,...changed})).rejects.toMatchObject({statusCode:409});
  const oldReply=replyCommentSchema.parse({clientRequestId:randomUUID(),body:"legacy reply"});
  const reply=await replyComment(req(owner.cookie),site.slug,created.detail.thread.id,oldReply);
  await rbacQuery("UPDATE comment_messages SET rich_content=NULL,request_fingerprint=$2 WHERE id=$1",[reply.id,await fingerprint(rbacQuery,{type:"reply",threadId:created.detail.thread.id,...oldReply})]);
  const retry=replyCommentSchema.parse({...oldReply,bodyFormat:"plain",attachmentIds:[]});
  expect((await replyComment(req(owner.cookie),site.slug,created.detail.thread.id,retry)).id).toBe(reply.id);
  for(const changed of [{body:"changed"},{bodyFormat:"lightweight" as const},{attachmentIds:["cat_added"]}]) await expect(replyComment(req(owner.cookie),site.slug,created.detail.thread.id,{...retry,...changed})).rejects.toMatchObject({statusCode:409});
  expect((await rbacQuery("SELECT id FROM comment_messages WHERE thread_id=$1",[created.detail.thread.id]))).toHaveLength(2);
 });
 it("validates empty edits against retained images without changing rejected revisions",async()=>{
  const {site,owner,scope,input,file}=await fixture();
  const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  const created=await createComment(req(owner.cookie),site.slug,{...input,attachmentIds:[image.id]});
  const id=created.detail.messages.items[0].id, thread=created.detail.thread.id;
  const edit=editCommentSchema.parse({expectedRevision:1,body:""});
  const result=await mutateMessage(req(owner.cookie),site.slug,thread,id,edit,"edit");
  expect(result.content).toEqual({state:"visible",body:""});expect(result.attachments).toEqual([image]);
  await mutateMessage(req(owner.cookie),site.slug,thread,id,editCommentSchema.parse({expectedRevision:2,body:""}),"edit");
  expect(editCommentSchema.safeParse({expectedRevision:3,body:"",attachmentIds:[]}).success).toBe(false);
  await expect(mutateMessage(req(owner.cookie),site.slug,thread,id,{expectedRevision:3,body:"",attachmentIds:[]},"edit")).rejects.toMatchObject({statusCode:400});
  const retained=await getCommentDetail(req(owner.cookie),site.slug,thread);expect(retained.messages.items[0].revision).toBe(3);expect(retained.messages.items[0].attachments).toEqual([image]);
  const text=await replyComment(req(owner.cookie),site.slug,thread,{clientRequestId:randomUUID(),body:"text"});
  await expect(mutateMessage(req(owner.cookie),site.slug,thread,text.id,editCommentSchema.parse({expectedRevision:1,body:""}),"edit")).rejects.toMatchObject({statusCode:400});
  expect((await getCommentDetail(req(owner.cookie),site.slug,thread)).messages.items.find(m=>m.id===text.id)).toMatchObject({revision:1,content:{body:"text"}});
 });
 it("validates attachment response metadata before it can enter drafts",()=>{
  const valid={id:"cat_image",name:"image.png",mimeType:"image/png",byteSize:128,width:3,height:2};
  expect(commentAttachmentSchema.parse(valid)).toEqual(valid);
  for(const value of [{}, {...valid,width:0}, {...valid,id:"../image"}, {...valid,mimeType:"text/html"}, {...valid,token:"secret"}]) expect(commentAttachmentSchema.safeParse(value).success).toBe(false);
 });
 it("serializes the pending limit and rejects downloads before storage when the read budget is exhausted",async()=>{
  const {site,owner,scope,file}=await fixture();
  const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  for(let i=0;i<38;i++) await rbacQuery("INSERT INTO comment_attachments(id,site_id,version_id,owner_id,name,mime_type,byte_size,width,height,created_at) VALUES($1,$2,$3,$4,'pending.png','image/png',10,1,1,$5)",[createId("cat"),site.id,scope.versionId,owner.user.id,Date.now()]);
  const results=await Promise.allSettled([uploadCommentAttachment(req(owner.cookie),site.slug,scope,file),uploadCommentAttachment(req(owner.cookie),site.slug,scope,file)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{statusCode:429}});
  expect(Number((await rbacQuery("SELECT COUNT(*) AS count FROM comment_attachments WHERE owner_id=$1 AND deleted_at IS NULL",[owner.user.id]))[0].count)).toBe(40);
  const {checkRateLimit,__resetRateLimitForTests}=await import("@/lib/ratelimit");
  vi.stubEnv("ARTIFACT_RATE_LIMIT","on");__resetRateLimitForTests();
  for(let i=0;i<240;i++) checkRateLimit(req(owner.cookie),Date.now()+10000,`comment-image-read:user:${owner.user.id}`,240,120);
  const storage=vi.spyOn(getStorage(),"readCommentAttachment");
  const response=await imageRoute(req(owner.cookie,undefined,"GET"),{params:Promise.resolve({slug:site.slug,id:image.id})});
  expect(response.status).toBe(429);expect(storage).not.toHaveBeenCalled();__resetRateLimitForTests();
 });
 it("retains cleanup reservations when storage fails and authorizes again after the byte write",async()=>{
  const {site,owner,reader,scope,file}=await fixture();
  const failWrite=vi.spyOn(getStorage(),"writeCommentAttachment").mockRejectedValueOnce(new Error("offline"));
  await expect(uploadCommentAttachment(req(owner.cookie),site.slug,scope,file)).rejects.toThrow("offline");failWrite.mockRestore();
  expect((await rbacQuery("SELECT id FROM comment_attachments WHERE site_id=$1 AND deleted_at IS NOT NULL",[site.id])).length).toBe(1);
  await sweepCommentAttachments();
  expect((await rbacQuery("SELECT id FROM comment_attachments WHERE site_id=$1",[site.id])).length).toBe(0);
  const token=createId("token"), shareId=createId("shr");
  await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(token),createdBy:owner.user.id,mode:"comment",policy:"public",passcodeHash:null,label:null,createdAnonId:null,expiresAt:null,versionId:null});
  const actualWrite=getStorage().writeCommentAttachment.bind(getStorage());
  const revoke=vi.spyOn(getStorage(),"writeCommentAttachment").mockImplementationOnce(async(id,bytes,mime)=>{await actualWrite(id,bytes,mime);await revokeShare(shareId);});
  await expect(uploadCommentAttachment(req(reader.cookie,token),site.slug,{...scope,entry:{kind:"share",shareId}},file)).rejects.toMatchObject({statusCode:403});revoke.mockRestore();
  await sweepCommentAttachments();expect((await rbacQuery("SELECT id FROM comment_attachments WHERE site_id=$1",[site.id])).length).toBe(0);
 });
 it("serializes competing attachment claims and rejects stale attachment edits",async()=>{
  const {site,owner,scope,input,file}=await fixture();const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  const results=await Promise.allSettled([createComment(req(owner.cookie),site.slug,{...input,attachmentIds:[image.id]}),createComment(req(owner.cookie),site.slug,{...input,clientRequestId:randomUUID(),attachmentIds:[image.id]})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const result=results.find(r=>r.status==="fulfilled");if (!result || result.status!=="fulfilled") throw new Error("no winner");
  const thread=result.value.detail, message=thread.messages.items[0];
  await mutateMessage(req(owner.cookie),site.slug,thread.thread.id,message.id,{expectedRevision:1,body:"kept",attachmentIds:[image.id]},"edit");
  await expect(mutateMessage(req(owner.cookie),site.slug,thread.thread.id,message.id,{expectedRevision:1,body:"stale",attachmentIds:[]},"edit")).rejects.toMatchObject({statusCode:409});
  expect((await getCommentDetail(req(owner.cookie),site.slug,thread.thread.id)).messages.items[0].attachments).toEqual([image]);
 });

 it("keeps photo JPEG encoding compact, strips metadata, and reports stable invalid-image codes",async()=>{
  const pixels=randomBytes(2000*2000*3);
  const jpeg=await sharp(pixels,{raw:{width:2000,height:2000,channels:3}}).jpeg({quality:65}).withMetadata({orientation:6}).toBuffer();
  expect(jpeg.length).toBeLessThan(5*1024*1024);
  expect((await sharp(jpeg).png().toBuffer()).length).toBeGreaterThan(5*1024*1024);
  const image=await normalizeCommentImage(jpeg,"photo.jpeg");
  const metadata=await sharp(image.bytes).metadata();
  await expect(normalizeCommentImage(jpeg.subarray(0,100),"truncated.jpg")).rejects.toMatchObject({statusCode:400,code:"image_invalid"});
  expect(image.mimeType).toBe("image/jpeg");expect(image.name).toBe("photo.jpg");expect(image.bytes.length).toBeLessThan(5*1024*1024);expect(metadata.exif).toBeUndefined();
  const {site,owner,scope}=await fixture();
  const written=vi.spyOn(getStorage(),"writeCommentAttachment");
  const uploaded=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,new File([new Uint8Array(jpeg)],"photo.jpeg",{type:"image/jpeg"}));
  expect(written).toHaveBeenCalledWith(uploaded.id,expect.any(Uint8Array),"image/jpeg");
  const response=await imageRoute(req(owner.cookie,undefined,"GET"),{params:Promise.resolve({slug:site.slug,id:uploaded.id})});
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  try {await normalizeCommentImage(Buffer.from("broken"),"photo.jpg");throw new Error("expected reject");} catch(error) {expect(await errorResponse(error).json()).toMatchObject({code:"image_invalid"});}
 });
 it("keeps global cleanup off upload and discard request paths",async()=>{
  const {site,owner,scope,file}=await fixture();
  const old=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  await rbacQuery("UPDATE comment_attachments SET deleted_at=$2 WHERE id=$1",[old.id,Date.now()]);
  const storage=vi.spyOn(getStorage(),"removeCommentAttachment").mockRejectedValue(new Error("offline"));
  for(let i=0;i<40;i++) await rbacQuery("INSERT INTO comment_attachments(id,site_id,version_id,owner_id,name,mime_type,byte_size,width,height,created_at) VALUES($1,$2,$3,$4,'expired.png','image/png',10,1,1,$5)",[createId("cat"),site.id,scope.versionId,owner.user.id,Date.now()-COMMENT_ATTACHMENT_TTL_MS-1000]);
  const next=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  await discardCommentAttachment(req(owner.cookie),site.slug,next.id);
  const [tombstone]=await rbacQuery("SELECT deleted_at FROM comment_attachments WHERE id=$1",[next.id]);
  await expect(discardCommentAttachment(req(owner.cookie),site.slug,next.id)).rejects.toMatchObject({statusCode:404});
  expect((await rbacQuery("SELECT deleted_at FROM comment_attachments WHERE id=$1",[next.id]))[0].deleted_at).toBe(tombstone.deleted_at);
  expect(storage).not.toHaveBeenCalled();
  expect((await sweepCommentAttachments()).errors).toBeGreaterThanOrEqual(2);
 });
 it("reencodes pixels and rejects disguised vectors, malformed images, oversized pixels",async()=>{
  const {file}=await fixture();const image=await normalizeCommentImage(new Uint8Array(await file.arrayBuffer()),"../test.png");
  expect(image.width).toBe(3);expect(image.height).toBe(2);expect(image.name).not.toContain("/");
  await expect(normalizeCommentImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),"test.png")).rejects.toMatchObject({statusCode:400});
  await expect(normalizeCommentImage(Buffer.from("not an image"),"test.png")).rejects.toMatchObject({statusCode:400});
  const huge=await sharp({create:{width:8193,height:1,channels:3,background:"red"}}).png().toBuffer();
  await expect(normalizeCommentImage(huge,"huge.png")).rejects.toMatchObject({statusCode:400});
 });
 it("keeps draft images private; publishes image-only content, hydrates list/reply/Agent and clears on delete",async()=>{
  const {site,owner,reader,scope,input,file}=await fixture();
  const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  await expect(readCommentAttachment(req(reader.cookie,undefined,"GET"),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
  expect((await readCommentAttachment(req(owner.cookie,undefined,"GET"),site.slug,image.id)).bytes.length).toBe(image.byteSize);
  const payload=createCommentSchema.parse({...input,body:"",bodyFormat:"lightweight",attachmentIds:[image.id]});
  const created=await createComment(req(owner.cookie),site.slug,payload);
  expect(created.detail.messages.items[0].content).toEqual({state:"visible",body:"",format:"lightweight"});
  expect(created.detail.messages.items[0].attachments).toEqual([image]);
  const canonical=commentSearchBodySql("m");
  for(const term of ["image","attachment"]) expect(await rbacQuery(`SELECT m.id FROM comment_messages m WHERE m.id=$1 AND LOWER(${canonical}) LIKE $2`,[created.detail.messages.items[0].id,`%${term}%`])).toHaveLength(0);
  const agentList=await listAgentComments(req(owner.cookie),site.slug,{limit:20});
  expect(agentList.items.find(item=>item.threadId===created.detail.thread.id)).toMatchObject({summary:"Image attachment",attachmentCount:1});
  expect((await createComment(req(owner.cookie),site.slug,payload)).replayed).toBe(true);
  expect((await readCommentAttachment(req(reader.cookie,undefined,"GET"),site.slug,image.id)).bytes.length).toBe(image.byteSize);
  const list=await listComments(req(owner.cookie),site.slug,{kind:"space",scope});expect(list.items[0].messages.items[0].attachments).toEqual([image]);
  const agent=await getAgentContext(req(owner.cookie),site.slug,created.detail.thread.id);expect(agent.threads[0].messages.items[0].attachments).toEqual([image]);
  const replyImage=await uploadCommentAttachment(req(reader.cookie),site.slug,scope,file);
  const reply=await replyComment(req(reader.cookie),site.slug,created.detail.thread.id,{clientRequestId:randomUUID(),body:"`code`",bodyFormat:"lightweight",attachmentIds:[replyImage.id]});
  expect(reply.attachments).toEqual([replyImage]);
  await expect(mutateMessage(req(owner.cookie),site.slug,created.detail.thread.id,reply.id,{expectedRevision:1,body:"moderator edit",attachmentIds:[replyImage.id]},"edit")).rejects.toMatchObject({statusCode:403});
  const changed=await mutateMessage(req(reader.cookie),site.slug,created.detail.thread.id,reply.id,{expectedRevision:1,body:"updated",attachmentIds:[]},"edit");expect(changed.attachments).toEqual([]);
  await expect(readCommentAttachment(req(owner.cookie),site.slug,replyImage.id)).rejects.toMatchObject({statusCode:404});
  await mutateMessage(req(owner.cookie),site.slug,created.detail.thread.id,created.detail.messages.items[0].id,{expectedRevision:1},"delete");
  await expect(readCommentAttachment(req(owner.cookie),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
  expect((await getCommentDetail(req(owner.cookie),site.slug,created.detail.thread.id)).messages.items[0].attachments).toEqual([]);
 });
 it("rejects cross-author, cross-discussion and reused image claims atomically",async()=>{
  const {site,owner,reader,scope,input,file}=await fixture();
  const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  await expect(createComment(req(reader.cookie),site.slug,{...input,attachmentIds:[image.id]})).rejects.toMatchObject({statusCode:409});
  const token=createId("token"),shareId=createId("shr");await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(token),createdBy:owner.user.id,mode:"comment",policy:"public",passcodeHash:null,label:null,createdAnonId:null,expiresAt:null,versionId:null});
  const shareScope={...scope,entry:{kind:"share" as const,shareId}};
  await expect(createComment(req(owner.cookie),site.slug,{...input,scope:shareScope,attachmentIds:[image.id]})).rejects.toMatchObject({statusCode:409});
  const created=await createComment(req(owner.cookie),site.slug,{...input,attachmentIds:[image.id]});
  await expect(replyComment(req(owner.cookie),site.slug,created.detail.thread.id,{clientRequestId:randomUUID(),body:"reuse",attachmentIds:[image.id]})).rejects.toMatchObject({statusCode:409});
  await expect(discardCommentAttachment(req(owner.cookie),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
  expect((await rbacQuery("SELECT id FROM comment_threads WHERE space_id=$1",[created.detail.space.id])).length).toBe(1);
 });
 it("rechecks share permissions on download and excludes images from artifact version storage",async()=>{
  const {site,owner,reader,scope,input,file}=await fixture();const token=createId("token"),shareId=createId("shr");
  await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(token),createdBy:owner.user.id,mode:"comment",policy:"public",passcodeHash:null,label:null,createdAnonId:null,expiresAt:null,versionId:null});
  const shareScope={...scope,entry:{kind:"share" as const,shareId}};
  const image=await uploadCommentAttachment(req(owner.cookie),site.slug,shareScope,file);
  await createComment(req(owner.cookie),site.slug,{...input,scope:shareScope,attachmentIds:[image.id]});
  await expect(readCommentAttachment(req(reader.cookie),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
  expect((await readCommentAttachment(req(reader.cookie,token),site.slug,image.id)).attachment.id).toBe(image.id);
  await revokeShare(shareId);
  await expect(readCommentAttachment(req(reader.cookie,token),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
  expect(await getStorage().list(site.id,site.currentVersionId)).not.toContain(image.id);
 });
 it("expires abandoned uploads, retries failed removal, and preserves live images",async()=>{
  const {site,owner,scope,input,file}=await fixture();const old=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file), live=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
  await createComment(req(owner.cookie),site.slug,{...input,attachmentIds:[live.id]});
  await rbacQuery("UPDATE comment_attachments SET created_at=$2 WHERE id=$1",[old.id,Date.now()-COMMENT_ATTACHMENT_TTL_MS-1]);
  await expect(createComment(req(owner.cookie),site.slug,{...input,clientRequestId:randomUUID(),attachmentIds:[old.id]})).rejects.toMatchObject({statusCode:409});
  const spy=vi.spyOn(getStorage(),"removeCommentAttachment").mockRejectedValueOnce(new Error("storage offline"));
  expect((await sweepCommentAttachments()).errors).toBeGreaterThan(0);spy.mockRestore();
  await sweepCommentAttachments();expect((await rbacQuery("SELECT id FROM comment_attachments WHERE id=$1",[old.id])).length).toBe(0);
  expect((await readCommentAttachment(req(owner.cookie),site.slug,live.id)).attachment.id).toBe(live.id);
 });
});
it("combines rich attachments, search, participation, reactions and result associations without widening share access",async()=>{
 const {associateCommentResult,setCommentReaction}=await import("@/lib/comments/service");
 const {replaceSiteContent}=await import("@/lib/sites");
 const {testAudit}=await import("./helpers");
 const {site,owner,reader,scope,input,file}=await fixture();
 await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1",[site.id]);
 const tokens=[createId("token"),createId("token")];
 const shares=[];
 for(const token of tokens) shares.push(await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),createdBy:owner.user.id,mode:"comment",policy:"public",passcodeHash:null,label:null,createdAnonId:null,expiresAt:null,versionId:scope.versionId}));
 const a={...scope,entry:{kind:"share" as const,shareId:shares[0].id}},b={...scope,entry:{kind:"share" as const,shareId:shares[1].id}};
 const image=await uploadCommentAttachment(req(reader.cookie,tokens[0]),site.slug,a,file);
 const created=await createComment(req(reader.cookie,tokens[0]),site.slug,{...input,scope:a,body:"Searchable `layout` feedback",bodyFormat:"lightweight",attachmentIds:[image.id]});
 const id=created.detail.thread.id, message=created.detail.messages.items[0];
 await setCommentReaction(req(owner.cookie),site.slug,id,message.id,"👍",true);
 const result=await listComments(req(reader.cookie,tokens[0]),site.slug,{kind:"space",scope:a,q:"layout",participated:true});
 expect(result.items.map(x=>x.thread.id)).toEqual([id]);
 expect(result.items[0].messages.items[0]).toMatchObject({attachments:[image],content:{format:"lightweight"},reactions:[{emoji:"👍",count:1,reacted:false}]});
 expect((await listComments(req(reader.cookie,tokens[1]),site.slug,{kind:"space",scope:b,q:"layout"})).items).toEqual([]);
 await expect(readCommentAttachment(req(reader.cookie,tokens[1]),site.slug,image.id)).rejects.toMatchObject({statusCode:404});
 expect((await listComments(req(owner.cookie),site.slug,{kind:"aggregate",siteId:site.id,q:"layout"})).items).toHaveLength(1);
 const replacement=await replaceSiteContent(site.slug,{mode:"paste",html:"<h1>Revised layout</h1>"},testAudit());
 if(!replacement || "conflict" in replacement) throw Error("Version fixture failed");
 await associateCommentResult(req(owner.cookie),site.slug,id,{expectedRevision:1,versionId:replacement.site.currentVersionId});
 const visible=await getAgentContext(req(owner.cookie),site.slug,id);
 expect(visible.threads[0].messages.items[0].attachments).toEqual([image]);
 expect(visible.scope.versionId).toBe(scope.versionId);
 expect(visible.threads[0].thread.resultVersionId).toBe(replacement.site.currentVersionId);
 expect(visible.threads[0].thread.resolution.status).toBe("open");
 const hidden=await getCommentDetail(req(reader.cookie,tokens[0]),site.slug,id);
 expect(hidden.thread.resultVersionId).toBeNull();
 expect(hidden.messages.items[0].attachments).toEqual([image]);
});

it("does not search an implementation placeholder for an image-only comment",async()=>{
 const {site,owner,scope,input,file}=await fixture();
 const image=await uploadCommentAttachment(req(owner.cookie),site.slug,scope,file);
 await createComment(req(owner.cookie),site.slug,{...input,body:"",bodyFormat:"lightweight",attachmentIds:[image.id]});
 expect((await listComments(req(owner.cookie),site.slug,{kind:"space",scope,q:"attachment"})).items).toEqual([]);
});

it("downscales decoded images that exceed storage limits while retaining source safety",async()=>{
 const pixels=Buffer.alloc(1800*1800*3);let seed=1;
 for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;pixels[i]=seed>>>24;}
 const webp=await sharp(pixels,{raw:{width:1800,height:1800,channels:3}}).webp({quality:70}).toBuffer();
 expect(webp.length).toBeLessThan(5*1024*1024);
 const image=await normalizeCommentImage(webp,"photo.webp");
 expect(image.resized).toBe(true);expect(image.bytes.length).toBeLessThanOrEqual(5*1024*1024);
 expect(image.width).toBeLessThan(1800);expect(image.width).toBe(image.height);
 await expect(normalizeCommentImage(Buffer.alloc(5*1024*1024+1),"huge.jpg")).rejects.toMatchObject({statusCode:413});
});
