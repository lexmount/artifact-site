import { packageReference, packageHtml } from "@/lib/package-preview";
import { describe, expect, it, vi } from "vitest";
import { createUploadSession, recordUploadedFile } from "@/lib/upload-session";
import { preparePackage, packageLease } from "@/lib/package-processing";
import { getStorage } from "@/lib/storage";
import { commitUploadedVersion, createSite, exportSiteZip, editSite, forkSite, rollbackTo } from "@/lib/sites";
import { getVersion } from "@/lib/db";
import { PACKAGE_ENTRY, PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { servePreviewFile } from "@/lib/preview";
import { testAudit } from "./helpers";
import { unzipSync } from "fflate";

async function folder() {
  const session = await createUploadSession({ ownerKey: "a:test", title: "Reports", packageOptions: { source: "folder", directories: ["empty"] } });
  for (const [name, content] of Object.entries({ "reports/index.html": '<img src="chart.png">', "reports/other.htm": "Other", "reports/chart.png": "image", "notes.txt": "notes" })) {
    await getStorage().writeFileToVersion(session.siteId, session.versionId, name, Buffer.from(content));
    await recordUploadedFile(session, name, Buffer.byteLength(content));
  }
  const packageMeta = await preparePackage(session);
  const result = await commitUploadedVersion(new Request("http://localhost/api/uploads"), { session, entry: PACKAGE_ENTRY, packageMeta, ctx: testAudit() });
  return { result, session };
}
describe("package publication and compatibility", () => {
  it("resolves nested and root references without reaching platform paths", () => {
    const root = "/api/preview/package~key/";
    expect(packageReference("../assets/a.png", root + "reports/", root)).toBe(root + "assets/a.png");
    expect(packageReference("/assets/a.png", root + "reports/", root)).toBe(root + "assets/a.png");
    expect(packageReference("../../../api/auth/me", root + "reports/", root)).toBe("about:blank");
    expect(packageHtml('<img src="./chart.png">', "reports/index.html", root).html).toContain(root + "reports/chart.png");
  });
  it("persists metadata, excludes system files from ZIP, and preserves empty folders", async () => {
    const { result, session } = await folder();
    const version = await getVersion(session.versionId);
    expect(version?.packageMeta?.directories).toContain("empty");
    expect(version?.fileCount).toBe(4);
    const exported = await exportSiteZip(result.slug);
    const paths = Object.keys(unzipSync(exported!.bytes));
    expect(paths).toContain("empty/"); expect(paths).toContain("reports/index.html");
    expect(paths.some(p => p.startsWith(".artifact-package"))).toBe(false);
    await expect(editSite(result.slug, { path: "reports/index.html", content: "changed" }, testAudit())).rejects.toThrow(/complete new version/);
  });
  it("serves a directory and nested HTML, blocks original and explicit single-file downloads", async () => {
    const { result, session } = await folder();
    const { getSite } = await import("@/lib/db");
    const { authorizePreview } = await import("@/lib/preview-access");
    const access = await authorizePreview(new Request("http://localhost/api/preview/" + result.slug), (await getSite(session.siteId))!, null);
    expect(access?.key).toBeTruthy();
    expect(access?.versionId).toBe(session.versionId);
    const saved = Buffer.from(await getStorage().read(session.siteId, session.versionId, PACKAGE_ENTRY)).toString();
    await getStorage().writeFileToVersion(session.siteId, session.versionId, PACKAGE_ENTRY, Buffer.from(saved.replace(/<details>/g, "<details open>")));
    const directory = await servePreviewFile(result.slug, []);
    expect(String(directory.body)).not.toContain("<details open>");
    expect(directory.headers["content-security-policy"]).not.toContain("allow-downloads");
    expect(directory.status).toBe(200); expect(String(directory.body)).toContain("notes.txt");
    const page = await servePreviewFile(result.slug, ["reports", "index.html"], undefined, "/api/preview/test/");
    expect(String(page.body)).toContain('<base href="/api/preview/test/reports/">');
    expect((await servePreviewFile(result.slug, PACKAGE_ORIGINAL.split("/"))).status).not.toBe(200);
    expect((await servePreviewFile(result.slug, ["missing"])).status).toBe(404);
    expect((await servePreviewFile(result.slug, ["reports", "index.html"], undefined, "/", null, false, false, true)).status).toBe(403);
  });
  it("keeps legacy entries and SPA fallback unchanged", async () => {
    const { site, version } = await createSite({ mode: "folder", files: [{ relpath: "dist/index.html", bytes: Buffer.from("legacy") }] });
    expect(version.packageMeta).toBeUndefined(); expect(version.entry).toBe("index.html");
    expect((await servePreviewFile(site.slug, ["route"])).status).toBe(200);
  });
  it("serializes processing and always releases a failed lease", async () => {
    const session = await createUploadSession({ ownerKey: "a:lease", packageOptions: { source: "folder" } });
    await packageLease(session, async () => { await expect(packageLease(session, async () => {})).rejects.toThrow(/in progress/); });
    await expect(packageLease(session, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(packageLease(session, async () => "ready")).resolves.toBe("ready");
  });
});

it("only authorized source readers can download a retained original", async () => {
  const { GET: download } = await import("@/app/api/sites/[slug]/download/route");
  const { writePackageDirectory } = await import("@/lib/package-directory");
  const original = Buffer.from("retained original bytes");
  const session = await createUploadSession({ ownerKey: "a:download" });
  const packageMeta = { source: "archive" as const, files: [], directories: ["empty"], ignored: [], archive: { name: "资料.rar", format: "rar" as const, size: original.length, sha256: "fixture" } };
  await getStorage().writeFileToVersion(session.siteId, session.versionId, PACKAGE_ORIGINAL, original);
  await writePackageDirectory(session.siteId, session.versionId, packageMeta, "Original");
  const result = await commitUploadedVersion(new Request("http://localhost/api/uploads"), { session, entry: PACKAGE_ENTRY, packageMeta, ctx: testAudit() });
  const context = { params: Promise.resolve({ slug: result.slug }) };
  const url = `http://localhost/api/sites/${result.slug}/download?version=${session.versionId}`;
  expect((await download(new Request(url), context)).status).toBe(403);
  const response = await download(new Request(url, { headers: { "x-edit-token": result.editToken! } }), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.rar");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
  expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("资料.rar"));
  // Local storage falls back to bytes, while capable stores issue URLs only after authorization.
  const directUrl = `${url}&delivery=direct`;
  const local = await download(new Request(directUrl, { headers: { "x-edit-token": result.editToken! } }), context);
  expect(Buffer.from(await local.arrayBuffer())).toEqual(original);
  const storage = getStorage("package");
  storage.downloadUrl = vi.fn().mockResolvedValue("https://bucket.example/original?signature=test");
  try {
    expect((await download(new Request(directUrl), context)).status).toBe(403);
    expect(storage.downloadUrl).not.toHaveBeenCalled();
    const signed = await download(new Request(directUrl, { headers: { "x-edit-token": result.editToken! } }), context);
    expect(await signed.json()).toEqual({ url: "https://bucket.example/original?signature=test", expiresIn: 300 });
    expect(signed.headers.get("cache-control")).toBe("private, no-store");
    expect(storage.downloadUrl).toHaveBeenCalledWith(session.siteId, session.versionId, PACKAGE_ORIGINAL, "资料.rar", "application/vnd.rar");
    const legacy = await download(new Request(url, { headers: { "x-edit-token": result.editToken! } }), context);
    expect(Buffer.from(await legacy.arrayBuffer())).toEqual(original);
    expect(storage.downloadUrl).toHaveBeenCalledTimes(1);
  } finally { delete storage.downloadUrl; }
  const fork = await forkSite(result.slug, {}, testAudit());
  expect(fork?.version.packageMeta).toEqual(packageMeta);
  expect(fork?.version.fileCount).toBe(0);
  expect(Buffer.from(await getStorage().read(fork!.site.id, fork!.version.id, PACKAGE_ORIGINAL))).toEqual(original);
  const rolled = await rollbackTo(result.slug, session.versionId, testAudit());
  expect(rolled?.version.packageMeta).toEqual(packageMeta);
  expect(rolled?.version.fileCount).toBe(0);
  expect(Buffer.from(await getStorage().read(rolled!.site.id, rolled!.version.id, PACKAGE_ORIGINAL))).toEqual(original);
});

it("applies existing collaborator roles to package downloads", async () => {
  const { upsertUser, createId, rbacQuery } = await import("@/lib/db");
  const { mintSession } = await import("@/lib/session");
  const { putUserSiteRole } = await import("@/lib/role-bindings");
  const { GET: download } = await import("@/app/api/sites/[slug]/download/route");
  const { writePackageDirectory } = await import("@/lib/package-directory");
  const actor = async () => {
    const user = await upsertUser({ authProvider: "package-test", providerSubject: createId("actor"), email: `${createId("email")}@example.test`, emailVerified: true });
    const { cookie } = await mintSession(new Request("http://localhost"), user.id);
    return { user, cookie: cookie.split(";")[0] };
  };
  const owner = await actor(), collaborator = await actor();
  const { site } = await createSite({ mode: "folder", files: [{ relpath: "index.html", bytes: Buffer.from("old website") }] }, { ownerId: owner.user.id });
  const session = await createUploadSession({ ownerKey: `u:${owner.user.id}`, siteId: site.id, targetSlug: site.slug });
  const original = Buffer.from("original package");
  const packageMeta = { source: "archive" as const, files: [], directories: ["empty"], ignored: [], archive: { name: "source.7z", format: "7z" as const, size: original.length, sha256: "fixture" } };
  await getStorage().writeFileToVersion(site.id, session.versionId, PACKAGE_ORIGINAL, original);
  await writePackageDirectory(site.id, session.versionId, packageMeta, "Package");
  await commitUploadedVersion(new Request("http://localhost"), { session, entry: PACKAGE_ENTRY, packageMeta, ctx: testAudit() });
  const context = { params: Promise.resolve({ slug: site.slug }) };
  const request = (cookie: string) => new Request(`http://localhost/api/sites/${site.slug}/download`, { headers: { cookie } });
  expect((await download(request(owner.cookie), context)).status).toBe(200);
  const { GET: options } = await import("@/app/api/sites/[slug]/comments/options/route");
  const response = await options(new Request(`http://localhost/api/sites/${site.slug}/comments/options`, { headers: { cookie: owner.cookie } }), context);
  expect(response.status).toBe(200);
  expect((await response.json()).versions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: site.currentVersionId, packagePaths: false }),
    expect.objectContaining({ id: session.versionId, packagePaths: true }),
  ]));
  for (const [role, expected] of [["viewer", 403], ["commenter", 403], ["editor", 200], ["admin", 200]] as const) {
    await putUserSiteRole(rbacQuery, site.id, collaborator.user.id, role, owner.user.id);
    const response = await download(request(collaborator.cookie), context);
    expect(response.status, role).toBe(expected);
    if (expected === 200) expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
  }
});

