// Integration test against a REAL S3/COS bucket. Skipped unless ARTIFACT_S3_BUCKET is set, so it
// never runs in CI. Run manually:
//   ARTIFACT_S3_ENDPOINT=... ARTIFACT_S3_REGION=... ARTIFACT_S3_BUCKET=... \
//   ARTIFACT_S3_ACCESS_KEY_ID=... ARTIFACT_S3_SECRET_ACCESS_KEY=... \
//   npx vitest run test/storage-s3.integration.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { S3Storage, __resetS3CacheForTests } from "@/lib/storage-s3";
import { HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { u8 } from "./helpers";

const live = Boolean(process.env.ARTIFACT_S3_BUCKET);

describe.skipIf(!live)("S3Storage — live COS round-trip", () => {
  const storage = live ? new S3Storage() : (null as unknown as S3Storage);
  const S = "site_s3it";
  const V1 = "ver_s3it_1";
  const V2 = "ver_s3it_2";

  afterAll(async () => {
    if (live) await storage.removeSite(S).catch(() => {});
  });

  it("downloads a private object through a signed attachment URL", async () => {
    const bytes = u8("signed original archive");
    await storage.writeFileToVersion(S, "ver_signed", "original.zip", bytes);
    const url = await storage.downloadUrl(S, "ver_signed", "original.zip", "资料.zip", "application/zip");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("资料.zip"));
    const unsigned = new URL(url); unsigned.search = "";
    expect((await fetch(unsigned)).ok).toBe(false);
  });

  it("caches a version ZIP outside source listings and removes it with the version/site", async () => {
    let builds = 0;
    const build = async () => { builds++; return u8("cached ZIP"); };
    const url = await storage.exportDownloadUrl(S, "ver_export", "site.zip", build);
    await storage.exportDownloadUrl(S, "ver_export", "renamed.zip", build);
    expect(builds).toBe(1);
    expect(await (await fetch(url)).text()).toBe("cached ZIP");
    expect(await storage.list(S, "ver_export")).toEqual([]);
    expect((await storage.listStoredVersions()).some(v => v.siteId === S && v.versionId === "ver_export")).toBe(true);
    await storage.removeVersion(S, "ver_export");
    expect((await fetch(url)).status).toBe(404);
    const again = await storage.exportDownloadUrl(S, "ver_export", "site.zip", build);
    expect(builds).toBe(2);
    await storage.removeSite(S);
    expect((await fetch(again)).status).toBe(404);
  });

  it("private comment images round-trip outside the version namespace", async () => {
    const id = `attachment-s3it-${Date.now()}`;
    try {
      for (const mimeType of ["image/png", "image/jpeg"] as const) {
        await storage.writeCommentAttachment(id, u8("private raster"), mimeType);
        const metadata=await (storage as unknown as {client:S3Client}).client.send(new HeadObjectCommand({Bucket:process.env.ARTIFACT_S3_BUCKET,Key:`comment-attachments/${id}`}));
        expect(metadata.ContentType).toBe(mimeType);
      }
      expect(Buffer.from(await storage.readCommentAttachment(id)).toString()).toBe("private raster");
      await expect(storage.readCommentAttachment("../sites/secret")).rejects.toThrow();
      await storage.removeCommentAttachment(id);
      await expect(storage.readCommentAttachment(id)).rejects.toThrow();
    } finally { await storage.removeCommentAttachment(id); }
  });

  it("a zero-byte object reads as an empty range, like the local backend (S3 answers 416 to any byte range on it)", async () => {
    await storage.writeFileToVersion(S, "ver_s3it_zero", "empty.txt", new Uint8Array(0));
    const slice = await storage.readRange(S, "ver_s3it_zero", "empty.txt", 0, 1023);
    expect(slice.total).toBe(0);
    expect(slice.bytes.byteLength).toBe(0);
    // A range that starts past the object's end is still an error: only the zero-byte case is normalised.
    await storage.writeFileToVersion(S, "ver_s3it_zero", "one.txt", u8("x"));
    await expect(storage.readRange(S, "ver_s3it_zero", "one.txt", 5, 9)).rejects.toThrow();
  });

  it("write → measure → list → stat → read → copy → remove", async () => {
    const files = [
      { relpath: "index.html", bytes: u8("<h1>s3 hi</h1>") },
      { relpath: "assets/app.js", bytes: u8("console.log('cos')") },
      { relpath: "a b.txt", bytes: u8("space in name") }, // exercises CopySource encoding
    ];
    const written = await storage.writeVersionFiles(S, V1, files);
    expect(written.fileCount).toBe(3);

    const measured = await storage.measureVersion(S, V1);
    expect(measured.fileCount).toBe(3);
    expect(measured.byteSize).toBe(files.reduce((n, f) => n + f.bytes.byteLength, 0));

    expect(await storage.list(S, V1)).toEqual(["a b.txt", "assets/app.js", "index.html"]);

    // listStoredVersions (for the orphan reconciler) surfaces this version tree
    const stored = await storage.listStoredVersions();
    const mine = stored.find((v) => v.siteId === S && v.versionId === V1);
    expect(mine).toBeTruthy();
    expect(mine!.newestMtime).toBeGreaterThan(0);

    expect(await storage.stat(S, V1, "index.html")).toBe("file");
    expect(await storage.stat(S, V1, "assets")).toBe("directory");
    expect(await storage.stat(S, V1, "nope.txt")).toBe("missing");

    // read (bypassing cache to hit COS directly)
    __resetS3CacheForTests();
    expect(Buffer.from(await storage.read(S, V1, "assets/app.js")).toString()).toBe("console.log('cos')");
    // second read is cache-served (same bytes)
    expect(Buffer.from(await storage.read(S, V1, "assets/app.js")).toString()).toBe("console.log('cos')");

    // server-side copy into a new version (incl. the spaced filename)
    await storage.copyVersionTree(S, V1, V2);
    expect(await storage.list(S, V2)).toEqual(["a b.txt", "assets/app.js", "index.html"]);
    expect(Buffer.from(await storage.read(S, V2, "a b.txt")).toString()).toBe("space in name");

    // path guard still applies on the S3 path
    await expect(storage.read(S, V1, "../../../etc/passwd")).rejects.toThrow();

    // remove one version, then the whole site
    await storage.removeVersion(S, V1);
    expect(await storage.stat(S, V1, "index.html")).toBe("missing");
    await storage.removeSite(S);
    expect(await storage.stat(S, V2, "index.html")).toBe("missing");
  });
});

it.skipIf(!live)("package-mode S3 preserves repository paths through copy without relaxing website mode", async () => {
  const storage = new S3Storage("package"), site = "site_s3_package_paths";
  try {
    for (const file of [".git/config", "node_modules/lib/style.css"]) {
      await storage.writeFileToVersion(site, "ver_a", file, u8("data"));
      expect((await storage.readRange(site, "ver_a", file, 0, 1)).total).toBe(4);
      await expect(new S3Storage().read(site, "ver_a", file)).rejects.toThrow();
    }
    await storage.copyVersionTree(site, "ver_a", "ver_b");
    expect(await storage.list(site, "ver_b")).toEqual([".git/config", "node_modules/lib/style.css"]);
    expect(Buffer.from(await storage.read(site, "ver_b", ".git/config")).toString()).toBe("data");
    await expect(storage.writeFileToVersion(site, "ver_b", "../escape", u8("x"))).rejects.toThrow();
  } finally { await storage.removeSite(site); }
});
