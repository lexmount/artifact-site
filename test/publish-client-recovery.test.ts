import { runNextPackageJob } from "@/lib/package-jobs";
import { GET as me } from "@/app/api/auth/me/route";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { ArtifactSiteClient } from "../cli/src/client";
import { publishPath, updateFromPath } from "../cli/src/publish";
import { POST as create } from "@/app/api/sites/route";
import { POST as open } from "@/app/api/uploads/route";
import { POST as commit } from "@/app/api/uploads/[versionId]/commit/route";
import { GET as progress } from "@/app/api/uploads/[versionId]/route";
import { GET as operation } from "@/app/api/operations/[key]/route";
import { PUT as chunk } from "@/app/api/uploads/[versionId]/chunks/route";
import { PUT as put } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { rbacQuery } from "@/lib/db";
let token: string;
let dir: string, transfers: string[], failFile: boolean, loseCommit: boolean, gateway: boolean, legacy: boolean, previousPackageServer: boolean;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "publish-acceptance-"));
  vi.stubEnv("ARTIFACT_SITE_CONFIG_DIR", path.join(dir, "config"));
  token = `acceptance-secret-${path.basename(dir)}`;
  vi.stubEnv("PUBLISH_API_TOKEN", token);
  __resetRateLimitForTests();
  transfers = []; failFile = false; loseCommit = false; gateway = false; legacy = false; previousPackageServer = false;
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const transport: typeof fetch = async (input, init) => {
  const request = new Request(input, init); const route = new URL(request.url).pathname.split("/");
  if (route[2] === "auth") {
    const response = await me(request);
    if (!legacy && !previousPackageServer) return response;
    const body = await response.json();
    delete body.uploadLimits.archiveChunks;
    delete body.uploadLimits.archiveChunkBytes;
    delete body.uploadLimits.asyncPackages;
    delete body.uploadLimits.packagePaths;
    if (legacy) delete body.uploadLimits.packageUploads;
    return Response.json(body);
  }
  if (route[2] === "operations") return operation(request, { params: Promise.resolve({ key: decodeURIComponent(route[3]) }) });
  if (route[2] === "sites") {
    if (request.method === "GET" && route[3]) {
      const { GET } = await import("@/app/api/sites/[slug]/route");
      return GET(request, { params: Promise.resolve({ slug: route[3] }) });
    }
    // Model the HTTP transport: give the app a byte-backed stream, not undici's multipart producer.
    const bytes = await request.arrayBuffer();
    const buffered = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
    return gateway ? new Response("proxy error", { status: 413 }) : create(buffered);
  }
  if (!route[3]) {
    if (previousPackageServer) {
      const body = await request.clone().json();
      if (JSON.stringify(body).match(/\.git|node_modules|\.hidden/)) return Response.json({ error: "Unsupported package path" }, { status: 400 });
    }
    return open(request);
  }
  const versionId = route[3]; const context = { params: Promise.resolve({ versionId }) };
  if (route[4] === "commit") {
    const response = await commit(request, context);
    if (loseCommit) { loseCommit = false; throw new TypeError("Connection lost after commit"); }
    return response;
  }
  if (route[4] === "chunks") {
    transfers.push("original");
    return chunk(request, context);
  }
  if (route[4] === "files") {
    const relpath = route.slice(5).map(decodeURIComponent); transfers.push(relpath.join("/"));
    if (failFile && transfers.length === 2) { failFile = false; throw new TypeError("Connection lost during transfer"); }
    return put(request, { params: Promise.resolve({ versionId, relpath }) });
  }
  await runNextPackageJob();
  return progress(request, context);
};
const client = () => new ArtifactSiteClient({ baseUrl: "http://localhost", token, fetch: transport, retries: 0 });
async function tree(images = 2, bytes = 1000) {
  const root = path.join(dir, "site"); await mkdir(root);
  await writeFile(path.join(root, "index.html"), "<h1>Photo report</h1>");
  for (let i = 0; i < images; i++) await writeFile(path.join(root, `photo-${i}.jpg`), Buffer.alloc(bytes, i));
  return root;
}
it("publishes 108 images totaling over 27 MB through individual requests", async () => {
  vi.stubEnv("ARTIFACT_RATE_LIMIT", "on"); vi.stubEnv("ARTIFACT_RATE_LIMIT_BURST", "10");
  const root = await tree(108, 265000);
  const result = await publishPath(client(), root, { share: false });
  expect(result.route).toBe("chunked"); expect(transfers).toHaveLength(109);
  const rows = await rbacQuery("SELECT file_count,byte_size FROM versions WHERE id=$1", [(result.site as { versionId: string }).versionId]);
  expect(Number(rows[0].file_count)).toBe(109); expect(Number(rows[0].byte_size)).toBeGreaterThan(27_000_000);
});
it("resumes an interrupted directory in a fresh client without re-uploading completed files", async () => {
  vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "100"); const root = await tree(); failFile = true;
  await expect(publishPath(client(), root, { share: false })).rejects.toThrow("Connection lost");
  const result = await publishPath(client(), root, { share: false }); expect(result.site.slug).toBeTruthy();
  expect(transfers.filter(f => f === "index.html")).toHaveLength(1);
  expect(await rbacQuery("SELECT id FROM sites WHERE slug=$1", [result.site.slug])).toHaveLength(1);
  for (const f of await readdir(path.join(dir, "config/uploads"))) {
    const stored = await readFile(path.join(dir, "config/uploads", f), "utf8");
    expect(stored).not.toContain(token); expect(stored).not.toContain("editToken");
  }
});
it("recovers a lost commit response without another commit or site", async () => {
  vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "100"); const root = await tree(); loseCommit = true;
  await expect(publishPath(client(), root, { share: false })).rejects.toThrow("Connection lost after commit");
  const before = transfers.length;
  const result = await publishPath(client(), root, { share: false }); expect(result.site.slug).toBeTruthy();
  expect(transfers).toHaveLength(before);
  expect(await rbacQuery("SELECT id FROM sites WHERE slug=$1", [result.site.slug])).toHaveLength(1);
});
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("preserves a ZIP and rejects traversal during server extraction", async () => {
  vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "100");
  const zip = path.join(dir, "report.zip"); await writeFile(zip, zipSync({ "index.html": Buffer.from("<h1>ZIP</h1>"), "image.jpg": Buffer.alloc(5000) }, { level: 0 }));
  expect((await publishPath(client(), zip, { share: false })).route).toBe("chunked");
  const bad = path.join(dir, "bad.zip"); await writeFile(bad, zipSync({ "../escape.html": Buffer.from("bad") }));
  const before = transfers.length; await expect(publishPath(client(), bad, { share: false })).rejects.toThrow(/unsafe|Unsupported|escape/i); expect(transfers).toHaveLength(before + 1);
});
it("switches only on an application-confirmed no-effect 413", async () => {
  legacy = true;
  vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "500");
  const root = await tree(); const result = await publishPath(client(), root, { share: false }); expect(result.route).toBe("chunked");
  gateway = true; const count = transfers.length;
  await expect(publishPath(client(), root, { share: false, title: "gateway failure" })).rejects.toMatchObject({ status: 413 }); expect(transfers).toHaveLength(count);
});
it("publishes an image-only folder as a directory", async () => {
  const root = path.join(dir, "images"); await mkdir(root); await writeFile(path.join(root, "x.jpg"), "x");
  const result = await publishPath(client(), root, { share: false });
  expect(result.site.slug).toBeTruthy(); expect(transfers).toEqual(["x.jpg"]);
});

