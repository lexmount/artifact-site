import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { normalizeUpload } from "@/lib/upload";
import { unzipBounded } from "@/lib/unzip";
import { assertContentLengthWithinLimit, PayloadTooLargeError } from "@/app/api/_util";
import { checkRateLimit, clientKey, RateLimitError, __resetRateLimitForTests } from "@/lib/ratelimit";
import { limits } from "@/lib/config";
import { createSite, editSite, getSiteView } from "@/lib/sites";
import { folderFiles, testAudit} from "./helpers";

const ENV_KEYS = [
  "ARTIFACT_MAX_BYTES",
  "ARTIFACT_MAX_FILES",
  "ARTIFACT_MAX_FILE_BYTES",
  "ARTIFACT_INLINE_UPLOAD_MAX_BYTES",
  "ARTIFACT_RATE_LIMIT",
  "ARTIFACT_RATE_LIMIT_BURST",
  "ARTIFACT_RATE_LIMIT_PER_MIN",
  "ARTIFACT_RATE_LIMIT_MAX_KEYS",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetRateLimitForTests();
});

function reqWithLength(bytes: number): Request {
  return new Request("http://x/api/sites", { method: "POST", headers: { "content-length": String(bytes) } });
}

function reqFromIp(ip: string): Request {
  return new Request("http://x/api/sites", { method: "POST", headers: { "x-forwarded-for": ip } });
}

describe("zip-bomb guard — reject by declared size before decompression", () => {
  it("rejects a highly-compressible bomb whose declared TOTAL blows the site limit", () => {
    // The limits are pushed back down to 50MB/32MB in this one case: what is guarded is "cut off
    // mid-decompression", not a particular number. Triggering it with the raised production defaults
    // would need a bomb of several hundred MB — which would only make the test eat all the memory itself.
    process.env.ARTIFACT_MAX_BYTES = String(50 * 1024 * 1024);
    process.env.ARTIFACT_MAX_FILE_BYTES = String(32 * 1024 * 1024);
    // 3×20MB of zeros: each entry is under the 32MB per-file cap, but the 60MB total
    // exceeds the 50MB site cap. Compresses to a tiny request, yet is rejected before
    // any of it is decompressed (via the central-directory sizes).
    const bomb = zipSync({
      "a.bin": new Uint8Array(20 * 1024 * 1024),
      "b.bin": new Uint8Array(20 * 1024 * 1024),
      "c.bin": new Uint8Array(20 * 1024 * 1024),
    });
    expect(bomb.length).toBeLessThan(1024 * 1024); // the request itself is tiny
    expect(() => normalizeUpload({ mode: "zip", bytes: bomb })).toThrow(/zip bomb|too large after decompression/);
  });

  it("rejects a single huge entry via the per-file cap", () => {
    process.env.ARTIFACT_MAX_FILE_BYTES = String(32 * 1024 * 1024);
    const bomb = zipSync({ "bomb.bin": new Uint8Array(60 * 1024 * 1024) });
    expect(() => normalizeUpload({ mode: "zip", bytes: bomb })).toThrow(/too large/);
  });

  it("rejects a single entry that exceeds the per-file limit", () => {
    process.env.ARTIFACT_MAX_FILE_BYTES = String(1 * 1024 * 1024); // 1MB per file
    const zip = zipSync({ "big.bin": new Uint8Array(2 * 1024 * 1024) });
    expect(() => normalizeUpload({ mode: "zip", bytes: zip })).toThrow(/too large/);
  });

  it("rejects too many entries", () => {
    process.env.ARTIFACT_MAX_FILES = String(5);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 7; i++) many[`f${i}.txt`] = new Uint8Array([65]);
    expect(() => normalizeUpload({ mode: "zip", bytes: zipSync(many) })).toThrow(/Too many files/);
  });

  it("lets a normal small zip through", () => {
    const zip = zipSync({ "index.html": new Uint8Array(Buffer.from("<h1>ok</h1>")) });
    const result = normalizeUpload({ mode: "zip", bytes: zip });
    expect(result.entry).toBe("index.html");
    expect(result.files).toHaveLength(1);
  });

  it("unzipBounded caps output DURING inflation (header size is never trusted)", () => {
    process.env.ARTIFACT_MAX_FILE_BYTES = String(32 * 1024 * 1024);
    // 60MB single entry → aborted at the per-file cap by zlib maxOutputLength, not by the header.
    const bomb = zipSync({ "bomb.bin": new Uint8Array(60 * 1024 * 1024) });
    expect(() => unzipBounded(bomb)).toThrow(/too large|zip bomb/);
    // a normal zip extracts to the real bytes
    const ok = unzipBounded(zipSync({ "index.html": new Uint8Array(Buffer.from("<h1>hi</h1>")), "a/app.js": new Uint8Array(Buffer.from("x=1")) }));
    expect(ok.map((f) => f.name).sort()).toEqual(["a/app.js", "index.html"]);
    expect(Buffer.from(ok.find((f) => f.name === "index.html")!.bytes).toString()).toBe("<h1>hi</h1>");
  });
});

