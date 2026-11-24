import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactSiteClient } from "../src/client.js";
import { run } from "../src/cli.js";
afterEach(() => vi.unstubAllEnvs());
for (const kind of ["records", "snapshot"]) it.each(["gzip", "br"])(`downloads decoded ${kind} bytes through %s compression`, async encoding => {
  const source = Buffer.from('\uFEFF"text"\r\n' + '"中文 record"\r\n'.repeat(100));
  const compressed = encoding === "gzip" ? gzipSync(source) : brotliCompressSync(source);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-encoding": encoding, "content-length": String(compressed.length), "content-type": "application/octet-stream" });
    res.end(compressed);
  });
  const directory = await mkdtemp(join(tmpdir(), "compressed-records-")), out = join(directory, "download");
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const client = new ArtifactSiteClient({ baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mounted` });
    const result = kind === "records" ? await client.recordsExport("slug", "entries", out) : await client.snapshotToFile("slug", ["entries"], out);
    expect(result.bytes).toBe(source.length); expect(await readFile(out)).toEqual(source);
    expect(await readdir(directory)).toEqual(["download"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
it.each(["records", "snapshot"])("keeps existing %s output on an unencoded size mismatch", async kind => {
  const directory = await mkdtemp(join(tmpdir(), "records-length-")), out = join(directory, "download");
  try {
    await writeFile(out, "keep me");
    const client = new ArtifactSiteClient({ baseUrl: "https://app.example", fetch: (async () => new Response("unexpected bytes", { headers: { "content-length": "0" } })) as typeof fetch });
    const save = kind === "records" ? client.recordsExport("slug", "entries", out) : client.snapshotToFile("slug", [], out);
    await expect(save).rejects.toThrow("Download size mismatch");
    expect(await readFile(out, "utf8")).toBe("keep me"); expect(await readdir(directory)).toEqual(["download"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("routes record search, append-only preview/commit and CSV download under a base path", async () => {
  vi.stubEnv("ARTIFACT_SITE_TOKEN", "records-token");
  const calls: { url: URL; body: unknown }[] = [];
  const client = new ArtifactSiteClient({ baseUrl: "https://app.example/mounted", token: "records-token", fetch: (async (url, init) => {
    const parsed = new URL(String(url)); calls.push({ url: parsed, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (parsed.pathname.endsWith("/export")) return new Response('\uFEFF"n"\r\n"42"\r\n', { headers: { "content-type": "text/csv" } });
    return Response.json({ versionId: "v1", imported: 1 });
  }) as typeof fetch });
  const io = { out: vi.fn(), err: vi.fn(), stdin: async () => '[{"n":42}]' };
  const cli = (...args: string[]) => run(["--base", client.baseUrl, "--json", ...args], io, () => client);
  const filter = '{"field":"n","value":42}';
  expect(await cli("records", "list", "s", "entries", "--query", "42", "--filter", filter)).toBe(0);
  expect(calls[0].url.pathname).toBe("/mounted/api/sites/s/collections/entries/records");
  expect(calls[0].url.searchParams.get("filter")).toBe(filter);
  const args = ["records", "import", "s", "entries", "-", "--expected-version", "v1", "--operation-key", "stable-import"];
  expect(await cli(...args, "--validate-only")).toBe(0);
  expect(await cli(...args)).toBe(0);
  expect(calls[1].body).toEqual({ rows: [{ n: 42 }], operationKey: "stable-import", validateOnly: true });
  expect(calls[2].body).toEqual({ rows: [{ n: 42 }], operationKey: "stable-import", validateOnly: false });
  expect(calls[2].url.searchParams.get("expected_version")).toBe("v1");
  const directory = await mkdtemp(join(tmpdir(), "records-export-")), out = join(directory, "records.csv");
  try {
    expect(await cli("records", "export", "s", "entries", "--out", out, "--filter", filter)).toBe(0);
    expect(calls[3].url.searchParams.get("filter")).toBe(filter);
    expect(await readFile(out, "utf8")).toContain('"42"');
  } finally { await rm(directory, { recursive: true, force: true }); }
  expect(io.err).not.toHaveBeenCalled();
});
