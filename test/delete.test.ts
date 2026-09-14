import { describe, expect, it } from "vitest";
import { servePreviewFile } from "@/lib/preview";
import { siteDir } from "@/lib/store";
import { createSite, deleteSite, getSiteView, listSites } from "@/lib/sites";
import { exists, folderFiles } from "./helpers";

describe("delete — a soft delete that keeps the files for the retention window", () => {
  it("tombstones the site, 404s the link, drops it from the list — and leaves the files for a restore", async () => {
    const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<h1>bye</h1>", "a.css": "x" }) });
    expect(await exists(siteDir(site.id))).toBe(true);

    expect(await deleteSite(site.slug)).toBe(true);

    expect((await getSiteView(site.slug))).toBeNull();
    expect(await exists(siteDir(site.id))).toBe(true); // restorable until purged (lib/admin purgeDeletedSites)
    expect((await servePreviewFile(site.slug, undefined)).status).toBe(404);
    expect((await listSites()).some((s) => s.slug === site.slug)).toBe(false);
  });

  it("deleting an already-deleted (or unknown) site returns false", async () => {
    const { site } = await createSite({ mode: "paste", html: "<body>x</body>" });
    expect(await deleteSite(site.slug)).toBe(true);
    expect(await deleteSite(site.slug)).toBe(false);
    expect(await deleteSite("no-such-slug")).toBe(false);
  });
});
