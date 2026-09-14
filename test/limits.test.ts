import { describe, expect, it } from "vitest";
import { limits } from "@/lib/config";
import { assertWithinLimits } from "@/lib/store";
import { createSite } from "@/lib/sites";
import type { UploadFile } from "@/lib/types";
import { folderFiles } from "./helpers";

function fakeFiles(count: number, eachBytes: number): UploadFile[] {
  return Array.from({ length: count }, (_, i) => ({ relpath: `f${i}.txt`, bytes: new Uint8Array(eachBytes) }));
}

describe("limits — a dropped site is finished, not a monorepo", () => {
  it("rejects too many files", () => {
    expect(() => assertWithinLimits(fakeFiles(limits.maxFiles + 1, 1))).toThrow(/too many files/);
  });

  it("rejects an oversized single file", () => {
    expect(() => assertWithinLimits([{ relpath: "big.bin", bytes: new Uint8Array(limits.maxFileBytes + 1) }])).toThrow(/file too large/);
  });

  it("rejects an oversized total across many files", () => {
    const chunk = 2 * 1024 * 1024; // 2MB each
    const count = Math.floor(limits.maxBytes / chunk) + 2; // pushes total over 50MB
    expect(() => assertWithinLimits(fakeFiles(count, chunk))).toThrow(/site too large/);
  });

  it("rejects an empty version", () => {
    expect(() => assertWithinLimits([])).toThrow(/at least one file/);
  });

  it("createSite surfaces a traversal path in a folder upload", async () => {
    await expect(createSite({ mode: "folder", files: folderFiles({ "../evil.html": "<body>x</body>" }) })).rejects.toThrow();
  });
});