describe("Content-Length precheck — 413 before buffering", () => {
  it("rejects a body far over the ceiling", () => {
    const tooBig = Math.ceil(limits.maxBytes * 1.5) + 1;
    expect(() => assertContentLengthWithinLimit(reqWithLength(tooBig))).toThrow(PayloadTooLargeError);
  });

  it("allows a body within the ceiling", () => {
    expect(() => assertContentLengthWithinLimit(reqWithLength(1024))).not.toThrow();
  });

  it("ignores a missing or garbage Content-Length (downstream guards apply)", () => {
    expect(() => assertContentLengthWithinLimit(new Request("http://x/", { method: "POST" }))).not.toThrow();
    expect(() =>
      assertContentLengthWithinLimit(new Request("http://x/", { method: "POST", headers: { "content-length": "not-a-number" } })),
    ).not.toThrow();
  });

  // This preflight **no longer guards the site size limit** but the one-shot upload path's own
  // protection line: that path reads the whole multipart body into memory, so it must sit far below
  // the site limit. Sites reach 300MB via the chunked channel.
  it("tracks a raised ARTIFACT_INLINE_UPLOAD_MAX_BYTES", () => {
    process.env.ARTIFACT_INLINE_UPLOAD_MAX_BYTES = String(500 * 1024 * 1024);
    expect(() => assertContentLengthWithinLimit(reqWithLength(200 * 1024 * 1024))).not.toThrow();
  });

  it("raising the site limit does not loosen the one-shot upload path — otherwise the higher the limit, the easier it is to blow up the process", () => {
    process.env.ARTIFACT_MAX_BYTES = String(2000 * 1024 * 1024);
    expect(() => assertContentLengthWithinLimit(reqWithLength(200 * 1024 * 1024))).toThrow(PayloadTooLargeError);
  });
});

describe("rate limiter — per-client token bucket", () => {
  it("allows a burst then rejects, refilling over time", () => {
    process.env.ARTIFACT_RATE_LIMIT = "on"; // default is off under the test harness
    process.env.ARTIFACT_RATE_LIMIT_BURST = "3";
    process.env.ARTIFACT_RATE_LIMIT_PER_MIN = "1"; // 1 token / 60s
    const req = reqFromIp("10.0.0.1");
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(() => checkRateLimit(req, t0)).not.toThrow();
    expect(() => checkRateLimit(req, t0)).toThrow(RateLimitError);
    // one token refills after 60s
    expect(() => checkRateLimit(req, t0 + 60_000)).not.toThrow();
    expect(() => checkRateLimit(req, t0 + 60_000)).toThrow(RateLimitError);
  });

  it("isolates buckets per client key", () => {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
    const t = 2_000_000;
    expect(() => checkRateLimit(reqFromIp("1.1.1.1"), t)).not.toThrow();
    expect(() => checkRateLimit(reqFromIp("1.1.1.1"), t)).toThrow(RateLimitError);
    // a different client still has its full burst
    expect(() => checkRateLimit(reqFromIp("2.2.2.2"), t)).not.toThrow();
  });

  it("is a no-op when disabled", () => {
    process.env.ARTIFACT_RATE_LIMIT = "off";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
    const req = reqFromIp("3.3.3.3");
    for (let i = 0; i < 50; i++) expect(() => checkRateLimit(req, 3_000_000)).not.toThrow();
  });
});