it("bounds actual archive upload bytes and makes original retries immutable", async () => {
  const { vi } = await import("vitest");
  const { POST: start } = await import("@/lib/application/uploads");
  const { PUT } = await import("@/lib/application/upload-file");
  const opened = await start(new Request("http://localhost/api/uploads", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ package: { source: "archive", name: "source.zip" } }) }));
  expect(opened.status).toBe(201);
  const { versionId } = await opened.json();
  const cookie = opened.headers.get("set-cookie")!.split(";")[0];
  const context = { params: Promise.resolve({ versionId, relpath: ["original"] }) };
  const put = (body: string) => PUT(new Request(`http://localhost/api/uploads/${versionId}/files/original`, { method: "PUT", headers: { cookie, origin: "http://localhost" }, body }), context);
  try {
    vi.stubEnv("ARTIFACT_ARCHIVE_MAX_BYTES", "8");
    expect((await put("123456789")).status).toBe(400);
    expect((await put("12345678")).status).toBe(200);
    expect((await put("12345678")).status).toBe(200);
    expect((await put("different")).status).toBe(400);
    expect((await put("87654321")).status).toBe(400);
  } finally { vi.unstubAllEnvs(); }
});


it("preserves long legacy upload titles", async () => {
  const { POST: start } = await import("@/lib/application/uploads");
  const title = "A".repeat(200);
  const opened = await start(new Request("http://localhost/api/uploads", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ title }) }));
  expect(opened.status).toBe(201);
  const { getUploadSessionRow } = await import("@/lib/db");
  expect((await getUploadSessionRow((await opened.json()).versionId))?.title).toBe(title);
});

