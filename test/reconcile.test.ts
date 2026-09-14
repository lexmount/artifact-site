import { describe, expect, it } from "vitest";
import { createSite, deleteSite } from "@/lib/sites";
import { getStorage } from "@/lib/storage";
import { reconcileOrphans } from "@/lib/reconcile";
import {
  addVersionAsCurrent,
  createId,
  getSiteBySlug,
  getVersion,
  insertSiteWithVersion,
  SlugConflictError,
  softDeleteSite,
} from "@/lib/db";
import { u8 } from "./helpers";

describe("insertSiteWithVersion / addVersionAsCurrent — atomic composites", () => {
  it("insertSiteWithVersion records site + version + current pointer together", async () => {
    const siteId = createId("site");
    const versionId = createId("ver");
    await getStorage().writeVersionFiles(siteId, versionId, [{ relpath: "index.html", bytes: u8("<h1>x</h1>") }]);
    await insertSiteWithVersion(
      { id: siteId, slug: "atomic-1", title: "A", kind: "single", editToken: "t", visibility: "public" },
      { id: versionId, siteId, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" },
    );
    const site = await getSiteBySlug("atomic-1");
    expect(site?.currentVersionId).toBe(versionId);
    expect((await getVersion(versionId))?.siteId).toBe(siteId);
  });

  it("insertSiteWithVersion throws SlugConflictError on a duplicate slug", async () => {
    const mk = (id: string) => ({
      site: { id, slug: "dup-slug", title: "A", kind: "single" as const, editToken: "t", visibility: "public" as const },
      version: { id: `${id}_v`, siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" as const },
    });
    const a = mk(createId("site"));
    const b = mk(createId("site"));
    await insertSiteWithVersion(a.site, a.version);
    await expect(insertSiteWithVersion(b.site, b.version)).rejects.toBeInstanceOf(SlugConflictError);
  });

  it("addVersionAsCurrent refuses a soft-deleted site (returns false, writes nothing)", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Del</title><body>x</body>" });
    await softDeleteSite(site.id);
    const versionId = createId("ver");
    const ok = await addVersionAsCurrent(site.id, { id: versionId, siteId: site.id, entry: "index.html", fileCount: 1, byteSize: 1, source: "edit" });
    expect(ok).toBe(false);
    expect(await getVersion(versionId)).toBeNull(); // nothing inserted
  });
});

// Tests share one store, so assert on each test's OWN files rather than global counts.
// graceMs:-Infinity = "no grace at all" (never spare a tree by age); large graceMs = spare fresh ones.
describe("reconcileOrphans — GC for storage trees with no live metadata", () => {
  it("leaves a live site's version untouched", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "<title>Live</title><body>x</body>" });
    await reconcileOrphans({ graceMs: -Infinity, dryRun: false });
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("file"); // still there
  });

  it("deletes a version tree that has no version row", async () => {
    const siteId = createId("site");
    const versionId = createId("ver");
    await getStorage().writeVersionFiles(siteId, versionId, [{ relpath: "index.html", bytes: u8("<h1>orphan</h1>") }]);
    expect(await getStorage().stat(siteId, versionId, "index.html")).toBe("file");
    await reconcileOrphans({ graceMs: -Infinity, dryRun: false });
    expect(await getStorage().stat(siteId, versionId, "index.html")).toBe("missing");
  });

  it("spares a fresh orphan within the grace window (and dryRun deletes nothing)", async () => {
    const siteId = createId("site");
    const versionId = createId("ver");
    await getStorage().writeVersionFiles(siteId, versionId, [{ relpath: "index.html", bytes: u8("<h1>fresh</h1>") }]);
    const res = await reconcileOrphans({ graceMs: 60 * 60 * 1000, dryRun: false });
    expect(res.skippedByGrace).toBeGreaterThanOrEqual(1);
    expect(await getStorage().stat(siteId, versionId, "index.html")).toBe("file"); // spared by grace
    // dryRun never deletes, even with no grace
    await reconcileOrphans({ graceMs: -Infinity, dryRun: true });
    expect(await getStorage().stat(siteId, versionId, "index.html")).toBe("file"); // still there after dry run
  });

  it("collects a soft-deleted site's leftover files once the retention window has passed", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "<title>SoftDel</title><body>x</body>" });
    // A delete the purge never reached (crashed, or a replica that never ran maintenance).
    await softDeleteSite(site.id);
    process.env.ARTIFACT_DELETED_RETENTION_DAYS = "0";
    try {
      await reconcileOrphans({ graceMs: -Infinity, dryRun: false });
      expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("missing");
    } finally {
      delete process.env.ARTIFACT_DELETED_RETENTION_DAYS;
    }
  });
});

describe("deleteSite soft-deletes and the retention window decides when the files go", () => {
  it("marks the row deleted, keeps the tree, and the reconciler spares it while it is restorable", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "<title>D</title><body>x</body>" });
    expect(await deleteSite(site.slug)).toBe(true);
    expect((await getSiteBySlug(site.slug))?.deletedAt).not.toBeNull();
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("file");
    // Inside the retention window the tree is not an orphan, however old its mtime.
    await reconcileOrphans({ graceMs: -Infinity, dryRun: false });
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("file");
    // Past the window it is: the purge does it normally, the reconciler catches what the purge missed.
    process.env.ARTIFACT_DELETED_RETENTION_DAYS = "0";
    try {
      await reconcileOrphans({ graceMs: -Infinity, dryRun: false });
      expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("missing");
    } finally {
      delete process.env.ARTIFACT_DELETED_RETENTION_DAYS;
    }
  });
});
