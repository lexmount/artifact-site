import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSiteClient } from "../src/client.js";
afterEach(() => vi.unstubAllEnvs());
for (const kind of ["export", "download"]) it.each(["gzip", "br"])(`downloads decoded ${kind} bytes through %s compression`, async encoding => {
  const source = Buffer.from('\uFEFF"text"\r\n' + '"中文 record"\r\n'.repeat(100));
  const compressed = encoding === "gzip" ? gzipSync(source) : brotliCompressSync(source);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-encoding": encoding, "content-length": String(compressed.length), "content-type": "application/octet-stream" });
    res.end(compressed);
  });
  const directory = await mkdtemp(join(tmpdir(), "compressed-download-")), out = join(directory, "download");
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const client = new ArtifactSiteClient({ baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mounted` });
    const result = kind === "export" ? await client.exportToFile("slug", { out }) : await client.downloadToFile("slug", { out });
    expect(result.bytes).toBe(source.length); expect(await readFile(out)).toEqual(source);
    expect(await readdir(directory)).toEqual(["download"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
it.each(["export", "download"])("keeps existing %s output on an unencoded size mismatch", async kind => {
  const directory = await mkdtemp(join(tmpdir(), "download-length-")), out = join(directory, "download");
  try {
    await writeFile(out, "keep me");
    const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: (async () => new Response("unexpected bytes", { headers: { "content-length": "0" } })) as typeof fetch });
    const save = kind === "export" ? client.exportToFile("slug", { out }) : client.downloadToFile("slug", { out });
    await expect(save).rejects.toThrow("Download size mismatch");
    expect(await readFile(out, "utf8")).toBe("keep me"); expect(await readdir(directory)).toEqual(["download"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
