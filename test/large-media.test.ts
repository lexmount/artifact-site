// Hosting large projects with video — two things must hold:
//   1. uploads no longer read the file into memory (otherwise one upload can take the whole service
//      down — this actually happened in production: the process restarted and everyone got 503s
//      meanwhile);
//   2. media can be fetched by byte range (otherwise a video must fully download before it plays,
//      and the progress bar cannot be dragged).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRangeHeader, servePreviewFile } from "@/lib/preview";
import { getStorage } from "@/lib/storage";
import * as db from "@/lib/db";
import { errorResponse } from "@/app/api/_util";
import { getCurrentVersion, getSiteBySlug } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { beginUploadedFile, createUploadSession, assertSessionRoom, recordUploadedFile, getUploadSession, discardUploadSession, resetUploadSessionsForTests, sweepExpiredSessions, UPLOAD_SESSION_TTL_MS } from "@/lib/upload-session";

const bodyLen = (b: string | Uint8Array) => (typeof b === "string" ? Buffer.byteLength(b) : b.byteLength);
const streamOf = (bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
};

afterEach(async () => { vi.restoreAllMocks(); await resetUploadSessionsForTests(); delete process.env.ARTIFACT_MAX_BYTES; delete process.env.ARTIFACT_MAX_FILES; });