describe("rate limiter — trusted client identity (anti-spoof)", () => {
  it("prefers x-real-ip and takes the RIGHTMOST X-Forwarded-For hop", () => {
    expect(clientKey(new Request("http://x/", { headers: { "x-real-ip": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 5.5.5.5" } }))).toBe("5.5.5.5");
    expect(clientKey(new Request("http://x/", { headers: { "x-forwarded-for": "fake-left, 9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientKey(new Request("http://x/"))).toBe("unknown");
  });

  it("a rotating leftmost X-Forwarded-For does NOT mint fresh buckets", () => {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
    const t = 4_100_000;
    const spoof = (n: number) =>
      new Request("http://x/", { method: "POST", headers: { "x-real-ip": "7.7.7.7", "x-forwarded-for": `spoof-${n}, 7.7.7.7` } });
    expect(() => checkRateLimit(spoof(1), t)).not.toThrow();
    // same real client, different forged leftmost hop → still the same bucket → limited
    expect(() => checkRateLimit(spoof(2), t)).toThrow(RateLimitError);
  });

  it("enforces a hard cap on tracked clients via LRU eviction", () => {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
    process.env.ARTIFACT_RATE_LIMIT_MAX_KEYS = "2";
    const t = 4_200_000;
    expect(() => checkRateLimit(reqFromIp("a"), t)).not.toThrow(); // bucket a (exhausted)
    expect(() => checkRateLimit(reqFromIp("b"), t)).not.toThrow(); // bucket b — size now 2
    expect(() => checkRateLimit(reqFromIp("c"), t)).not.toThrow(); // evicts LRU (a); size stays 2
    // 'a' was evicted, so it gets a FRESH bucket and passes again (proves the cap held, not memory)
    expect(() => checkRateLimit(reqFromIp("a"), t)).not.toThrow();
  });

  it("a rate-limited flooder stays evictable (rejected requests don't promote to MRU)", () => {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
    process.env.ARTIFACT_RATE_LIMIT_MAX_KEYS = "2";
    const t = 5_000_000;
    expect(() => checkRateLimit(reqFromIp("A"), t)).not.toThrow(); // A ok (tokens 0), map [A]
    expect(() => checkRateLimit(reqFromIp("B"), t)).not.toThrow(); // B ok, map [A,B]
    expect(() => checkRateLimit(reqFromIp("A"), t)).toThrow(RateLimitError); // A floods — must NOT re-touch to tail
    expect(() => checkRateLimit(reqFromIp("C"), t)).not.toThrow(); // evicts LRU head (A, not B), map [B,C]
    // A was evicted despite flooding → fresh bucket → passes again. Old code kept A pinned and this threw.
    expect(() => checkRateLimit(reqFromIp("A"), t)).not.toThrow();
  });
});

describe("folder-site edit — size limits must hold on the writeFileToVersion path", () => {
  it("rejects an oversized single file and leaves the current version unchanged", async () => {
    const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<h1>hi</h1>", "a.txt": "x" }) });
    const original = site.currentVersionId;
    process.env.ARTIFACT_MAX_FILE_BYTES = String(100); // 100 bytes/file
    await expect(editSite(site.slug, { path: "a.txt", content: "y".repeat(500) }, testAudit())).rejects.toThrow(/too large/);
    expect((await getSiteView(site.slug))?.version.id).toBe(original); // rolled back — old version still current
  });

  it("rejects when the edited tree total exceeds maxBytes and rolls back", async () => {
    const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<h1>hi</h1>", "a.txt": "small" }) });
    const original = site.currentVersionId;
    process.env.ARTIFACT_MAX_BYTES = String(200); // whole site capped at 200 bytes
    process.env.ARTIFACT_MAX_FILE_BYTES = String(1000); // per-file allows it; the TOTAL should not
    await expect(editSite(site.slug, { path: "a.txt", content: "z".repeat(300) }, testAudit())).rejects.toThrow(/too large/);
    expect((await getSiteView(site.slug))?.version.id).toBe(original);
  });
});
