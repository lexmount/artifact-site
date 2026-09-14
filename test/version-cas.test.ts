import { describe, expect, it } from "vitest";
import { addVersionAsCurrentIfCurrentIs, createId, getSite, listVersions, softDeleteSite } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { folderFiles, testAudit} from "./helpers";

async function makeSite() {
  const { site, version } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<title>t</title>v1" }) });
  return { site, version };
}

function outputVersion(siteId: string) {
  return { id: createId("ver"), siteId, entry: "index.html", fileCount: 1, byteSize: 10, source: "build" as const };
}

// A build reads the site, works for minutes, then commits — while the product invites the user to
// open and edit the placeholder it published in the meantime. Without the compare, that edit is
// silently discarded; "stale" is what lets the caller surface the collision instead.
describe("addVersionAsCurrentIfCurrentIs — compare-and-set commit", () => {
  it("applies when the site is untouched since the caller looked", async () => {
    const { site, version } = await makeSite();
    const next = outputVersion(site.id);
    expect(await addVersionAsCurrentIfCurrentIs(site.id, version.id, next)).toBe("applied");
    expect((await getSite(site.id))!.currentVersionId).toBe(next.id);
  });

  it("refuses — and writes nothing — when the site moved on", async () => {
    const { site, version } = await makeSite();
    await editSite(site.slug, { path: "index.html", content: "edited by the user mid-build" }, testAudit());
    const movedTo = (await getSite(site.id))!.currentVersionId;
    expect(movedTo).not.toBe(version.id);

    const before = (await listVersions(site.slug))!.length;
    const next = outputVersion(site.id);
    expect(await addVersionAsCurrentIfCurrentIs(site.id, version.id, next)).toBe("stale");

    // Nothing written: the user's edit is still what the site serves, and no orphan version row.
    expect((await getSite(site.id))!.currentVersionId).toBe(movedTo);
    expect((await listVersions(site.slug))!.length).toBe(before);
  });

  it("reports a deleted site as gone rather than resurrecting it", async () => {
    const { site, version } = await makeSite();
    await softDeleteSite(site.id);
    expect(await addVersionAsCurrentIfCurrentIs(site.id, version.id, outputVersion(site.id))).toBe("gone");
  });

  it("only one of two racing commits from the same starting point wins", async () => {
    const { site, version } = await makeSite();
    const results = await Promise.all([
      addVersionAsCurrentIfCurrentIs(site.id, version.id, outputVersion(site.id)),
      addVersionAsCurrentIfCurrentIs(site.id, version.id, outputVersion(site.id)),
    ]);
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.filter((r) => r === "stale")).toHaveLength(1);
  });
});
