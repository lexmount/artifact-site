import { expect, it } from "vitest";
import { packageForFiles, checkArchiveSize } from "@/lib/package-upload-client";
import { DEFAULT_ARCHIVE_MAX_BYTES } from "@/lib/package-contract";
it("keeps one-file folders distinct from standalone documents", () => {
  const files = [{ path: "report.pdf", file: new File(["pdf"], "report.pdf") }];
  expect(packageForFiles(files)).toBeUndefined();
  expect(packageForFiles(Object.assign(files, { folder: true }))).toEqual({ source: "folder", directories: [] });
});
it.each(["ZIP", "rar", "7z", "tar", "TAR.GZ", "tgz"])("routes %s archives to original-byte uploads", ext => {
  const files = [{ path: `report.${ext}`, file: new File(["original"], `report.${ext}`) }];
  expect(packageForFiles(files)).toEqual({ source: "archive", name: `report.${ext}` });
});
it("accepts exactly 100 MiB and rejects one byte more", () => {
  expect(DEFAULT_ARCHIVE_MAX_BYTES).toBe(100 * 1024 * 1024);
  const file = new File([], "data.zip");
  Object.defineProperty(file, "size", { value: DEFAULT_ARCHIVE_MAX_BYTES, configurable: true });
  const files = [{ path: file.name, file }];
  expect(checkArchiveSize(files, { source: "archive" })).toBe(true);
  Object.defineProperty(file, "size", { value: DEFAULT_ARCHIVE_MAX_BYTES + 1 });
  expect(checkArchiveSize(files, { source: "archive" })).toBe(false);
});
it("retains an all-empty directory selection", () => {
  expect(packageForFiles(Object.assign([], { folder: true, directories: ["empty"] }))).toEqual({ source: "folder", directories: ["empty"] });
});

import { normalizePickedFolder } from "@/lib/package-upload-client";
it("normalizes a selected folder root and filters only safe OS metadata", () => {
  const files = Object.assign(["dist/index.html", "dist/assets/app.css", "dist/.DS_Store", "dist/Thumbs.db", "dist/__MACOSX/._index.html", "dist/.env", "dist/../.DS_Store"].map(path => ({ path, file: new File(["x"], path.split("/").pop()!) })), { folder: true, directories: ["dist", "dist/assets", "dist/empty", "dist/__MACOSX"] });
  const result = normalizePickedFolder(files);
  expect(result.map(f => f.path)).toEqual(["index.html", "assets/app.css", ".env", "../.DS_Store"]);
  expect(result.directories).toEqual(["assets", "empty"]);
  expect(result.folder).toBe(true);
  expect(normalizePickedFolder(result).map(f => f.path)).toEqual(result.map(f => f.path));
});
it("does not flatten multiple dropped roots or archives", () => {
  const files = Object.assign(["one/index.html", "two/index.html"].map(path => ({ path, file: new File(["x"], "index.html") })), { folder: true });
  expect(normalizePickedFolder(files).map(f => f.path)).toEqual(files.map(f => f.path));
  const archive = [{ path: "bundle.zip", file: new File(["zip"], "bundle.zip") }];
  expect(normalizePickedFolder(archive)).toBe(archive);
});

import { uploadFailureMessage } from "@/lib/package-upload-client";
it("explains generic upload failures while preserving actionable validation errors", () => {
  const t = (message: string) => `translated: ${message}`;
  expect(uploadFailureMessage(new Error("internal error"), "fallback", t)).toContain("translated: The server could not process this upload.");
  expect(uploadFailureMessage(new Error("Package exceeds its size limit"), "fallback", t)).toBe("Package exceeds its size limit");
  expect(uploadFailureMessage(null, "fallback", t)).toBe("fallback");
});
