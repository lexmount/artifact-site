// Actual Node CLI processes, production HTTP routes and a one-response network fault.
// Gated separately so unit tests never contact a deployment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const base = process.env.PUBLISH_E2E_URL;
const token = process.env.PUBLISH_E2E_TOKEN;
describe.skipIf(!base || !token)("production publication recovery", () => {
  let dir: string, proxy: Server, proxyUrl: string;
  let drop = true, commits = 0, files = 0;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "publish-http-recovery-"));
    proxy = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url!, base);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value && !["host", "connection", "transfer-encoding"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        headers.set("origin", new URL(base!).origin);
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
        const response = await fetch(url, { method: incoming.method, headers, body: incoming.method === "GET" ? undefined : Buffer.concat(chunks) });
        const body = new Uint8Array(await response.arrayBuffer());
        if (url.pathname.endsWith("/commit")) {
          commits++;
          if (drop && response.ok) { drop = false; incoming.socket.destroy(); return; }
        }
        if (url.pathname.includes("/files/")) files++;
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => { if (!["connection", "transfer-encoding", "content-encoding", "content-length"].includes(name)) outgoing.setHeader(name, value); });
        outgoing.end(body);
      } catch { outgoing.destroy(); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    await mkdir(path.join(dir, "site"));
    await writeFile(path.join(dir, "site/index.html"), "<h1>Recovery acceptance</h1>");
    for (let i = 0; i < 108; i++) await writeFile(path.join(dir, `site/photo-${i}.jpg`), Buffer.alloc(265000, i));
  });
  afterAll(async () => { if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); } if (dir) await rm(dir, { recursive: true, force: true }); });
  const run = () => new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["cli/bin/artifact-site.js", "--json", "publish", path.join(dir, "site"), "--share", "none"], {
      env: { ...process.env, ARTIFACT_SITE_URL: proxyUrl, ARTIFACT_SITE_TOKEN: token, ARTIFACT_SITE_CONFIG_DIR: path.join(dir, "config") }, timeout: 90000, encoding: "utf8",
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  it("recovers 108 images in a fresh process after the successful commit response is dropped", async () => {
    const first = await run(); expect(first.error).not.toBeNull(); expect(drop).toBe(false);
    const transferred = files;
    const second = await run(); expect(second.error, second.stderr).toBeNull();
    const published = JSON.parse(second.stdout); expect(published.slug).toBeTruthy();
    expect(commits).toBe(1); expect(files).toBe(transferred); expect(files).toBe(109);
    const info = await fetch(`${base}/api/sites/${published.slug}`, { headers: { authorization: `Bearer ${token}` } });
    expect(info.status).toBe(200); expect((await info.json()).files).toHaveLength(109);
  }, 120000);
});
