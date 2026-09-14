// Integration test against a REAL S3/COS bucket. Skipped unless ARTIFACT_S3_BUCKET is set, so it
// never runs in CI. Run manually:
//   ARTIFACT_S3_ENDPOINT=... ARTIFACT_S3_REGION=... ARTIFACT_S3_BUCKET=... \
//   ARTIFACT_S3_ACCESS_KEY_ID=... ARTIFACT_S3_SECRET_ACCESS_KEY=... \
//   npx vitest run test/storage-s3.integration.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { S3Storage, __resetS3CacheForTests } from "@/lib/storage-s3";
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

  it("a zero-byte object reads as an empty range, like the local backend (S3 answers 416 to any byte range on it)", async () => {
    await storage.writeFileToVersion(S, V2, "empty.txt", new Uint8Array(0));
    const slice = await storage.readRange(S, V2, "empty.txt", 0, 1023);
    expect(slice.total).toBe(0);
    expect(slice.bytes.byteLength).toBe(0);
    // A range that starts past the object's end is still an error: only the zero-byte case is normalised.
    await storage.writeFileToVersion(S, V2, "one.txt", u8("x"));
    await expect(storage.readRange(S, V2, "one.txt", 5, 9)).rejects.toThrow();
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