describe("parseRangeHeader — dragging a video's progress bar depends entirely on it", () => {
  it("parses an ordinary range", () => {
    expect(parseRangeHeader("bytes=0-499", 10_000)).toEqual({ start: 0, end: 499 });
    expect(parseRangeHeader("bytes=500-999", 10_000)).toEqual({ start: 500, end: 999 });
  });

  it("an open-ended range runs to the end of the file (this is how browsers ask when starting playback)", () => {
    expect(parseRangeHeader("bytes=1000-", 5_000)).toEqual({ start: 1000, end: 4_999 });
  });

  it("a suffix range means the last N bytes (some players probe the trailing metadata first)", () => {
    expect(parseRangeHeader("bytes=-500", 10_000)).toEqual({ start: 9_500, end: 9_999 });
  });

  it("out of bounds returns 416 instead of being ignored — ignoring it would hand the player misaligned data", () => {
    expect(parseRangeHeader("bytes=99999-", 1_000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=500-100", 1_000)).toBe("unsatisfiable");
  });

  it("no Range header or an unrecognised format is treated as a plain request", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader("bytes=abc", 100)).toBeNull();
    expect(parseRangeHeader("items=0-1", 100)).toBeNull();
  });

  // This is the guard against "one header blows up memory": `bytes=0-` semantically means the whole
  // file, and honouring it in full for a 300MB video would put us right back where we started.
  it("a single range is capped — one bytes=0- cannot pull the whole file into memory", () => {
    const span = parseRangeHeader("bytes=0-", 300 * 1024 * 1024) as { start: number; end: number };
    expect(span.end - span.start + 1).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("streaming writes — memory decoupled from file size", () => {
  it("writes a stream into a version and returns the true byte count", async () => {
    const storage = getStorage();
    const payload = new Uint8Array(300 * 1024).fill(7);
    const written = await storage.writeStreamToVersion("site_stream", "ver_stream", "media/clip.mp4", streamOf(payload));
    expect(written).toBe(payload.byteLength);
    expect(await storage.sizeOf("site_stream", "ver_stream", "media/clip.mp4")).toBe(payload.byteLength);
  });

  it("a range read back matches the original (both ends must be right)", async () => {
    const storage = getStorage();
    const payload = new Uint8Array(100_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await storage.writeStreamToVersion("site_range", "ver_range", "v.mp4", streamOf(payload));

    const head = await storage.readRange("site_range", "ver_range", "v.mp4", 0, 99);
    expect(head.total).toBe(100_000);
    expect([...head.bytes]).toEqual([...payload.subarray(0, 100)]);

    const tail = await storage.readRange("site_range", "ver_range", "v.mp4", 99_900, 99_999);
    expect([...tail.bytes]).toEqual([...payload.subarray(99_900)]);
  });

  it("a stream over the per-file limit is cut off, not written in full and complained about afterwards", async () => {
    process.env.ARTIFACT_MAX_FILE_BYTES = String(64 * 1024);
    const storage = getStorage();
    await expect(
      storage.writeStreamToVersion("site_cap", "ver_cap", "big.bin", streamOf(new Uint8Array(200 * 1024))),
    ).rejects.toThrow(/too large/i);
    delete process.env.ARTIFACT_MAX_FILE_BYTES;
  });
});

describe("upload sessions — a version either exists in full or never existed", () => {
  it("the total-size gate counts the bytes uploaded so far", async () => {
    process.env.ARTIFACT_MAX_BYTES = String(1000);
    const session = await createUploadSession({ title: "t", ownerKey: "a:test" });
    await recordUploadedFile(session, "a.bin", 600);
    expect(() => assertSessionRoom(session, 300)).not.toThrow();
    expect(() => assertSessionRoom(session, 500)).toThrow(/exceeds the limit/);
  });

  it("re-uploading a file of the same name overwrites rather than accumulates — otherwise a few retries would falsely exceed the limit", async () => {
    const session = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(session, "a.bin", 100);
    await recordUploadedFile(session, "a.bin", 250);
    expect(session.files).toEqual([{ relpath: "a.bin", bytes: 250 }]);
    // The persisted copy must be the overwritten one too — under multiple replicas that is what
    // another machine reads
    expect((await getUploadSession(session.versionId))?.files).toEqual([{ relpath: "a.bin", bytes: 250 }]);
  });

  it("preserves parallel uploads from the same snapshot, including SHA-256 receipts", async () => {
    const created = await createUploadSession({ ownerKey: "a:test" });
    const first = (await getUploadSession(created.versionId))!;
    const second = (await getUploadSession(created.versionId))!;
    await Promise.all([
      recordUploadedFile(first, "index.html", 100, "root-hash"),
      recordUploadedFile(second, "nested/index.html", 200, "nested-hash"),
    ]);
    const files = (await getUploadSession(created.versionId))!.files;
    expect(files).toHaveLength(2);
    expect(files).toEqual(expect.arrayContaining([
      { relpath: "index.html", bytes: 100, sha256: "root-hash" },
      { relpath: "nested/index.html", bytes: 200, sha256: "nested-hash" },
    ]));
  });

  it.each(["bytes", "files"])("admits only one parallel upload when the aggregate %s limit would be exceeded", async (limit) => {
    if (limit === "bytes") process.env.ARTIFACT_MAX_BYTES = "1000";
    else process.env.ARTIFACT_MAX_FILES = "1";
    const created = await createUploadSession({ ownerKey: "a:test" });
    const first = (await getUploadSession(created.versionId))!;
    const second = (await getUploadSession(created.versionId))!;
    const results = await Promise.allSettled([
      recordUploadedFile(first, "a.bin", 600),
      recordUploadedFile(second, "b.bin", 600),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 400 }) }),
    ]);
    expect((await getUploadSession(created.versionId))!.files).toHaveLength(1);
  });

  it.each(["bytes", "files"])("rechecks stale %s limit failures after another upload invalidates a receipt", async (limit) => {
    if (limit === "bytes") process.env.ARTIFACT_MAX_BYTES = "1000";
    else process.env.ARTIFACT_MAX_FILES = "1";
    const session = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(session, "old.bin", 600, "old-hash");
    const stale = (await getUploadSession(session.versionId))!;
    await beginUploadedFile(session, "old.bin");
    await recordUploadedFile(stale, "index.html", 600, "new-hash");
    expect((await getUploadSession(session.versionId))!.files).toEqual([
      { relpath: "index.html", bytes: 600, sha256: "new-hash" },
    ]);
  });

  it("invalidates parallel re-uploads without resurrecting receipts or losing other files", async () => {
    const created = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(created, "a.bin", 100, "a-hash");
    await recordUploadedFile(created, "b.bin", 200, "b-hash");
    const first = (await getUploadSession(created.versionId))!;
    const second = (await getUploadSession(created.versionId))!;
    await recordUploadedFile(created, "index.html", 300, "root-hash");
    await Promise.all([beginUploadedFile(first, "a.bin"), beginUploadedFile(second, "b.bin")]);
    expect((await getUploadSession(created.versionId))!.files).toEqual([
      { relpath: "index.html", bytes: 300, sha256: "root-hash" },
    ]);
  });

  it("invalidates a receipt added after the caller read its snapshot", async () => {
    const created = await createUploadSession({ ownerKey: "a:test" });
    const stale = (await getUploadSession(created.versionId))!;
    await recordUploadedFile(created, "a.bin", 100, "a-hash");
    await beginUploadedFile(stale, "a.bin");
    expect((await getUploadSession(created.versionId))!.files).toEqual([]);
  });

  it.each(["record", "begin"])("returns 404 when a session disappears before %s", async (operation) => {
    const session = await createUploadSession({ ownerKey: "a:test" });
    await discardUploadSession(session.versionId);
    const result = operation === "record"
      ? recordUploadedFile(session, "a.bin", 100)
      : beginUploadedFile(session, "a.bin");
    await expect(result).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(["record", "begin"])("returns 409 after repeated CAS conflicts during %s without changing the caller", async (operation) => {
    const session = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(session, "a.bin", 100, "original-hash");
    const compare = vi.spyOn(db, "compareUploadSessionFiles").mockResolvedValue(false);
    const result = operation === "record"
      ? recordUploadedFile(session, "a.bin", 200, "replacement-hash")
      : beginUploadedFile(session, "a.bin");
    const error = await result.catch(error => error);
    expect(error).toMatchObject({ statusCode: 409, code: "upload_conflict" });
    const response = errorResponse(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: error.message, code: "upload_conflict", retryable: true });
    expect(compare).toHaveBeenCalledTimes(16);
    expect(session.files).toEqual([{ relpath: "a.bin", bytes: 100, sha256: "original-hash" }]);
    expect((await getUploadSession(session.versionId))!.files).toEqual(session.files);
  });

  it("counts a replacement once at both aggregate limits", async () => {
    process.env.ARTIFACT_MAX_BYTES = "200";
    process.env.ARTIFACT_MAX_FILES = "1";
    const session = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(session, "a.bin", 100, "old-hash");
    await recordUploadedFile(session, "a.bin", 200, "new-hash");
    expect((await getUploadSession(session.versionId))!.files).toEqual([
      { relpath: "a.bin", bytes: 200, sha256: "new-hash" },
    ]);
  });

  // This is the lifeline of multi-replica deployments: the session must be readable by **another
  // process**. Simulated by bypassing the local object and reading straight from the database.
  it("sessions are persisted — another process can read them (the prerequisite for multiple replicas in production)", async () => {
    const created = await createUploadSession({ title: "跨副本", ownerKey: "u:alice" });
    const fromDb = await getUploadSession(created.versionId);
    expect(fromDb?.versionId).toBe(created.versionId);
    expect(fromDb?.ownerKey).toBe("u:alice");
  });

  it("an identity mismatch is treated as no session — an outsider holding the versionId cannot stuff files in", async () => {
    const created = await createUploadSession({ ownerKey: "u:alice" });
    expect(await getUploadSession(created.versionId, "u:mallory")).toBeNull();
    expect(await getUploadSession(created.versionId, "u:alice")).not.toBeNull();
  });

  it("the file count is gated too", async () => {
    process.env.ARTIFACT_MAX_FILES = "2";
    const session = await createUploadSession({ ownerKey: "a:test" });
    await recordUploadedFile(session, "a", 1);
    await recordUploadedFile(session, "b", 1);
    expect(() => assertSessionRoom(session, 1)).toThrow(/Too many files/);
  });

  it("discarding a session reclaims the bytes already written — an interrupted upload leaves no permanent garbage", async () => {
    const storage = getStorage();
    const session = await createUploadSession({ ownerKey: "a:test" });
    await storage.writeStreamToVersion(session.siteId, session.versionId, "x.bin", streamOf(new Uint8Array(1024)));
    expect(await storage.sizeOf(session.siteId, session.versionId, "x.bin")).toBe(1024);

    await discardUploadSession(session.versionId);
    expect(await getUploadSession(session.versionId)).toBeNull();
    expect(await storage.sizeOf(session.siteId, session.versionId, "x.bin")).toBeNull();
  });

  it("expired sessions are swept and their bytes reclaimed as well", async () => {
    const storage = getStorage();
    const session = await createUploadSession({ ownerKey: "a:test" });
    await storage.writeStreamToVersion(session.siteId, session.versionId, "y.bin", streamOf(new Uint8Array(512)));
    const swept = await sweepExpiredSessions(Date.now() + UPLOAD_SESSION_TTL_MS + 1);
    expect(swept).toBe(1);
    expect(await storage.sizeOf(session.siteId, session.versionId, "y.bin")).toBeNull();
  });
});

describe("preview responses — media by range, web pages whole as before", () => {
  let slug = "";
  beforeEach(async () => {
    const created = await createSite({ mode: "paste", html: "<title>M</title><body>page</body>" });
    slug = created.site.slug;
    const view = created.site;
    // Stuff a "video" into this version
    const clip = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < clip.length; i += 997) clip[i] = 42;
    await getStorage().writeStreamToVersion(view.id, created.version.id, "clip.mp4", streamOf(clip));
  });

  it("a media request with Range gets 206 and reports the total length", async () => {
    const res = await servePreviewFile(slug, ["clip.mp4"], undefined, undefined, "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toMatch(/^bytes 0-1023\/3145728$/);
    expect(bodyLen(res.body)).toBe(1024);
  });

  it("large media without Range also gets only a first chunk — otherwise one playback reads the whole file into memory", async () => {
    const res = await servePreviewFile(slug, ["clip.mp4"], undefined, undefined, null);
    expect(res.status).toBe(206);
    expect(bodyLen(res.body)).toBeLessThan(3 * 1024 * 1024);
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("an out-of-bounds Range gets 416 with the total length so the player can correct itself", async () => {
    const res = await servePreviewFile(slug, ["clip.mp4"], undefined, undefined, "bytes=99999999-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */3145728");
  });

  it("a bare PDF request returns the whole file but declares accept-ranges — pdf.js uses that header to decide on range requests, and a 206 first chunk would break it", async () => {
    const site = (await getSiteBySlug(slug))!;
    const version = (await getCurrentVersion(slug))!;
    await getStorage().writeStreamToVersion(site.id, version.id, "doc.pdf", streamOf(new Uint8Array(2 * 1024 * 1024)));
    const bare = await servePreviewFile(slug, ["doc.pdf"], undefined, undefined, null);
    expect(bare.status).toBe(200);
    expect(bare.headers["accept-ranges"]).toBe("bytes");
    const ranged = await servePreviewFile(slug, ["doc.pdf"], undefined, undefined, "bytes=0-99");
    expect(ranged.status).toBe(206);
  });

  it("HTML is never ranged — it gets the bootstrap injected, so slicing makes no sense for it", async () => {
    const res = await servePreviewFile(slug, undefined, undefined, undefined, "bytes=0-10");
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBeUndefined();
  });
});
