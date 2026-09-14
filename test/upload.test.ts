import { describe, expect, it } from "vitest";
import { detectEntry, flattenSingleTopDir, normalizeUpload } from "@/lib/upload";
import { createSite } from "@/lib/sites";
import { folderFiles, makeZip, readVersionFile, u8 } from "./helpers";

describe("upload — the four drop modes", () => {
  it("paste → single site, index.html entry, title from <title>", async () => {
    const normalized = normalizeUpload({ mode: "paste", html: "<html><head><title>My Paste</title></head><body>hi</body></html>" });
    expect(normalized.kind).toBe("single");
    expect(normalized.entry).toBe("index.html");
    expect(normalized.title).toBe("My Paste");

    const { site, version } = await createSite({ mode: "paste", html: "<html><head><title>Pasted</title></head><body>hi</body></html>" });
    expect(site.kind).toBe("single");
    expect(version.entry).toBe("index.html");
    expect(version.fileCount).toBe(1);
    expect(await readVersionFile(site.id, version.id, "index.html")).toContain("Pasted");
  });

  it("paste with empty html is rejected", () => {
    expect(() => normalizeUpload({ mode: "paste", html: "   " })).toThrow(/empty/);
  });

  it("single .html file → single site stored as index.html", async () => {
    const { site, version } = await createSite({ mode: "file", filename: "landing.html", bytes: u8("<html><head><title>Landing</title></head><body>x</body></html>") });
    expect(site.kind).toBe("single");
    expect(version.entry).toBe("index.html");
    expect(site.title).toBe("Landing");
    expect(await readVersionFile(site.id, version.id, "index.html")).toContain("Landing");
  });

  it("non-.html single file is rejected", () => {
    expect(() => normalizeUpload({ mode: "file", filename: "app.js", bytes: u8("alert(1)") })).toThrow(/\.html/);
  });

  it("folder → folder site, index.html at root is the entry", async () => {
    const { site, version } = await createSite({
      mode: "folder",
      files: folderFiles({
        "index.html": "<html><head><title>Home</title></head><body><a href='about.html'>a</a></body></html>",
        "about.html": "<h1>About</h1>",
        "assets/app.js": "console.log(1)",
      }),
    });
    expect(site.kind).toBe("folder");
    expect(version.entry).toBe("index.html");
    expect(version.fileCount).toBe(3);
    expect(site.title).toBe("Home");
  });

  it("folder wrapped in a single top dir is flattened", () => {
    const flat = flattenSingleTopDir(folderFiles({ "my-site/index.html": "a", "my-site/style.css": "b" }));
    expect(flat.map((f) => f.relpath).sort()).toEqual(["index.html", "style.css"]);
    const normalized = normalizeUpload({ mode: "folder", files: folderFiles({ "site/index.html": "<title>Wrapped</title>", "site/x.css": "" }) });
    expect(normalized.entry).toBe("index.html");
    expect(normalized.title).toBe("Wrapped");
  });

  it("folder with the only html nested picks it as entry", () => {
    const normalized = normalizeUpload({ mode: "folder", files: folderFiles({ "page.html": "<title>Solo</title>", "assets/x.css": "" }) });
    expect(normalized.entry).toBe("page.html");
  });

  it("folder with multiple html and no index.html is rejected", () => {
    expect(() => detectEntry(["a.html", "b.html", "style.css"])).toThrow(/Could not determine the entry file/);
  });

  it("zip → folder site, single wrapper dir flattened, junk stripped", async () => {
    const zip = makeZip({
      "bundle/index.html": "<html><head><title>Zipped</title></head><body>z</body></html>",
      "bundle/assets/app.css": "body{}",
      "bundle/.DS_Store": "junk",
      "__MACOSX/bundle/._index.html": "junk",
    });
    const { site, version } = await createSite({ mode: "zip", bytes: zip });
    expect(site.kind).toBe("folder");
    expect(version.entry).toBe("index.html");
    expect(site.title).toBe("Zipped");
    expect(version.fileCount).toBe(2); // index.html + assets/app.css, junk dropped
    expect(await readVersionFile(site.id, version.id, "assets/app.css")).toBe("body{}");
  });

  it("zip dist: index.html + a second .html + nested asset → folder site, index entry, all files stored", async () => {
    const zip = makeZip({
      "dist/index.html": "<html><head><title>Dist</title></head><body><a href='about.html'>about</a><link rel='stylesheet' href='assets/app.css'></body></html>",
      "dist/about.html": "<html><head><title>About</title></head><body>about page</body></html>",
      "dist/assets/app.css": "body{color:red}",
    });
    const { site, version } = await createSite({ mode: "zip", bytes: zip });
    expect(site.kind).toBe("folder");
    expect(version.entry).toBe("index.html"); // wrapper dir flattened, root index.html wins
    expect(version.fileCount).toBe(3);
    expect(await readVersionFile(site.id, version.id, "about.html")).toContain("about page");
    expect(await readVersionFile(site.id, version.id, "assets/app.css")).toContain("color:red");
  });

  it("zip with a zip-slip traversal entry is rejected (path validated before flattening)", async () => {
    const zip = makeZip({ "index.html": "<title>ok</title>", "../evil.html": "<h1>pwn</h1>" });
    expect(() => normalizeUpload({ mode: "zip", bytes: zip })).toThrow(/unsafe|invalid|escapes/i);
    await expect(createSite({ mode: "zip", bytes: zip })).rejects.toThrow();
  });

  it("explicit title overrides the extracted <title>", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Ignored</title>", title: "Chosen" });
    expect(site.title).toBe("Chosen");
  });
});