it("restarts expired uncommitted uploads only after checking the commit result", async () => {
  vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "100"); const root = await tree(); failFile = true;
  await expect(publishPath(client(), root, { share: false })).rejects.toThrow("Connection lost");
  await rbacQuery("UPDATE upload_sessions SET created_at=1");
  const result = await publishPath(client(), root, { share: false }); expect(result.site.slug).toBeTruthy();
  expect(transfers.filter(f => f === "index.html")).toHaveLength(2);
});
it("reuses an explicit operation key but rejects changed local content", async () => {
  const root = await tree(); const options = { share: false as const, operationKey: "explicit-publication" };
  const first = await publishPath(client(), root, options);
  expect((await publishPath(client(), root, options)).site.slug).toBe(first.site.slug);
  await writeFile(path.join(root, "index.html"), "<h1>Changed</h1>");
  await expect(publishPath(client(), root, options)).rejects.toThrow("different files or parameters");
});

it("re-uploads a completed path if its stored content changed to the same length", async () => {
  vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "100"); const root = await tree(); failFile = true;
  await expect(publishPath(client(), root, { share: false })).rejects.toThrow("Connection lost");
  const [row] = await rbacQuery("SELECT version_id FROM upload_sessions ORDER BY created_at DESC LIMIT 1");
  const versionId = String(row.version_id);
  const request = new Request(`http://localhost/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers: { authorization: `Bearer ${token}`, origin: "http://localhost" }, body: "<h1>Other report</h1>" });
  await put(request, { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
  await publishPath(client(), root, { share: false });
  expect(transfers.filter(f => f === "index.html")).toHaveLength(2);
});

it("refuses a cached success after the artifact is deleted", async () => {
  const root = await tree(); const result = await publishPath(client(), root, { share: false });
  await rbacQuery("UPDATE sites SET deleted_at=$1 WHERE slug=$2", [Date.now(), result.site.slug]);
  await expect(publishPath(client(), root, { share: false })).rejects.toThrow(/no longer available.*--operation-key/);
});
// This boundary regression performs 2002 serial, authenticated uploads with database writes.
// PostgreSQL CI measured ~60s; allow headroom here without relaxing other test deadlines.
it("uses deployment upload limits instead of fixed defaults", { timeout: 180_000 }, async () => {
  vi.stubEnv("ARTIFACT_MAX_FILES", "2100"); vi.stubEnv("ARTIFACT_SITE_ONE_SHOT_LIMIT", "10000000");
  const { GET } = await import("@/app/api/auth/me/route");
  expect((await (await GET(new Request("http://localhost/api/auth/me"))).json()).uploadLimits.maxFiles).toBe(2100);
  const root = await tree(2001, 1);
  const result = await publishPath(client(), root, { share: false }); expect(result.site.slug).toBeTruthy();
  expect(transfers).toHaveLength(2002);
  const [row] = await rbacQuery("SELECT file_count FROM versions WHERE id=$1", [(result.site as { versionId: string }).versionId]);
  expect(Number(row.file_count)).toBe(2002);
});

import { tarFixture } from "./tar-fixture";
it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1").each(["tar", "tar.gz", "tgz"])("publishes a %s package through CLI and retains the original", async ext => {
  const bytes = tarFixture([{ name: ".lock" }, { name: "index.html", content: "<h1>TAR</h1>" }], ext !== "tar");
  const file = path.join(dir, `report.${ext}`); await writeFile(file, bytes);
  const result = await publishPath(client(), file, { share: false });
  expect(result.route).toBe("chunked"); expect(transfers).toEqual(["original"]);
  const { GET } = await import("@/app/api/sites/[slug]/download/route");
  const response = await GET(new Request(`http://localhost/api/sites/${result.site.slug}/download`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ slug: result.site.slug }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(ext === "tar" ? "application/x-tar" : "application/gzip");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it("uploads repository and dependency directories on package-capable servers", async () => {
  const root = await tree(0);
  await mkdir(path.join(root, ".git")); await mkdir(path.join(root, "node_modules", "lib"), { recursive: true });
  await writeFile(path.join(root, ".git", "config"), "synthetic");
  await writeFile(path.join(root, "node_modules", "lib", "style.css"), "h1{color:red}");
  const result = await publishPath(client(), root, { share: false });
  expect(transfers).toEqual(expect.arrayContaining([".git/config", "node_modules/lib/style.css"]));
  const { exportSiteZip } = await import("@/lib/sites");
  const { unzipSync } = await import("fflate");
  const exported = await exportSiteZip(result.site.slug);
  expect(Buffer.from(unzipSync(exported!.bytes)[".git/config"]).toString()).toBe("synthetic");
});

