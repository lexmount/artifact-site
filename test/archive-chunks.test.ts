import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { POST as start } from "@/lib/application/uploads";
import { PUT } from "@/lib/application/upload-chunk";
import { POST as commit } from "@/lib/application/upload-commit";
import { GET } from "@/lib/application/upload-status";
import { assembleArchive, writeFileChunk, cancelUpload } from "@/lib/mcp/files";
import { runNextPackageJob } from "@/lib/package-jobs";
import { rbacQuery, getUploadSessionRow, listUploadSessionsForTarget, getVersion } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { PACKAGE_ORIGINAL } from "@/lib/package-contract";
const headers = { authorization: "Bearer chunk-test", "content-type": "application/json" };
const origin = "http://localhost";
const archive = () => Buffer.from(zipSync({ "index.html": Buffer.from("<h1>Chunked</h1>"), "nested/data.txt": Buffer.from("data") }));
beforeEach(async () => { vi.stubEnv("PUBLISH_API_TOKEN", "chunk-test"); await rbacQuery("DELETE FROM package_jobs"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const res = await start(new Request(origin + "/api/uploads", { method: "POST", headers, body: JSON.stringify({ package: { source: "archive", name: "test.zip" } }) }));
  expect(res.status).toBe(201); const { versionId } = await res.json();
  const ctx = { params: Promise.resolve({ versionId }) };
  const put = (index: number, bytes: Buffer, final = false, h = headers) => PUT(new Request(`${origin}/api/uploads/${versionId}/chunks?index=${index}&final=${final ? 1 : 0}`, { method: "PUT", headers: h, body: new Uint8Array(bytes) }), ctx);
  const submit = () => commit(new Request(`${origin}/api/uploads/${versionId}/commit?async=1`, { method: "POST", headers, body: "{}" }), ctx);
  return { versionId, ctx, put, submit };
}
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("seals promptly, resumes identical chunks, assembles in a durable worker and cleans parts", async () => {
  const f = await fixture(), bytes = archive(), cut = 40;
  expect((await f.put(0, bytes.subarray(0, cut))).status).toBe(200);
  expect((await f.put(0, bytes.subarray(0, cut))).status).toBe(200);
  expect((await f.put(0, Buffer.from("different"))).status).toBe(409);
  expect((await f.put(2, Buffer.from("skip"))).status).toBe(409);
  expect((await f.submit()).status).toBe(400);
  expect((await f.put(1, bytes.subarray(cut), true)).status).toBe(200);
  expect((await f.put(1, bytes.subarray(cut), true)).status).toBe(200);
  expect((await getUploadSessionRow(f.versionId))?.files).toHaveLength(0);
  const info = await (await GET(new Request(origin, { headers }), f.ctx)).json();
  expect(info.partialFiles[0]).toMatchObject({ nextIndex: 2, sealed: true, bytes: bytes.length });
  expect(info.partialFiles[0].chunks[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.submit()).status).toBe(202);
  expect((await f.put(1, bytes.subarray(cut), true)).status).toBe(409);
  const parent = await getUploadSessionRow(f.versionId);
  await runNextPackageJob();
  const job = await (await GET(new Request(origin, { headers }), f.ctx)).json();
  expect(job.status, JSON.stringify(job)).toBe("completed");
  expect(Buffer.from(await getStorage("package").read(parent!.siteId, f.versionId, PACKAGE_ORIGINAL))).toEqual(bytes);
  expect(await listUploadSessionsForTarget(`mcp-parts:${parent!.ownerKey}`, f.versionId)).toHaveLength(0);
  expect((await f.submit()).status).toBe(200);
  const { GET: exportZip } = await import("@/app/api/sites/[slug]/export/route");
  const wholeRead = vi.spyOn(getStorage("package"), "read").mockRejectedValue(new Error("Whole-file buffering is forbidden"));
  try {
    const exported = await exportZip(new Request(`${origin}/api/sites/${job.result.slug}/export`, { headers }), { params: Promise.resolve({ slug: job.result.slug }) });
    expect(exported.status).toBe(200);
    expect(Buffer.from(await exported.arrayBuffer())).toEqual(bytes);
    expect(wholeRead).not.toHaveBeenCalled();
    expect((await exportZip(new Request(`${origin}/api/sites/${job.result.slug}/export`), { params: Promise.resolve({ slug: job.result.slug }) })).status).not.toBe(200);
  } finally { wholeRead.mockRestore(); }
});
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("MCP seals archive chunks without synchronous assembly", async () => {
  const f = await fixture(); const request = new Request(origin + "/mcp", { headers });
  expect(await writeFileChunk(request, f.versionId, "original", 0, archive().toString("base64"), true)).toMatchObject({ complete: true });
  expect((await getUploadSessionRow(f.versionId))?.files).toHaveLength(0);
  expect((await f.submit()).status).toBe(202);
  await runNextPackageJob(); expect(await getVersion(f.versionId)).toBeTruthy();
});
it("enforces owner, size and path boundaries and cleans cancelled chunks", async () => {
  const f = await fixture();
  expect((await f.put(0, Buffer.from("x"), false, { ...headers, authorization: "Bearer stranger" })).status).toBe(404);
  expect((await f.put(0, Buffer.alloc(4 * 1024 * 1024 + 1))).status).toBe(413);
  vi.stubEnv("ARTIFACT_ARCHIVE_MAX_BYTES", "4");
  expect((await f.put(0, Buffer.from("12345"))).status).toBe(400);
  expect((await f.put(0, Buffer.from("1234"))).status).toBe(200);
  await expect(writeFileChunk(new Request(origin, { headers }), f.versionId, "../original", 1, "", true)).rejects.toThrow();
  const parent = await getUploadSessionRow(f.versionId);
  await cancelUpload(new Request(origin, { headers }), f.versionId);
  expect(await getUploadSessionRow(f.versionId)).toBeNull();
  expect(await listUploadSessionsForTarget(`mcp-parts:${parent!.ownerKey}`, f.versionId)).toHaveLength(0);
});
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("recovers background assembly failure without requiring another upload", async () => {
  const f = await fixture(); await f.put(0, archive(), true); await f.submit();
  const storage = getStorage("package");
  const spy = vi.spyOn(storage, "writeStreamToVersion").mockRejectedValueOnce(new Error("temporary storage outage"));
  await runNextPackageJob(); spy.mockRestore();
  await rbacQuery("UPDATE package_jobs SET available_at=0 WHERE version_id=$1", [f.versionId]);
  await runNextPackageJob();
  expect(await getVersion(f.versionId)).toBeTruthy();
});
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("preserves whole-file clients and refuses mixing transfer modes", async () => {
  const { PUT: whole } = await import("@/lib/application/upload-file");
  const f = await fixture();
  const sendWhole = () => whole(new Request(origin, { method: "PUT", headers, body: new Uint8Array(archive()) }), { params: Promise.resolve({ versionId: f.versionId, relpath: ["original"] }) });
  expect((await sendWhole()).status).toBe(200);
  expect((await sendWhole()).status).toBe(200);
  expect((await f.put(0, archive(), true)).status).toBe(400);
  expect((await f.submit()).status).toBe(202); await runNextPackageJob();
  expect(await getVersion(f.versionId)).toBeTruthy();
});
it("detects damaged stored chunks before publishing", async () => {
  const f = await fixture(); await f.put(0, archive(), true);
  const parent = (await getUploadSessionRow(f.versionId))!;
  const [part] = await listUploadSessionsForTarget(`mcp-parts:${parent.ownerKey}`, f.versionId);
  await getStorage().writeVersionFiles(part.siteId, part.versionId, [{ relpath: part.files[0].relpath, bytes: Buffer.from("damaged") }]);
  await f.submit(); await runNextPackageJob();
  const job = await (await GET(new Request(origin, { headers }), f.ctx)).json();
  expect(job).toMatchObject({ status: "failed", retryable: false });
  expect(job.error).toContain("integrity"); expect(await getVersion(f.versionId)).toBeNull();
});
it("serializes concurrent chunk writers without duplicate receipts", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.put(0, archive(), true), f.put(0, archive(), true)]);
  expect(responses.some(r => r.status === 200)).toBe(true);
  expect(responses.every(r => [200, 409].includes(r.status))).toBe(true);
  const state = await (await GET(new Request(origin, { headers }), f.ctx)).json();
  expect(state.partialFiles[0].nextIndex).toBe(1);
});

