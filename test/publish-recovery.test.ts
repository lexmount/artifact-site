import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "@/app/api/sites/route";
import { POST as OPEN } from "@/app/api/uploads/route";
import { POST as COMMIT } from "@/app/api/uploads/[versionId]/commit/route";
import { PUT } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { rbacQuery } from "@/lib/db";
import { randomUUID } from "node:crypto";
const req = (path: string, key: string, body: unknown = {}) => new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: "Bearer recovery-test", origin: "http://localhost", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
afterEach(() => vi.unstubAllEnvs());
function setup() { vi.stubEnv("PUBLISH_API_TOKEN", "recovery-test"); }
describe("durable publication recovery", () => {
  it("replays creation exactly, rejects changed content, and inserts one site", async () => {
    setup(); const key = randomUUID(); const body = { mode: "paste", html: "<h1>Recovery</h1>" };
    const first = await POST(req("/api/sites", key, body)); expect(first.status).toBe(200);
    const result = await first.json();
    const second = await POST(req("/api/sites", key, body)); expect(second.status).toBe(200); expect(await second.json()).toEqual(result);
    expect((await POST(req("/api/sites", key, { ...body, html: "changed" }))).status).toBe(409);
    expect(await rbacQuery("SELECT id FROM sites WHERE slug=$1", [result.slug])).toHaveLength(1);
  });
  it("serializes concurrent creates", async () => {
    setup(); const key = randomUUID(); const body = { mode: "paste", html: "<p>Concurrent</p>" };
    const before = (await rbacQuery("SELECT id FROM sites")).length;
    const responses = await Promise.all(Array.from({ length: 4 }, () => POST(req("/api/sites", key, body))));
    expect((await rbacQuery("SELECT id FROM sites")).length).toBe(before + 1);
    expect(responses.filter(r => r.status === 200).length).toBeGreaterThan(0);
    expect(responses.every(r => [200, 409].includes(r.status))).toBe(true);
    const result = await (await POST(req("/api/sites", key, body))).json();
    expect(await rbacQuery("SELECT id FROM sites WHERE slug=$1", [result.slug])).toHaveLength(1);
  });
  it("replays a commit after the upload session has been removed", async () => {
    setup(); const openKey = randomUUID(); const opened = await OPEN(req("/api/uploads", openKey));
    const { versionId } = await opened.json(); expect(versionId).toBeTruthy();
    expect(await (await OPEN(req("/api/uploads", openKey))).json()).toEqual({ versionId });
    const upload = new Request(`http://localhost/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers: { authorization: "Bearer recovery-test", origin: "http://localhost" }, body: "<h1>Uploaded</h1>" });
    expect((await PUT(upload, { params: Promise.resolve({ versionId, relpath: ["index.html"] }) })).status).toBe(200);
    const key = randomUUID(); const route = `/api/uploads/${versionId}/commit`; const context = { params: Promise.resolve({ versionId }) };
    const first = await COMMIT(req(route, key), context); expect(first.status).toBe(201); const result = await first.json();
    const retry = await COMMIT(req(route, key), context); expect(retry.status).toBe(201); expect(await retry.json()).toEqual(result);
  });
});

it("recovers after reopening the database and keeps changed multipart boundaries equivalent", async () => {
  setup(); const key = randomUUID();
  const upload = () => { const form = new FormData(); form.set("mode", "file"); form.set("file", new File(["<h1>Multipart</h1>"], "index.html")); return new Request("http://localhost/api/sites", { method: "POST", headers: { authorization: "Bearer recovery-test", origin: "http://localhost", "idempotency-key": key }, body: form }); };
  const first = await POST(upload()); expect(first.status).toBe(200); const result = await first.json();
  const { closeDbForTests } = await import("@/lib/db"); await closeDbForTests();
  const second = await POST(upload()); expect(second.status).toBe(200); expect(await second.json()).toEqual(result);
});
it("isolates operation queries by identity and refuses expired keys", async () => {
  setup(); const key = randomUUID(); const body = { mode: "paste", html: "<p>Private recovery</p>" };
  expect((await POST(req("/api/sites", key, body))).status).toBe(200);
  const { GET } = await import("@/app/api/operations/[key]/route");
  const query = () => GET(new Request("http://localhost/api/operations/" + key, { headers: { authorization: "Bearer recovery-test" } }), { params: Promise.resolve({ key }) });
  expect((await query()).status).toBe(200);
  vi.stubEnv("PUBLISH_API_TOKEN", "different-test");
  const other = await GET(new Request("http://localhost/api/operations/" + key, { headers: { authorization: "Bearer different-test" } }), { params: Promise.resolve({ key }) }); expect(other.status).toBe(404);
  vi.stubEnv("PUBLISH_API_TOKEN", "recovery-test");
  const { operationId } = await import("@/lib/publish-operation"); const { ownerKeyFor } = await import("@/lib/upload-session");
  const id = operationId((await ownerKeyFor(req("/api/sites", key, body)))!, key);
  await rbacQuery("UPDATE publish_operations SET expires_at=1 WHERE id=$1", [id]);
  const expired = await query(); expect(expired.status).toBe(410); expect((await expired.json()).error).toMatch(/seven-day/); expect((await POST(req("/api/sites", key, body))).status).toBe(410);
});
it("rolls back the business write if a newer lease supersedes the worker", async () => {
  setup();
  const { withPublishOperation } = await import("@/lib/publish-operation");
  const key = randomUUID(); const body = { mode: "paste", html: "<p>Fenced worker</p>", title: key };
  const response = await withPublishOperation(req("/api/sites", key, body), async request => {
    await rbacQuery("UPDATE publish_operations SET lease='new-worker' WHERE state='running'");
    const headers = new Headers(request.headers); headers.delete("idempotency-key");
    return POST(new Request(request, { headers }));
  });
  expect(response.status).toBe(409);
  expect(await rbacQuery("SELECT id FROM sites WHERE title=$1", [key])).toHaveLength(0);
});
it("reclaims a crashed pre-commit attempt using the same key", async () => {
  setup(); const key = randomUUID(); const body = { mode: "paste", html: "<p>Crash recovery</p>" };
  const { withPublishOperation } = await import("@/lib/publish-operation");
  await withPublishOperation(req("/api/sites", key, body), async () => { throw new Error("simulated crash before commit"); });
  const recovered = await POST(req("/api/sites", key, body)); expect(recovered.status).toBe(200);
  expect(await (await POST(req("/api/sites", key, body))).json()).toEqual(await recovered.json());
});

it("invalidates the old file receipt before an interrupted overwrite", async () => {
  setup(); const opened = await OPEN(req("/api/uploads", randomUUID())); const { versionId } = await opened.json();
  const context = { params: Promise.resolve({ versionId, relpath: ["index.html"] }) };
  const upload = (body: BodyInit) => new Request(`http://localhost/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers: { authorization: "Bearer recovery-test", origin: "http://localhost" }, body, duplex: "half" } as RequestInit & { duplex: "half" });
  expect((await PUT(upload("original"), context)).status).toBe(200);
  const { GET } = await import("@/app/api/uploads/[versionId]/route");
  const status = () => GET(new Request(`http://localhost/api/uploads/${versionId}`, { headers: { authorization: "Bearer recovery-test" } }), { params: Promise.resolve({ versionId }) });
  expect((await (await status()).json()).files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("interrupted upload")); } });
  expect((await PUT(upload(broken), context)).status).toBe(500);
  expect((await (await status()).json()).files).toEqual([]);
});

