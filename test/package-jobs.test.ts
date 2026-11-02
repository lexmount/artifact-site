import { acknowledgeJobs, jobNotice, readJobReceipts } from "@/lib/package-job-notices";
import * as db from "@/lib/db";
import { createSite, replaceSiteContent } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { buildPasscodeCookie, hashPasscode, hashToken } from "@/lib/share";
import { getStorage } from "@/lib/storage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as start } from "@/app/api/uploads/route";
import { PUT } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { POST as commit } from "@/app/api/uploads/[versionId]/commit/route";
import { GET as status } from "@/app/api/uploads/[versionId]/route";
import { POST as retry } from "@/app/api/uploads/[versionId]/retry/route";
import { runNextPackageJob } from "@/lib/package-jobs";
import { rbacQuery } from "@/lib/db";
const origin = "http://localhost";
const headers = { authorization: "Bearer package-job-test", "content-type": "application/json" };
beforeEach(async () => { vi.stubEnv("PUBLISH_API_TOKEN", "package-job-test"); await rbacQuery("DELETE FROM package_jobs"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const opened = await start(new Request(origin + "/api/uploads", { method: "POST", headers, body: JSON.stringify({ title: "Async package", package: { source: "folder" } }) }));
  expect(opened.status).toBe(201);
  const { versionId } = await opened.json();
  const context = { params: Promise.resolve({ versionId }) };
  const uploaded = await PUT(new Request(origin + `/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers, body: "<h1>Async report</h1>" }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
  expect(uploaded.status).toBe(200);
  const submit = () => commit(new Request(origin + `/api/uploads/${versionId}/commit?async=1`, { method: "POST", headers, body: "{}" }), context);
  return { versionId, context, submit };
}
it("queues promptly, publishes atomically, and recovers the same result after session cleanup", async () => {
  const { versionId, context, submit } = await fixture();
  expect((await submit()).status).toBe(202);
  expect((await (await submit()).json()).status).toBe("queued");
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(0);
  expect(await runNextPackageJob()).toBe(true);
  const response = await status(new Request(origin, { headers }), context);
  const job = await response.json();
  expect(job).toMatchObject({ status: "completed", result: { versionId } });
  expect((await submit()).status).toBe(200);
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(1);
  expect(await rbacQuery("SELECT version_id FROM upload_sessions WHERE version_id=$1", [versionId])).toHaveLength(0);
  expect((await status(new Request(origin), context)).status).toBe(404);
});
it("reclaims a crashed worker claim and fences writes while queued", async () => {
  const { versionId, submit } = await fixture(); await submit();
  const write = await PUT(new Request(origin, { method: "PUT", headers, body: "changed" }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
  expect(write.status).toBe(409);
  await rbacQuery("UPDATE package_jobs SET state='processing',lease='dead-worker',lease_until=0 WHERE version_id=$1", [versionId]);
  await runNextPackageJob();
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1", [versionId]))[0].state).toBe("completed");
});
it("does not publish after operator credential rotation", async () => {
  const { versionId, submit } = await fixture(); await submit();
  vi.stubEnv("PUBLISH_API_TOKEN", "rotated");
  await runNextPackageJob();
  const [job] = await rbacQuery("SELECT state,retryable,payload FROM package_jobs WHERE version_id=$1", [versionId]);
  expect(job.state).toBe("failed"); expect(Number(job.retryable)).toBe(0);
  expect(String(job.payload)).not.toContain("package-job-test");
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(0);
});
it("only lets the owner retry a retryable failure without replacing the original session", async () => {
  const { versionId, context, submit } = await fixture(); await submit();
  await rbacQuery("UPDATE package_jobs SET state='failed',retryable=1,error='temporary' WHERE version_id=$1", [versionId]);
  expect((await retry(new Request(origin, { method: "POST" }), context)).status).toBe(404);
  expect((await retry(new Request(origin, { method: "POST", headers }), context)).status).toBe(202);
  await runNextPackageJob();
  expect((await (await status(new Request(origin, { headers }), context)).json()).status).toBe("completed");
});

it("retries transient storage failures without publishing a partial version", async () => {
  const { versionId, submit } = await fixture(); await submit();
  const failure = vi.spyOn(getStorage("package"), "sizeOf").mockRejectedValueOnce(new Error("COS connection reset"));
  await runNextPackageJob(); failure.mockRestore();
  expect((await rbacQuery("SELECT state,attempts FROM package_jobs WHERE version_id=$1", [versionId]))[0]).toMatchObject({ state: "queued", attempts: 1 });
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(0);
  await rbacQuery("UPDATE package_jobs SET available_at=0 WHERE version_id=$1", [versionId]);
  await runNextPackageJob();
  expect((await rbacQuery("SELECT state,attempts,retryable FROM package_jobs WHERE version_id=$1", [versionId]))[0]).toMatchObject({ state: "completed", attempts: 2, retryable: 0 });
});
it("only one concurrent worker publishes a queued version", async () => {
  const { versionId, submit } = await fixture(); await submit();
  await Promise.all([runNextPackageJob(), runNextPackageJob()]);
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(1);
  expect((await rbacQuery("SELECT attempts FROM package_jobs WHERE version_id=$1", [versionId]))[0].attempts).toBe(1);
});
it("waits for the old storage lease before reclaiming a crashed job", async () => {
  const { versionId, submit } = await fixture(); await submit();
  await rbacQuery("UPDATE package_jobs SET state='processing',lease='crashed',lease_until=0 WHERE version_id=$1", [versionId]);
  await rbacQuery("UPDATE upload_sessions SET package_lease='crashed',package_lease_until=$1 WHERE version_id=$2", [Date.now() + 45000, versionId]);
  expect(await runNextPackageJob()).toBe(false);
  await rbacQuery("UPDATE upload_sessions SET package_lease_until=0 WHERE version_id=$1", [versionId]);
  await runNextPackageJob();
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1", [versionId]))[0].state).toBe("completed");
});
it("keeps synchronous commits available to older clients", async () => {
  const { versionId, context } = await fixture();
  const response = await commit(new Request(origin + `/api/uploads/${versionId}/commit`, { method: "POST", headers, body: "{}" }), context);
  expect(response.status).toBe(201); expect((await response.json()).slug).toBeTruthy();
  expect(await rbacQuery("SELECT * FROM package_jobs WHERE version_id=$1", [versionId])).toHaveLength(0);
});

it("rolls back publication if a worker loses its job lease", async () => {
  const { versionId, submit } = await fixture(); await submit();
  const storage = getStorage("package"), measure = storage.measureVersion.bind(storage);
  vi.spyOn(storage, "measureVersion").mockImplementationOnce(async (...args) => {
    await rbacQuery("UPDATE package_jobs SET lease='replacement-worker' WHERE version_id=$1", [versionId]);
    return measure(...args);
  });
  await runNextPackageJob();
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toHaveLength(0);
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1", [versionId]))[0].state).not.toBe("completed");
});

it("rolls back enqueue when extending the publication lease fails", async () => {
  const { versionId, context } = await fixture();
  const transaction = db.rbacTransaction;
  let inject = true;
  const spy = vi.spyOn(db, "rbacTransaction").mockImplementation(work => transaction(q => work(async (sql, args) => {
    if (inject && sql.startsWith("UPDATE publish_operations SET lease_until=$1")) { inject = false; throw new Error("Connection lost"); }
    return q(sql, args);
  })));
  const submit = () => commit(new Request(origin + `/api/uploads/${versionId}/commit?async=1`, {method:"POST",headers:{...headers,"idempotency-key":"enqueue-atomic-regression"},body:"{}"}),context);
  expect((await submit()).status).toBe(500);
  expect(await rbacQuery("SELECT version_id FROM package_jobs WHERE version_id=$1",[versionId])).toHaveLength(0);
  spy.mockRestore();
  expect((await submit()).status).toBe(202); await runNextPackageJob();
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1",[versionId]))[0].state).toBe("completed");
});
async function account(subject: string) {
  const user = await db.upsertUser({authProvider:"test",providerSubject:subject,email:subject+"@example.test",emailVerified:true});
  const {cookie} = await mintSession(new Request(origin),user.id);
  return {user, cookie:cookie.split(";")[0]};
}
async function queuedUpdate(slug: string, expected: string, auth: Record<string,string>) {
  const h={...auth,origin,"content-type":"application/json"};
  const opened=await start(new Request(origin+"/api/uploads",{method:"POST",headers:h,body:JSON.stringify({slug,package:{source:"folder"}})}));
  expect(opened.status).toBe(201);const {versionId}=await opened.json();
  expect((await PUT(new Request(origin,{method:"PUT",headers:h,body:"updated"}),{params:Promise.resolve({versionId,relpath:["notes.txt"]})})).status).toBe(200);
  expect((await commit(new Request(origin+`/api/uploads/${versionId}/commit?async=1&expected_version=${expected}`,{method:"POST",headers:h,body:"{}"}),{params:Promise.resolve({versionId})})).status).toBe(202);
  return versionId;
}
it("does not let a stale browser edit token veto the account owner",async()=>{
  const owner=await account("adopted-owner");
  const {site}=await createSite({mode:"folder",files:[{relpath:"index.html",bytes:Buffer.from("owned")}]},{ownerId:owner.user.id});
  await db.setEditToken(site.id,"");
  const id=await queuedUpdate(site.slug,site.currentVersionId!,{cookie:owner.cookie,"x-edit-token":"old-anonymous-token"});
  await runNextPackageJob();
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1",[id]))[0].state).toBe("completed");
});
it.each(["valid","rotated","expired"])("revalidates %s passcode admission in background updates",async mode=>{
  const owner=await account("passcode-owner-"+mode), editor=await account("passcode-editor-"+mode);
  const {site}=await createSite({mode:"folder",files:[{relpath:"index.html",bytes:Buffer.from("shared")}]},{ownerId:owner.user.id});
  const token="passcode-share-"+site.id;
  const share=await db.createShare({id:"shr_"+site.id,siteId:site.id,mode:"edit",tokenHash:hashToken(token),policy:"passcode",passcodeHash:hashPasscode("secret"),label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null});
  const cookie=buildPasscodeCookie(new Request(origin),(await db.getShare(share.id))!).split(";")[0];
  const id=await queuedUpdate(site.slug,site.currentVersionId!,{cookie:editor.cookie+"; "+cookie,"x-artifact-share":token});
  if(mode==="rotated") await rbacQuery("UPDATE site_shares SET passcode_hash=$1 WHERE id=$2",[hashPasscode("changed"),share.id]);
  if(mode==="expired") {
    const [row]=await rbacQuery("SELECT payload FROM package_jobs WHERE version_id=$1",[id]);const payload=JSON.parse(String(row.payload));payload.passcode.expiresAt=0;
    await rbacQuery("UPDATE package_jobs SET payload=$1 WHERE version_id=$2",[JSON.stringify(payload),id]);
  }
  await runNextPackageJob();
  expect((await rbacQuery("SELECT state FROM package_jobs WHERE version_id=$1",[id]))[0].state).toBe(mode==="valid"?"completed":"failed");
});
it("retains structured version conflicts from the worker",async()=>{
  const owner=await account("conflict-owner");
  const {site}=await createSite({mode:"folder",files:[{relpath:"index.html",bytes:Buffer.from("original")}]},{ownerId:owner.user.id});
  const id=await queuedUpdate(site.slug,site.currentVersionId!,{cookie:owner.cookie});
  const newer=await replaceSiteContent(site.slug,{mode:"folder",files:[{relpath:"index.html",bytes:Buffer.from("newer")}]},{actor:{kind:"user",userId:owner.user.id,anonId:null},method:"api",ip:null,userAgent:null});
  if (!newer || !("version" in newer)) throw new Error("Concurrent update failed");
  await runNextPackageJob();
  const response=await status(new Request(origin,{headers:{cookie:owner.cookie}}),{params:Promise.resolve({versionId:id})});
  expect(await response.json()).toMatchObject({status:"failed",retryable:false,failure:{status:409,body:{code:"version_conflict",currentVersionId:newer.version.id}}});
});
it("keeps an accepted job's lease after a failed response lookup",async()=>{
  const {versionId,context}=await fixture(); const query=db.rbacQuery;let inject=true;
  const spy=vi.spyOn(db,"rbacQuery").mockImplementation(async(sql,args)=>{
    if(inject && sql==="SELECT * FROM publish_operations WHERE id=$1") {inject=false;throw new Error("Post-enqueue lookup failed");}
    return query(sql,args);
  });
  const request=()=>new Request(origin+`/api/uploads/${versionId}/commit?async=1`,{method:"POST",headers:{...headers,"idempotency-key":"enqueue-response-regression"},body:"{}"});
  expect((await commit(request(),context)).status).toBe(500);spy.mockRestore();
  expect((await commit(request(),context)).status).toBe(409);
  await runNextPackageJob();
  expect((await commit(request(),context)).status).toBe(201);
  expect(await rbacQuery("SELECT id FROM versions WHERE id=$1",[versionId])).toHaveLength(1);
});

it("renotifies a real manually retried failure after attempts reset from 3 to 0 to 3", async () => {
  const { versionId, context, submit } = await fixture(); await submit();
  const failure = vi.spyOn(getStorage("package"), "sizeOf").mockRejectedValue(new Error("COS unavailable"));
  const failRound = async () => {
    for (let i = 0; i < 3; i++) {
      await rbacQuery("UPDATE package_jobs SET available_at=0 WHERE version_id=$1", [versionId]);
      await runNextPackageJob();
    }
    return (await status(new Request(origin, { headers }), context)).json();
  };
  try {
    const first = await failRound();
    expect(first).toMatchObject({ status: "failed", attempts: 3 });
    expect(first.generation).toEqual(expect.any(String));
    const receipts = readJobReceipts(JSON.stringify(acknowledgeJobs([first], {})));
    expect(jobNotice([first], receipts)).toBeNull();
    const originalPayload = JSON.parse(String((await rbacQuery("SELECT payload FROM package_jobs WHERE version_id=$1", [versionId]))[0].payload));
    const queued = await (await retry(new Request(origin, { method: "POST", headers }), context)).json();
    const retriedPayload = JSON.parse(String((await rbacQuery("SELECT payload FROM package_jobs WHERE version_id=$1", [versionId]))[0].payload));
    expect(retriedPayload).toEqual({ ...originalPayload, generation: queued.generation });
    expect(queued).toMatchObject({ status: "queued", attempts: 0 });
    expect(queued.generation).not.toBe(first.generation);
    // Repeated retry requests while already queued must not create another generation.
    expect((await (await retry(new Request(origin, { method: "POST", headers }), context)).json()).generation).toBe(queued.generation);
    const second = await failRound();
    expect(second).toMatchObject({ status: "failed", attempts: 3, generation: queued.generation });
    expect(jobNotice([second], receipts)).toBe("failed");
    const refreshed = await (await status(new Request(origin, { headers }), context)).json();
    expect(jobNotice([refreshed], receipts)).toBe("failed");
    expect(jobNotice([refreshed], acknowledgeJobs([second], receipts))).toBeNull();
  } finally { failure.mockRestore(); }
});
