import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ArtifactSiteClient } from "../src/client.js";
it("resumes stored chunks, retries a network loss and reports progress", async () => {
  const dir = await mkdtemp(tmpdir() + "/chunk-client-");
  try {
    const file = dir + "/a.zip"; await writeFile(file, "abcdef"); let writes = 0;
    const client = new ArtifactSiteClient({ baseUrl: "http://example.test", token: "test", sleep: async () => {}, fetch: async (url, init) => {
      if (String(url).endsWith("/api/auth/me")) return Response.json({ uploadLimits: { maxBytes: 100, maxFileBytes: 100, maxFiles: 10, archiveChunks: 1, archiveChunkBytes: 4 } });
      if (init?.method === "GET") return Response.json({ partialFiles: [{ path: "original", chunks: [{ bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") }] }] });
      expect(String(url)).toContain("index=1&final=1"); expect(await (init!.body as Blob).text()).toBe("def");
      if (++writes === 1) throw new TypeError("lost response");
      return Response.json({ complete: true });
    } });
    const progress: number[] = []; await client.uploadArchiveChunks("ver_test", file, n => progress.push(n));
    expect(writes).toBe(2); expect(progress).toEqual([3, 6]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
