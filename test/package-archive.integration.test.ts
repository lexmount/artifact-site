import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUploadSession, recordUploadedFile } from "@/lib/upload-session";
import { getStorage } from "@/lib/storage";
import { preparePackage, versionStream } from "@/lib/package-processing";
import { PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { makeZip } from "./helpers";

async function archive(bytes: Uint8Array, name: string) {
  const session = await createUploadSession({ ownerKey: "a:archive", packageOptions: { source: "archive", name } });
  await getStorage().writeFileToVersion(session.siteId, session.versionId, PACKAGE_ORIGINAL, bytes);
  await recordUploadedFile(session, PACKAGE_ORIGINAL, bytes.length, createHash("sha256").update(bytes).digest("hex"));
  return session;
}
describe.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("native archive reader", () => {
  it("uploads validated entries with bounded parallelism after local extraction", async () => {
    vi.stubEnv("ARTIFACT_PACKAGE_UPLOAD_CONCURRENCY", "3");
    const files = Object.fromEntries(Array.from({length:12}, (_,i) => [`file-${i}.txt`, String(i)]));
    const session = await archive(makeZip(files), "parallel.zip");
    const storage = getStorage("package"), write = storage.writeStreamToVersion.bind(storage);
    let active = 0, peak = 0;
    const spy = vi.spyOn(storage, "writeStreamToVersion").mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 10)); return await write(...args); }
      finally { active--; }
    });
    try {
      const stages: string[] = [];
      const meta = await preparePackage(session, "en", async p => { stages.push(p.stage); });
      expect(meta.files).toHaveLength(12); expect(peak).toBe(3);
      expect(stages.indexOf("extracting")).toBeLessThan(stages.indexOf("uploading_preview_files"));
      expect(stages.at(-1)).toBe("publishing");
    } finally { spy.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("extracts ZIP once while retaining byte-identical original and empty directories", async () => {
    const bytes = makeZip({ "reports/index.html": "<title>one</title>", "second.htm": "two", "empty/": "", "data.bin": "binary", "资料/说明.txt": "中文" });
    const session = await archive(bytes, "资料.zip");
    const meta = await preparePackage(session);
    expect(meta.files).toHaveLength(4); expect(meta.directories).toContain("empty");
    expect(new Uint8Array(await new Response(versionStream(session.siteId, session.versionId, PACKAGE_ORIGINAL, bytes.length)).arrayBuffer())).toEqual(bytes);
    expect(meta.archive?.name).toBe("资料.zip");
  });
  it("extracts real 7z with nested paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "package-fixture-"));
    try {
      await mkdir(path.join(dir, "empty")); await writeFile(path.join(dir, "index.html"), "7z content");
      const tar = process.env.BSDTAR || (process.platform === "darwin" ? "/opt/homebrew/opt/libarchive/bin/bsdtar" : "bsdtar");
      execFileSync(tar, ["--format=7zip", "-cf", path.join(dir, "test.7z"), "index.html", "empty"], { cwd: dir });
      const meta = await preparePackage(await archive(await readFile(path.join(dir, "test.7z")), "test.7z"));
      expect(meta.files[0].path).toBe("index.html"); expect(meta.directories).toContain("empty");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["stored", "multiple_files_solid"])("extracts a real RAR5 %s archive", async suffix => {
    const bytes = await readFile(`test/fixtures/archives/test_read_format_rar5_${suffix}.rar`);
    const meta = await preparePackage(await archive(bytes, "original.rar"));
    expect(meta.files.length).toBeGreaterThan(0);
    expect(meta.archive?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
  it.each(["encrypted", "symlink"])("rejects RAR5 %s", async suffix => {
    const bytes = await readFile(`test/fixtures/archives/test_read_format_rar5_${suffix}.rar`);
    await expect(preparePackage(await archive(bytes, "original.rar"))).rejects.toThrow();
  });
  it("rejects ZIP64 and multipart ZIP directory records", async () => {
    const bytes = Buffer.from(makeZip({ "index.html": "page" }));
    const end = bytes.length - 22;
    const split = Buffer.from(bytes); split.writeUInt16LE(1, end + 4);
    await expect(preparePackage(await archive(split, "split.zip"))).rejects.toThrow(/Multi-volume/);
    const zip64 = Buffer.from(bytes); zip64.writeUInt32LE(0xffffffff, end + 16);
    await expect(preparePackage(await archive(zip64, "large.zip"))).rejects.toThrow(/ZIP64/);
  });
  it("enforces actual expanded bytes and entry count", async () => {
    const bytes = makeZip({ "first.txt": "x".repeat(4096), "second.txt": "y".repeat(4096) });
    const session = await archive(bytes, "bounded.zip");
    try {
      vi.stubEnv("ARTIFACT_MAX_BYTES", "5000");
      await expect(preparePackage(session)).rejects.toThrow();
      vi.stubEnv("ARTIFACT_MAX_BYTES", "300000000");
      vi.stubEnv("ARTIFACT_MAX_FILES", "1");
      await expect(preparePackage(session)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects traversal before writing and corrupted archives", async () => {
    await expect(preparePackage(await archive(makeZip({ "../evil.html": "x" }), "bad.zip"))).rejects.toThrow();
    await expect(preparePackage(await archive(Buffer.from("broken"), "bad.zip"))).rejects.toThrow();
  });
});

it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("releases extraction capacity after rejecting unread large output", async () => {
  const session = await archive(makeZip({ "first.txt": "a".repeat(256 * 1024), "second.txt": "b".repeat(256 * 1024) }), "large-output.zip");
  try {
    vi.stubEnv("ARTIFACT_MAX_FILES", "1");
    for (let attempt = 0; attempt < 3; attempt++) await expect(preparePackage(session)).rejects.toThrow(/Too many package entries/);
  } finally { vi.unstubAllEnvs(); }
  const meta = await preparePackage(await archive(makeZip({ "ok.txt": "ready" }), "ready.zip"));
  expect(meta.files).toEqual([{ path: "ok.txt", size: 5 }]);
}, 10000);

it.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("retains hidden archive files without rejecting the entire package", async () => {
  const files = { ".git/config": "synthetic", "node_modules/lib/app.js": "export default 1;", "runs/.manager.lock": "", "runs/.credential.key": "synthetic fixture", ".reports/index.html": "<h1>Hidden report</h1>", ".empty/": "" };
  const bytes = makeZip(files);
  const session = await archive(bytes, "workspace.zip");
  const meta = await preparePackage(session);
  expect(meta.files.map(file => file.path)).toEqual(Object.keys(files).filter(name => !name.endsWith("/")));
  expect(meta.directories).toContain(".empty");
  expect(Buffer.from(await getStorage().read(session.siteId, session.versionId, "runs/.credential.key")).toString()).toBe("synthetic fixture");
  expect(Buffer.from(await getStorage().read(session.siteId, session.versionId, PACKAGE_ORIGINAL))).toEqual(Buffer.from(bytes));
});

import { tarFixture } from "./tar-fixture";
import { gzipSync } from "node:zlib";
describe.skipIf(process.env.ARCHIVE_INTEGRATION !== "1")("TAR packages", () => {
  it.each(["tar", "tar.gz", "tgz"])("extracts %s including root markers, hidden files and empty directories", async ext => {
    const bytes = tarFixture([{ name: "./", type: "5" }, { name: "./.hidden/", type: "5" }, { name: "./.hidden/index.html", content: "<h1>Report</h1>" }, { name: "./empty/", type: "5" }, { name: "./.lock" }, { name: "./资料.txt", content: "notes" }], ext !== "tar");
    const session = await archive(bytes, `report.${ext}`);
    const meta = await preparePackage(session);
    expect(meta.files.map(file => file.path)).toEqual([".hidden/index.html", ".lock", "资料.txt"]);
    expect(meta.directories).toEqual([".hidden", "empty"]);
    expect(meta.archive?.format).toBe(ext === "tgz" ? "tar.gz" : ext);
    expect(Buffer.from(await getStorage().read(session.siteId, session.versionId, PACKAGE_ORIGINAL))).toEqual(bytes);
  });
  it.each(["1", "2", "3", "4", "6"])("rejects linked and special TAR entries (%s)", async type => {
    await expect(preparePackage(await archive(tarFixture([{ name: "unsafe", type, link: "target" }]), "unsafe.tar"))).rejects.toThrow();
  });
  it.each(["../escape", "/absolute", ".artifact-package/original", "a/../../escape"])("rejects unsafe TAR paths: %s", async name => {
    await expect(preparePackage(await archive(tarFixture([{ name, content: "bad" }], true), "unsafe.tgz"))).rejects.toThrow();
  });
  it("rejects format mismatches, plain gzip, damaged headers and damaged gzip", async () => {
    const tar = tarFixture([{ name: "file.txt", content: "content" }]);
    const compressed = gzipSync(tar);
    const damaged = Buffer.from(tar); damaged[0] ^= 1;
    const badGzip = Buffer.from(compressed); badGzip[badGzip.length - 8] ^= 1;
    for (const [bytes, name] of [[tar, "wrong.tgz"], [compressed, "wrong.tar"], [gzipSync(Buffer.from("plain text")), "plain.tar.gz"], [damaged, "broken.tar"], [badGzip, "broken.tgz"], [compressed.subarray(0, compressed.length - 4), "truncated.tgz"], [tar.subarray(0, 515), "truncated.tar"], [gzipSync(makeZip({ "index.html": "page" })), "zip.tar.gz"]] as const) {
      await expect(preparePackage(await archive(bytes, name))).rejects.toThrow();
    }
  });
  it.each(["pax", "gnutar"])("accepts %s long paths from a real TAR writer", async format => {
    const dir = await mkdtemp(path.join(tmpdir(), "tar-format-"));
    try {
      const name = "nested/" + "report-".repeat(24) + ".html";
      await mkdir(path.join(dir, "nested")); await writeFile(path.join(dir, name), "<h1>Long path</h1>");
      const tar = process.env.BSDTAR || (process.platform === "darwin" ? "/opt/homebrew/opt/libarchive/bin/bsdtar" : "bsdtar");
      execFileSync(tar, [`--format=${format}`, "-cf", path.join(dir, "test.tar"), name], { cwd: dir });
      const meta = await preparePackage(await archive(await readFile(path.join(dir, "test.tar")), "test.tar"));
      expect(meta.files.map(file => file.path)).toEqual([name]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects empty TARs, duplicate paths and file/directory collisions", async () => {
    for (const entries of [[], [{ name: "a" }, { name: "a" }], [{ name: "a" }, { name: "a/b" }]]) {
      await expect(preparePackage(await archive(tarFixture(entries), "invalid.tar"))).rejects.toThrow();
    }
  });
  it("does not mistake a TAR filename for a ZIP signature", async () => {
    const meta = await preparePackage(await archive(tarFixture([{ name: "PK-report.txt", content: "text" }]), "report.tar"));
    expect(meta.files[0].path).toBe("PK-report.txt");
  });
  it("bounds gzip container padding independently of payload bytes", async () => {
    const bytes = gzipSync(Buffer.concat([tarFixture([{ name: "tiny.txt" }]), Buffer.alloc(2 * 1024 * 1024)]));
    const session = await archive(bytes, "padding.tgz");
    try {
      vi.stubEnv("ARTIFACT_MAX_BYTES", "4096"); vi.stubEnv("ARTIFACT_MAX_FILES", "1");
      await expect(preparePackage(session)).rejects.toThrow(/container size limit/);
    } finally { vi.unstubAllEnvs(); }
  });
  it("enforces decompressed TAR limits", async () => {
    const session = await archive(tarFixture([{ name: "large.txt", content: "x".repeat(8192) }], true), "large.tgz");
    try {
      vi.stubEnv("ARTIFACT_MAX_BYTES", "4096");
      await expect(preparePackage(session)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
});