it("filters unsupported directory paths for publish and update on previous package servers", async () => {
  previousPackageServer = true;
  const root = await tree(0);
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules"));
  for (const file of [".git/config", "node_modules/code.js", ".hidden"]) await writeFile(path.join(root, file), "synthetic");
  const result = await publishPath(client(), root, { share: false });
  expect(transfers).toEqual(["index.html"]);
  transfers = [];
  await updateFromPath(client(), result.site.slug, root);
  expect(transfers).toEqual(["index.html"]);
});

it("recovers an async commit after its six-hour job expires without publishing twice", async () => {
  const root = await tree(); loseCommit = true;
  const opts = { share: false as const, operationKey: "async-expired-job-regression" };
  await expect(publishPath(client(), root, opts)).rejects.toThrow("Connection lost");
  await runNextPackageJob();
  const [job] = await rbacQuery("SELECT version_id,result FROM package_jobs WHERE state='completed' ORDER BY created_at DESC LIMIT 1");
  const result = JSON.parse(String(job.result)); const uploaded = transfers.length;
  await rbacQuery("DELETE FROM package_jobs WHERE version_id=$1", [String(job.version_id)]);
  const resumed = await publishPath(client(), root, opts);
  expect(resumed.site.slug).toBe(result.slug); expect(transfers).toHaveLength(uploaded);
});