it("keeps acknowledged S3 parts after a later object write fails and assembles after retry", async () => {
  for (const [key, value] of Object.entries({ ARTIFACT_S3_ENDPOINT: "https://s3.example.test", ARTIFACT_S3_BUCKET: "b", ARTIFACT_S3_ACCESS_KEY_ID: "k", ARTIFACT_S3_SECRET_ACCESS_KEY: "s", ARTIFACT_S3_REGION: "auto" })) vi.stubEnv(key, value);
  const { S3Storage } = await import("@/lib/storage-s3");
  const timingLog = vi.spyOn(console, "info").mockImplementation(() => {});
  const s3 = new S3Storage(), objects = new Map<string, Uint8Array>(); let writes = 0;
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") {
      if (++writes === 2) throw new Error("temporary S3 failure");
      objects.set(String(input.Key), input.Body as Uint8Array); return {};
    }
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...objects.keys()].map(Key => ({ Key })) };
    if (command.constructor.name === "DeleteObjectCommand") { objects.delete(String(input.Key)); return {}; }
    throw new Error("Unexpected S3 operation");
  });
  (s3 as unknown as { client: { send: typeof send } }).client = { send };
  const storage = getStorage();
  vi.spyOn(storage, "writeFileToVersion").mockImplementation(s3.writeFileToVersion.bind(s3));
  vi.spyOn(storage, "writeVersionFiles").mockImplementation(s3.writeVersionFiles.bind(s3));
  const f = await fixture();
  expect((await f.put(0, Buffer.from("first"))).status).toBe(200);
  expect((await f.put(1, Buffer.from("second"), true)).status).toBe(500);
  expect(objects.size).toBe(1);
  const failedTiming = timingLog.mock.calls.filter(call => call[0] === "[upload-timing]").map(call => JSON.parse(String(call[1]))).find(record => record.status === 500);
  expect(failedTiming.calls.cos_attempts).toBe(1);
  expect(failedTiming.timingsMs).toHaveProperty("cos");
  expect(failedTiming.timingsMs).toHaveProperty("db");
  expect((await f.put(1, Buffer.from("second"), true)).status).toBe(200);
  const read = vi.spyOn(storage, "read").mockImplementation(s3.read.bind(s3));
  const parent = (await getUploadSessionRow(f.versionId))!;
  await assembleArchive(parent);
  read.mockRestore();
  expect(Buffer.from(await getStorage("package").read(parent.siteId, f.versionId, PACKAGE_ORIGINAL)).toString()).toBe("firstsecond");
  expect(send.mock.calls.some(([command]) => command.constructor.name === "DeleteObjectCommand")).toBe(false);
});
