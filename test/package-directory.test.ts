import { describe, expect, it } from "vitest";
import { buildPackageDirectory, validatePackageEntries } from "@/lib/package-directory";
import { normalizeUpload } from "@/lib/upload";

describe("package directory", () => {
  it("lists every HTML without choosing an entry and preserves empty directories", () => {
    const files = [{ path: "report/index.html", size: 20 }, { path: "other/index.HTML", size: 30 }];
    const html = buildPackageDirectory(files, ["empty"], "Reports");
    expect(html).toContain("report/index.html");
    expect(html).toContain("other/index.HTML");
    expect(html).toContain("empty");
  });
  it("escapes names and URLs without executable filenames", () => {
    const html = buildPackageDirectory([{ path: '<img onerror="x">#.html', size: 0 }], [], "<script>x</script>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain('<img onerror="x">');
    expect(html).toContain("%23.html");
  });
  it.each(["../evil", "/absolute", "C:/windows", "a/../../b", ".artifact-package/original", "a/.artifact-package/original"])("rejects unsafe user paths: %s", path => {
    expect(() => validatePackageEntries([{ path, size: 1 }], [])).toThrow();
  });
  it("rejects normalized duplicates and file/directory collisions", () => {
    expect(() => validatePackageEntries([{ path: "é.txt", size: 0 }, { path: "e\u0301.txt", size: 0 }], [])).toThrow();
    expect(() => validatePackageEntries([{ path: "a", size: 0 }, { path: "a/b", size: 0 }], [])).toThrow();
  });
  it("keeps legacy website uploads compatible", () => {
    expect(normalizeUpload({ mode: "folder", files: [{ relpath: "dist/index.html", bytes: Buffer.from("hello") }] }).entry).toBe("index.html");
  });
});

it("renders type icons and escaped, keyboard-accessible directory controls", () => {
  const paths = ["index.html", "photo.png", "clip.mov", "backup.7z", "data.xlsx", "notes.pdf", "unknown.bin"];
  const html = buildPackageDirectory(paths.map(path => ({ path, size: 2048 })), ["empty"], "<Report>");
  for (const type of ["code", "image", "media", "archive", "sheet", "text", "file", "folder"]) expect(html).toContain(`data-file-type="${type}"`);
  expect(html).toContain('data-expand="true"');
  expect(html).toContain('data-expand="false"');
  expect(html).toContain('aria-controls="file-tree"');
  expect(html).toContain("2 KiB");
  expect(html).toContain("&lt;Report&gt;");
  expect(html).not.toContain('href="notes.pdf"');
});
it("omits directory controls for a flat file-only package", () => {
  const html = buildPackageDirectory([{ path: "file.txt", size: 0 }], [], "Files");
  expect(html).not.toContain('data-expand="true"');
});

it("preserves ordinary hidden files and directories", () => {
  const files = [".env", "a/.git/config", "node_modules/lib/app.js", "runs/.manager.lock", "runs/.credential.key", ".reports/index.html"].map(path => ({ path, size: 0 }));
  expect(() => validatePackageEntries(files, [".empty"])).not.toThrow();
  const html = buildPackageDirectory(files, [".empty"], "Files");
  for (const file of files) expect(html).toContain(file.path.split("/").pop());
});

it("starts every folder collapsed, including empty and nested folders", () => {
  const html = buildPackageDirectory([{ path: "a/b/index.html", size: 1 }], ["empty"], "Files");
  expect(html.match(/<details>/g)).toHaveLength(3);
  expect(html).not.toContain("<details open>");
});