it("normalizes explicit folder directories before storing and exporting them", async () => {
  const session = await createUploadSession({ ownerKey: "a:paths", packageOptions: { source: "folder", directories: ["root\\empty", "e\u0301"] } });
  const meta = await preparePackage(session);
  expect(meta.directories).toEqual(["root/empty", "é"]);
  const html = Buffer.from(await getStorage().read(session.siteId, session.versionId, PACKAGE_ENTRY)).toString();
  expect(html).not.toContain("root\\empty");
});

it("serves MOV/M4A ranges and the sandboxed comment image viewer", async () => {
  const session = await createUploadSession({ ownerKey: "a:media", packageOptions: { source: "folder" } });
  for (const relpath of ["clip.mov", "voice.m4a", "chart.png"]) {
    await getStorage().writeFileToVersion(session.siteId, session.versionId, relpath, Buffer.from("0123456789"));
    await recordUploadedFile(session, relpath, 10);
  }
  const result = await commitUploadedVersion(new Request("http://localhost/api/uploads"), { session, entry: PACKAGE_ENTRY, packageMeta: await preparePackage(session), ctx: testAudit() });
  for (const file of ["clip.mov", "voice.m4a"]) {
    const response = await servePreviewFile(result.slug, [file], undefined, undefined, "bytes=2-5");
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
  }
  const image = await servePreviewFile(result.slug, ["chart.png"], undefined, undefined, null, true, true);
  expect(image.status).toBe(200);
  expect(image.headers["content-type"]).toContain("text/html");
  expect(image.headers["content-security-policy"]).not.toContain("allow-downloads");
  expect((await servePreviewFile(result.slug, ["chart.png"], undefined, undefined, null, false, true)).status).toBe(415);
});

