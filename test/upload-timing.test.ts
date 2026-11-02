import { afterEach, expect, it, vi } from "vitest";
import { traceUpload, timeUpload, traceUploadStore, uploadMetric, uploadCount, uploadBytes } from "@/lib/upload-timing";
afterEach(() => vi.restoreAllMocks());
it("correlates timing headers with sanitized logs and keeps concurrent requests isolated", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const store = traceUploadStore({ async query() { await timeUpload("db", async () => new Promise(resolve => setTimeout(resolve, 5))); return 3; } });
  const [one, two] = await Promise.all([1, 2].map(index => traceUpload(new Request(`http://localhost/chunks?index=${index}&secret=hidden`, { headers: { authorization: "Bearer secret", "cf-ray": "abc-LAX" } }), `ver_${index}`, async () => {
    await timeUpload("auth", () => store.query());
    uploadBytes(index * 10); uploadMetric("cos", index * 5); uploadCount("cos_attempts", index);
    return new Response("ok");
  })));
  expect(one.headers.get("x-upload-request-id")).not.toBe(two.headers.get("x-upload-request-id"));
  expect(one.headers.get("server-timing")).toMatch(/db;dur=.*auth;dur=.*cos;dur=.*app;dur=/);
  const records = log.mock.calls.map(call => JSON.parse(String(call[1])));
  for (const entry of records) {
    expect(entry.calls.db).toBe(1); expect(entry.timingsMs.db).toBeGreaterThanOrEqual(1);
    expect(entry.bytes).toBe(entry.index * 10); expect(entry.calls.cos_attempts).toBe(entry.index);
    expect(entry.cfRay).toBe("abc-LAX"); expect(entry.status).toBe(200);
  }
  expect(JSON.stringify(records)).not.toMatch(/secret|hidden|Bearer/);
  await store.query(); expect(log).toHaveBeenCalledTimes(2);
});
it("records failed stages and emits the actual error response status", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await traceUpload(new Request("http://localhost/chunks?index=bad", { headers: { "cf-ray": "unsafe value" } }), "invalid/id", async () => {
    try { await timeUpload("cos", async () => { throw new Error("private storage details"); }); }
    catch { return new Response("error", { status: 503 }); }
    return new Response();
  });
  const record = JSON.parse(String(log.mock.calls[0][1]));
  expect(record).toMatchObject({ status: 503, index: null, calls: { cos: 1 } });
  expect(record.versionId).toBeUndefined(); expect(record.cfRay).toBeUndefined();
  expect(record.timingsMs.cos).toBeGreaterThanOrEqual(0);
  expect(response.headers.get("server-timing")).toContain("cos;dur=");
});