it("preserves edit response fields and first-response cookies", async () => {
  setup(); const created = await (await POST(req("/api/sites", randomUUID(), { mode: "paste", html: "<p>Original</p>" }))).json();
  const { POST: edit } = await import("@/app/api/sites/[slug]/edit/route");
  const key = randomUUID(), route = `/api/sites/${created.slug}/edit`, body = { content: "<p>Edited</p>" };
  const context = { params: Promise.resolve({ slug: created.slug }) };
  const { withPublishOperation } = await import("@/lib/publish-operation");
  const first = await withPublishOperation(req(route, key, body), async request => {
    const headers = new Headers(request.headers); headers.delete("idempotency-key");
    const response = await edit(new Request(request, { headers }), context);
    response.headers.append("set-cookie", "test-cookie=preserved; HttpOnly"); return response;
  }); const result = await first.json();
  expect(first.headers.get("set-cookie")).toBeTruthy(); expect(result.version.id).toBe(result.versionId);
  expect(await (await edit(req(route, key, body), context)).json()).toEqual(result);
});

it.each(["json", "multipart"])("rejects oversized %s before reserving its operation key", async format => {
  setup(); vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "500");
  const key = randomUUID(); const html = `<h1>${"x".repeat(2000)}</h1>`;
  let request = req("/api/sites", key, { mode: "paste", html });
  if (format === "multipart") {
    const form = new FormData(); form.set("mode", "file"); form.set("file", new File([html], "index.html"));
    const headers = new Headers(request.headers); headers.delete("content-type");
    const multipart = new Request(request.url, { method: "POST", headers, body: form });
    request = new Request(multipart.url, { method: "POST", headers: multipart.headers, body: await multipart.arrayBuffer() });
  }
  const { operationId, operationOwner } = await import("@/lib/publish-operation");
  const id = operationId(await operationOwner(request), key);
  const response = await POST(request); expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ code: "inline_upload_too_large", effect: "none" });
  expect(await rbacQuery("SELECT id FROM publish_operations WHERE id=$1", [id])).toEqual([]);
});