it("publishes hidden folder content and previews only manifest-listed resources", async () => {
  const session = await createUploadSession({ ownerKey: "a:hidden", packageOptions: { source: "folder", directories: [".empty"] } });
  const files = { ".reports/index.html": "<h1>Hidden report</h1>", ".reports/style.css": "h1{color:red}", ".credential.key": "synthetic", ".manager.lock": "" };
  for (const [name, content] of Object.entries(files)) {
    await getStorage().writeFileToVersion(session.siteId, session.versionId, name, Buffer.from(content));
    await recordUploadedFile(session, name, Buffer.byteLength(content));
  }
  const packageMeta = await preparePackage(session);
  const result = await commitUploadedVersion(new Request("http://localhost/api/uploads"), { session, entry: PACKAGE_ENTRY, packageMeta, ctx: testAudit() });
  expect(packageMeta.files).toHaveLength(4);
  expect(String((await servePreviewFile(result.slug, [])).body)).toContain(".credential.key");
  const html = await servePreviewFile(result.slug, [".reports", "index.html"]);
  expect(html.status).toBe(200);
  expect(html.headers["content-security-policy"]).not.toContain("allow-downloads");
  expect((await servePreviewFile(result.slug, [".reports", "style.css"])).status).toBe(200);
  expect((await servePreviewFile(result.slug, [".credential.key"])).status).toBe(415);
  await getStorage().writeFileToVersion(session.siteId, session.versionId, ".unlisted.html", Buffer.from("not listed"));
  expect((await servePreviewFile(result.slug, [".unlisted.html"])).status).toBe(404);
  expect((await servePreviewFile(result.slug, PACKAGE_ORIGINAL.split("/"))).status).not.toBe(200);
  const legacy = await createSite({ mode: "folder", files: [{ relpath: "index.html", bytes: Buffer.from("legacy") }, { relpath: ".hidden.html", bytes: Buffer.from("hidden") }] });
  expect((await servePreviewFile(legacy.site.slug, [".hidden.html"])).status).not.toBe(200);
});

