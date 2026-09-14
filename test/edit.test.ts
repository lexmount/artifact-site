import { describe, expect, it } from "vitest";
import { committed } from "./helpers";
import { createSite, editSite, getSiteView } from "@/lib/sites";
import { folderFiles, readVersionFile, testAudit} from "./helpers";

describe("edit — every save is a new immutable version", () => {
  it("single site: content replaces the whole document, current advances, old version stays intact", async () => {
    const created = await createSite({ mode: "paste", html: "<html><head><title>v1</title></head><body>one</body></html>" });
    const oldVersionId = created.version.id;

    const edited = committed(await editSite(created.site.slug, { content: "<html><head><title>v2</title></head><body>two</body></html>" }, testAudit()));
    expect(edited).not.toBeNull();
    expect(edited!.version.id).not.toBe(oldVersionId);
    expect(edited!.version.source).toBe("edit");

    // The site now serves the new version…
    const view = (await getSiteView(created.site.slug))!;
    expect(view.version.id).toBe(edited!.version.id);
    expect(await readVersionFile(view.site.id, view.version.id, "index.html")).toContain("two");
    // …but the earlier version's files are untouched on disk.
    expect(await readVersionFile(created.site.id, oldVersionId, "index.html")).toContain("one");
  });

  it("folder site: replacing one file copies the prior tree and leaves siblings intact", async () => {
    const created = await createSite({
      mode: "folder",
      files: folderFiles({
        "index.html": "<html><head><title>Home</title></head><body>home</body></html>",
        "about.html": "<h1>about v1</h1>",
        "assets/app.css": "body{color:black}",
      }),
    });
    const oldVersionId = created.version.id;

    const edited = committed(await editSite(created.site.slug, { path: "about.html", content: "<h1>about v2</h1>" }, testAudit()));
    expect(edited).not.toBeNull();
    const nv = edited!.version;
    expect(nv.id).not.toBe(oldVersionId);
    expect(nv.fileCount).toBe(3);

    expect(await readVersionFile(created.site.id, nv.id, "about.html")).toContain("about v2");
    expect(await readVersionFile(created.site.id, nv.id, "assets/app.css")).toContain("color:black");
    // old version preserved
    expect(await readVersionFile(created.site.id, oldVersionId, "about.html")).toContain("about v1");
  });

  it("folder site: an edit can add a new file (file count grows)", async () => {
    const created = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<body>root</body>" }) });
    const edited = committed(await editSite(created.site.slug, { path: "extra.html", content: "<h1>extra</h1>" }, testAudit()));
    expect(edited!.version.fileCount).toBe(2);
    expect(await readVersionFile(created.site.id, edited!.version.id, "extra.html")).toContain("extra");
  });

  it("folder edit rejects a traversal path", async () => {
    const created = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<body>x</body>" }) });
    await expect(editSite(created.site.slug, { path: "../escape.html", content: "x" }, testAudit())).rejects.toThrow();
  });

  it("editing an unknown slug returns null", async () => {
    expect(await editSite("no-such-slug", { content: "x" }, testAudit())).toBeNull();
  });
});
