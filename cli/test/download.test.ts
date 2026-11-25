import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSiteClient } from "../src/client.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { run } from "../src/cli.js";

const dirs: string[] = [];
async function destination() { const dir = await mkdtemp(join(tmpdir(), "artifact-download-")); dirs.push(dir); return join(dir, "saved.html"); }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const grant = (url = "https://cdn.example/file?sign=short", versionId = "ver_1", size = 8) => Response.json({ url, versionId, filename: "report.html", size });

it.each(["https://cdn.example/file?sign=short", "https://bucket.example/file?X-Amz-Signature=short"])("streams %s to disk without buffering or forwarding credentials", async url => {
  const out = await destination();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant(url)).mockResolvedValueOnce(new Response("original"));
  const buffer = vi.spyOn(Response.prototype, "arrayBuffer").mockRejectedValue(new Error("No whole-file buffering"));
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", token: "secret", shareToken: "share-secret", fetch: fetcher });
  expect(await client.downloadToFile("slug", { out })).toMatchObject({ file: out, bytes: 8, versionId: "ver_1" });
  expect(await readFile(out, "utf8")).toBe("original");
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer secret");
  expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/api/sites/slug/download");
  expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).has("authorization")).toBe(false);
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).has("x-artifact-share")).toBe(false);
  expect(buffer).not.toHaveBeenCalled();
  expect(await readdir(dirs.at(-1)!)).toEqual(["saved.html"]);
});

it("supports older/local servers returning attachment bytes directly", async () => {
  const out = await destination();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("original", { headers: { "content-disposition": "attachment; filename*=UTF-8''report.html", "x-artifact-version": "ver_local" } }));
  const client = new ArtifactSiteClient({ baseUrl: "http://local", fetch: fetcher });
  expect(await client.downloadToFile("slug", { out })).toMatchObject({ versionId: "ver_local", bytes: 8 });
  expect(await readFile(out, "utf8")).toBe("original"); expect(fetcher).toHaveBeenCalledTimes(1);
});

it("renews an expired object URL once, pins its version and reauthorizes", async () => {
  const out = await destination();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant()).mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(grant("https://cdn.example/file?sign=new")).mockResolvedValueOnce(new Response("original"));
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", token: "secret", fetch: fetcher });
  await client.downloadToFile("slug", { out });
  const renewed = new URL(String(fetcher.mock.calls[2][0]));
  expect(renewed.searchParams.get("version")).toBe("ver_1"); expect(renewed.searchParams.has("snapshot")).toBe(false);
  expect(new Headers(fetcher.mock.calls[2][1]?.headers).get("authorization")).toBe("Bearer secret");
  expect(await readFile(out, "utf8")).toBe("original"); expect(fetcher).toHaveBeenCalledTimes(4);
});

it.each(["revoked", "expired again", "different version", "truncated", "broken stream"])("leaves an existing destination intact after %s", async failure => {
  const out = await destination(); await writeFile(out, "keep me");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant());
  if (failure === "truncated") fetcher.mockResolvedValueOnce(new Response("short"));
  else if (failure === "broken stream") fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ pull(c) { c.error(new Error("connection lost")); } })));
  else {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    if (failure === "revoked") fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    else fetcher.mockResolvedValueOnce(grant(undefined, failure === "different version" ? "ver_2" : "ver_1")).mockResolvedValueOnce(new Response(null, { status: 403 }));
  }
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: fetcher, retries: 0 });
  await expect(client.downloadToFile("slug", { out })).rejects.toThrow();
  expect(await readFile(out, "utf8")).toBe("keep me");
  expect(await readdir(dirs.at(-1)!)).toEqual(["saved.html"]);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
});

it("cancels a live transfer and removes its partial file without retrying", async () => {
  const out = await destination(); const abort = new AbortController(); let pulls = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65536)); if (++pulls === 5) abort.abort(); }, cancel: cancelled });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant(undefined, "ver_1", 200 * 1024 * 1024)).mockResolvedValueOnce(new Response(body));
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: fetcher });
  await expect(client.downloadToFile("slug", { out, signal: abort.signal })).rejects.toThrow();
  expect(await readdir(dirs.at(-1)!)).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2); expect(cancelled).toHaveBeenCalled();
});

it("rejects a file manifest without leaving an output file", async () => {
  const out = await destination(); const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ files: [{ path: "a.html" }] })) });
  await expect(client.downloadToFile("slug", { out })).rejects.toThrow("unsupported download response");
  expect(await readdir(dirs.at(-1)!)).toEqual([]);
});

it("streams a 200 MiB HTTP response with backpressure and matching bytes", async () => {
  const out = await destination(); const chunk = Buffer.alloc(64 * 1024, 173), blocks = 3200;
  const expected = createHash("sha256"); for (let i = 0; i < blocks; i++) expected.update(chunk);
  let origin = ""; const objectHeaders: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ url: origin + "/object?signed=1", versionId: "ver_200", size: chunk.length * blocks, filename: "large.bin" })); return;
    }
    objectHeaders.push(req.headers.authorization, req.headers["x-artifact-share"], req.headers.cookie);
    res.setHeader("content-length", String(chunk.length * blocks));
    for (let i = 0; i < blocks; i++) { if (res.destroyed) return; if (!res.write(chunk)) await once(res, "drain"); }
    res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    vi.spyOn(Response.prototype, "arrayBuffer").mockRejectedValue(new Error("No buffering"));
    const client = new ArtifactSiteClient({ baseUrl: origin, token: "secret", shareToken: "share-secret" });
    const result = await client.downloadToFile("slug", { out });
    expect(result.bytes).toBe(200 * 1024 * 1024);
    const actual = createHash("sha256"); for await (const data of createReadStream(out)) actual.update(data);
    expect(actual.digest("hex")).toBe(expected.digest("hex")); expect(objectHeaders).toEqual([undefined, undefined, undefined]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);

it.each(["download", "export"])("cancels CLI %s with SIGINT without reporting success or leaving partial files", async command => {
  vi.stubEnv("ARTIFACT_SITE_TOKEN", "test-token");
  const out = await destination(); let pulls = 0;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant(undefined, "ver_1", 200 * 1024 * 1024)).mockResolvedValueOnce(new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(65536)); if (++pulls === 5) process.emit("SIGINT"); },
  })));
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: fetcher });
  const io = { out: vi.fn(), err: vi.fn(), stdin: async () => "" }; const listeners = process.listenerCount("SIGINT");
  expect(await run(["--base", "https://app.example", command, "slug", "--out", out], io, () => client)).toBe(130);
  expect(io.out).not.toHaveBeenCalled(); expect(io.err).toHaveBeenCalledWith("Download cancelled");
  expect(await readdir(dirs.at(-1)!)).toEqual([]); expect(process.listenerCount("SIGINT")).toBe(listeners);
});

it("cancels authorization backoff immediately without another request", async () => {
  const out = await destination(), controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: fetcher });
  const result = client.downloadToFile("slug", { out, signal: controller.signal });
  const rejected = expect(result).rejects.toThrow();
  setTimeout(() => controller.abort(), 20);
  await rejected; expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(dirs.at(-1)!)).toEqual([]);
});
