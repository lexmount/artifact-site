import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { archiveFingerprint, uploadArchiveChunks } from "@/lib/archive-chunk-client";
const t = (s: string) => s;
it("resumes validated bytes and retries a lost response with the same index", async () => {
  const file = new File(["abcdef"], "x.zip"); let writes = 0;
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) return Response.json({ partialFiles: [{ path: "original", chunks: [{ bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") }] }] });
    expect(String(url)).toContain("index=1&final=1"); expect(await (init.body as Blob).text()).toBe("def");
    if (++writes === 1) throw new TypeError("network lost after acceptance");
    return Response.json({ complete: true });
  });
  const progress: number[] = [];
  await uploadArchiveChunks(request as typeof fetch, "ver_test", file, {}, n => progress.push(n), t);
  expect(progress).toEqual([3, 6]); expect(writes).toBe(2);
});
it("rejects a different file before sending another chunk", async () => {
  const request = vi.fn(async () => Response.json({ partialFiles: [{ path: "original", chunks: [{ bytes: 3, sha256: "wrong" }] }] }));
  await expect(uploadArchiveChunks(request, "ver_test", new File(["abcdef"], "x.zip"), {}, () => {}, t)).rejects.toThrow("differs");
  expect(request).toHaveBeenCalledTimes(1);
});
it("uses contents instead of filenames for recovery and does not resend a sealed archive", async () => {
  const file = new File(["abc"], "x.zip");
  expect(await archiveFingerprint(file)).toBe(await archiveFingerprint(new File(["abc"], "another.zip")));
  expect(await archiveFingerprint(file)).not.toBe(await archiveFingerprint(new File(["abd"], "x.zip")));
  const request = vi.fn(async () => Response.json({ partialFiles: [{ path: "original", sealed: true, chunks: [{ bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") }] }] }));
  await uploadArchiveChunks(request, "ver_test", file, {}, () => {}, t);
  expect(request).toHaveBeenCalledTimes(1);
});
it("uses server byte comparison to resume on HTTP origins without Web Crypto", async () => {
  vi.stubGlobal("crypto", undefined);
  try {
    const sent: string[] = [];
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json({ partialFiles: [{ path: "original", chunks: [{ bytes: 3 }] }] });
      sent.push(await (init.body as Blob).text()); return Response.json({ complete: true });
    });
    const file = new File(["abcdef"], "x.zip");
    expect(await archiveFingerprint(file)).toContain("server-verified");
    await uploadArchiveChunks(request as typeof fetch, "ver_test", file, {}, () => {}, t);
    expect(sent).toEqual(["abc", "def"]);
  } finally { vi.unstubAllGlobals(); }
});
it("splits a file larger than 4 MiB into bounded requests", async () => {
  const lengths: number[] = [];
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) return Response.json({ partialFiles: [] });
    lengths.push((init.body as Blob).size);
    expect(String(url)).toContain(`index=${lengths.length - 1}&final=${lengths.length === 2 ? 1 : 0}`);
    return Response.json({ complete: lengths.length === 2 });
  });
  await uploadArchiveChunks(request as typeof fetch, "ver_test", new File([new Uint8Array(4 * 1024 * 1024 + 1)], "x.zip"), {}, () => {}, s => s);
  expect(lengths).toEqual([4 * 1024 * 1024, 1]);
});
