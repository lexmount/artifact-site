import { describe, expect, it } from "vitest";
import { createSite, editSite, listVersions, replaceSiteContent } from "@/lib/sites";
import { createShare, listSiteSummaries, recordSiteView, recordShareView, getSite, listAudit, rbacQuery, listSitesByOwner, upsertUser, createId } from "@/lib/db";
import { apiAuditContext } from "@/lib/audit";
import { setOfficialVersion } from "@/lib/official-version";
import { committed, readVersionFile, testAudit } from "./helpers";

function designationContext(site: { editToken: string }) {
  return apiAuditContext(new Request("http://localhost/api/sites", { headers: { "x-edit-token": site.editToken } }), { kind: "legacy-token", userId: null, anonId: null });
}

describe("official versions", () => {
  it("lists all-time direct and share opens only for the site owner", async () => {
    const owner = await upsertUser({ authProvider: "view-total", providerSubject: createId("subject") });
    const a = await createSite({ mode: "paste", html: "one" }, { anonOwnerId: "total-owner" });
    const summary = async (viewer?: { userId?: string; anonId?: string }) => (await listSiteSummaries(viewer, { withViews: true })).find(s => s.slug === a.site.slug)!;
    expect((await summary({ anonId: "total-owner" })).totalViews).toBe(0);
    const view = { siteId: a.site.id, userId: null, anonId: "total-owner", ip: null, userAgent: null, viewedAt: 1 };
    await recordSiteView(view);
    const share = await createShare({ id: createId("shr"), siteId: a.site.id, tokenHash: createId("hash"), policy: "public", passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null });
    await recordShareView({ ...view, shareId: share.id });
    expect((await summary({ anonId: "total-owner" })).totalViews).toBe(2);
    expect((await listSiteSummaries({ anonId: "total-owner" })).find(s => s.slug === a.site.slug)?.totalViews).toBeUndefined();
    expect((await summary()).totalViews).toBeUndefined();
    await rbacQuery("UPDATE sites SET owner_id=$1,tenant_id='init' WHERE id=$2", [owner.id, a.site.id]);
    expect((await summary({ anonId: "total-owner" })).totalViews).toBeUndefined();
    expect((await summary({ userId: owner.id })).totalViews).toBe(2);
    expect((await listSitesByOwner(owner.id)).find(s => s.slug === a.site.slug)?.totalViews).toBe(2);
  });
  it("replaces a unique designation without moving latest or mutating snapshots", async () => {
    const a = await createSite({ mode: "paste", html: "<h1>one</h1>" });
    const b = committed(await editSite(a.site.slug, { content: "<h1>two</h1>" }, testAudit()));
    const first = await setOfficialVersion(a.site.id, a.version.id, designationContext(a.site), 0);
    expect(first.officialVersionId).toBe(a.version.id);
    expect(first.currentVersionId).toBe(b.version.id);
    const second = await setOfficialVersion(a.site.id, b.version.id, designationContext(a.site), 1);
    expect(second.previousOfficialVersionId).toBe(a.version.id);
    expect((await listVersions(a.site.slug))!.filter(v => v.official)).toHaveLength(1);
    await editSite(a.site.slug, { content: "<h1>three</h1>" }, testAudit());
    expect((await getSite(a.site.id))!.officialVersionId).toBe(b.version.id);
    expect(await readVersionFile(a.site.id, b.version.id, "index.html")).toContain("two");
    await setOfficialVersion(a.site.id, null, designationContext(a.site), 2);
    expect((await getSite(a.site.id))!.officialVersionId).toBeNull();
    expect((await listAudit(a.site.id)).filter(a => a.action.startsWith("official"))).toHaveLength(3);
  });
  it("accepts only one concurrent designation at the same revision", async () => {
    const a = await createSite({ mode: "paste", html: "one" });
    const b = committed(await editSite(a.site.slug, { content: "two" }, testAudit()));
    const results = await Promise.allSettled([a.version.id, b.version.id].map(id =>
      setOfficialVersion(a.site.id, id, designationContext(a.site), 0)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    expect((await getSite(a.site.id))!.officialRevision).toBe(1);
    expect((await listAudit(a.site.id)).filter(row => row.action === "official.set")).toHaveLength(1);
  });
  it("rejects foreign versions and stale revisions, including ABA changes", async () => {
    const a = await createSite({ mode: "paste", html: "a" });
    const b = await createSite({ mode: "paste", html: "b" });
    await expect(setOfficialVersion(a.site.id, b.version.id, designationContext(a.site), 0)).rejects.toMatchObject({ statusCode: 404 });
    await setOfficialVersion(a.site.id, a.version.id, designationContext(a.site), 0);
    await setOfficialVersion(a.site.id, null, designationContext(a.site), 1);
    await expect(setOfficialVersion(a.site.id, a.version.id, designationContext(a.site), 0)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("atomically designates an upload and preserves designation on ordinary edits", async () => {
    const a = await createSite({ mode: "paste", html: "one", official: true }, {}, testAudit());
    expect(a.site.officialVersionId).toBe(a.version.id);
    expect(a.site.officialRevision).toBe(1);
    expect((await listAudit(a.site.id)).some(a => a.action === "official.set")).toBe(true);
    await editSite(a.site.slug, { content: "two" }, testAudit());
    expect((await getSite(a.site.id))!.officialVersionId).toBe(a.version.id);
  });
  it.each([false, true])("records publication before designation, with expected version %s", async (conditional) => {
    const a = await createSite({ mode: "paste", html: "one", official: true }, {}, testAudit());
    expect((await listAudit(a.site.id)).map(row => row.action)).toEqual(["official.set", "create"]);
    await replaceSiteContent(a.site.slug, { mode: "paste", html: "two", official: true }, testAudit(), conditional ? a.version.id : undefined);
    expect((await listAudit(a.site.id)).slice(0, 2).map(row => row.action)).toEqual(["official.set", "edit"]);
  });
  it("rejects dangling official pointers at the database boundary", async () => {
    const a = await createSite({ mode: "paste", html: "one" });
    await expect(rbacQuery("UPDATE sites SET official_version_id=$1 WHERE id=$2", ["missing-version", a.site.id])).rejects.toThrow();
  });
  it("keeps version numbers in insertion order despite clock skew", async () => {
    const owner = await upsertUser({ authProvider: "official-order", providerSubject: createId("subject") });
    const a = await createSite({ mode: "paste", html: "one", official: true }, { ownerId: owner.id }, testAudit());
    const b = committed(await editSite(a.site.slug, { content: "two" }, testAudit()));
    await rbacQuery("UPDATE versions SET created_at=$1 WHERE id=$2", [1, b.version.id]);
    const versions = (await listVersions(a.site.slug))!;
    expect(versions.map(v => [v.id, v.number])).toEqual([[b.version.id, 2], [a.version.id, 1]]);
    expect((await listSitesByOwner(owner.id)).find(v => v.slug === a.site.slug)?.officialVersionNumber).toBe(versions.find(v => v.official)?.number);
  });

});