it("preserves repository/dependency files through preview, export, fork and rollback", async () => {
  const session = await createUploadSession({ ownerKey: "a:workspace", packageOptions: { source: "folder" } });
  const storage = getStorage("package");
  const files = { "index.html": '<link rel="stylesheet" href="/node_modules/lib/style.css"><h1>Workspace</h1>', ".git/config": "synthetic repository config", ".git/report.html": "<h1>Repository report</h1>", "node_modules/lib/style.css": "h1{color:red}" };
  for (const [name, content] of Object.entries(files)) {
    await storage.writeFileToVersion(session.siteId, session.versionId, name, Buffer.from(content));
    await recordUploadedFile(session, name, Buffer.byteLength(content));
  }
  const packageMeta = await preparePackage(session);
  const result = await commitUploadedVersion(new Request("http://localhost/api/uploads"), { session, entry: PACKAGE_ENTRY, packageMeta, ctx: testAudit() });
  expect(packageMeta.files).toHaveLength(4);
  const { prepareCommentEvidence } = await import("@/lib/comments/evidence");
  const { getSite } = await import("@/lib/db");
  const evidence = await prepareCommentEvidence((await getSite(session.siteId))!, (await getVersion(session.versionId))!, { schemaVersion: 1, kind: "html", filePath: ".git/report.html", selector: "h1", viewport: { width: 800, height: 600 }, quote: { exact: "Repository report" } });
  expect(evidence.excerpt).toContain("Repository report");
  expect(String((await servePreviewFile(result.slug, [])).body)).toContain(".git");
  expect((await servePreviewFile(result.slug, ["node_modules", "lib", "style.css"])).status).toBe(200);
  expect((await servePreviewFile(result.slug, [".git", "config"])).status).toBe(415);
  expect(packageReference("/node_modules/lib/style.css", "/api/preview/test/", "/api/preview/test/")).toBe("/api/preview/test/node_modules/lib/style.css");
  const exported = await exportSiteZip(result.slug);
  expect(Buffer.from(unzipSync(exported!.bytes)[".git/config"]).toString()).toBe(files[".git/config"]);
  const fork = await forkSite(result.slug, {}, testAudit());
  expect(Buffer.from(await storage.read(fork!.site.id, fork!.version.id, ".git/config")).toString()).toBe(files[".git/config"]);
  const rolled = await rollbackTo(result.slug, session.versionId, testAudit());
  expect((await servePreviewFile(result.slug, ["node_modules", "lib", "style.css"], rolled!.version.id)).status).toBe(200);
});

it("uses the same authorized direct-download flow for HTML site ZIP exports", async () => {
  const { GET: download } = await import("@/app/api/sites/[slug]/download/route");
  const site = await createSite({ mode: "folder", title: "HTML export", files: [{ relpath: "index.html", bytes: Buffer.from("<h1>Saved HTML</h1>") }] });
  const storage = getStorage("package");
  storage.exportDownloadUrl = vi.fn(async (_site, _version, _filename, build) => {
    const zip = unzipSync(await build());
    expect(Buffer.from(zip["index.html"]).toString()).toContain("Saved HTML");
    return "https://bucket.example/source.zip?signature=test";
  });
  try {
    const context = { params: Promise.resolve({ slug: site.site.slug }) };
    const url = `http://localhost/api/sites/${site.site.slug}/download?delivery=direct`;
    expect((await download(new Request(url), context)).status).toBe(403);
    expect(storage.exportDownloadUrl).not.toHaveBeenCalled();
    const response = await download(new Request(url, { headers: { "x-edit-token": site.site.editToken } }), context);
    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("source.zip");
    expect(storage.exportDownloadUrl).toHaveBeenCalledOnce();
  } finally { delete storage.exportDownloadUrl; }
});
