import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationPolicy } from "@/lib/publication-policy";
import { createSite, editSite } from "@/lib/sites";
import { getReadableView } from "@/lib/read-view";
import { getSite, listVersions, updateSiteVisibility, rbacQuery, listAudit } from "@/lib/db";
import { canReadVersion } from "@/lib/share";
import { POST as create } from "@/app/api/sites/route";
import { operationId, operationOwner, recordPublishedVersion } from "@/lib/publish-operation";
import { POST as edit } from "@/app/api/sites/[slug]/edit/route";
import { committed, testAudit } from "./helpers";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const request = () => new Request("https://publication.example/api/view");

describe("publication integration boundary", () => {
  it("serves new versions immediately by default without weakening private access", async () => {
    const { site } = await createSite({ mode: "paste", html: "first" });
    const updated = committed(await editSite(site.slug, { content: "second" }, testAudit()));
    expect((await getReadableView(request(), site.slug))?.version.id).toBe(updated.version.id);
    await updateSiteVisibility(site.id, "private");
    expect((await getReadableView(request(), site.slug))?.readable).toBe(false);
  });

  it("uses the projected version for reader bytes without changing the stored edit pointer", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "first" });
    const updated = committed(await editSite(site.slug, { content: "second" }, testAudit()));
    vi.spyOn(publicationPolicy, "readerSite").mockImplementation(async (_request, current) => ({ ...current, currentVersionId: version.id }));
    expect((await getReadableView(request(), site.slug))?.version.id).toBe(version.id);
    expect((await getSite(site.id))?.currentVersionId).toBe(updated.version.id);
  });

  it("enforces additional publication constraints for explicit version reads", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "first" });
    vi.spyOn(publicationPolicy, "allowsRequestVersion").mockResolvedValue(false);
    expect(await canReadVersion(request(), site, version.id)).toBe(false);
    expect(await getReadableView(request(), site.slug)).toBeNull();
  });

  it("rolls back a version and its audit when the publication transaction fails", async () => {
    vi.stubEnv("PUBLISH_API_TOKEN", "publication-boundary-test");
    const { site, version } = await createSite({ mode: "paste", html: "first" });
    const beforeAudit = await listAudit(site.id);
    const req = new Request(`https://publication.example/api/sites/${site.slug}/edit`, {
      method: "POST", headers: { authorization: "Bearer publication-boundary-test", "content-type": "application/json", "idempotency-key": "failed-existing-version" }, body: JSON.stringify({ content: "second" }),
    });
    const id = operationId(await operationOwner(req), "failed-existing-version");
    vi.spyOn(publicationPolicy, "commitVersion").mockImplementation(async ({ q, site, versionId }) => {
      await q("UPDATE sites SET title='must roll back' WHERE id=$1", [site.id]);
      await recordPublishedVersion(q, site.id, versionId);
      expect((await q("SELECT state FROM publish_operations WHERE id=$1", [id]))[0].state).toBe("completed");
      throw new Error("Publication transaction rejected");
    });
    const result = await edit(req, { params: Promise.resolve({ slug: site.slug }) });
    expect(result.status).toBe(500);
    expect((await getSite(site.id))?.currentVersionId).toBe(version.id);
    expect((await getSite(site.id))?.title).toBe(site.title);
    expect(await listVersions(site.id)).toHaveLength(1);
    expect(await listAudit(site.id)).toEqual(beforeAudit);
    expect((await rbacQuery("SELECT state,result,lease_until FROM publish_operations WHERE id=$1", [id]))[0]).toMatchObject({ state: "running", result: null });
    expect(Number((await rbacQuery("SELECT lease_until FROM publish_operations WHERE id=$1", [id]))[0].lease_until)).toBe(0);
  });
  it("rolls back authorized creation, its audit and its durable publication result", async () => {
    vi.stubEnv("PUBLISH_API_TOKEN", "publication-boundary-test");
    const req = new Request("https://publication.example/api/sites", {
      method: "POST", headers: { authorization: "Bearer publication-boundary-test", "content-type": "application/json", "idempotency-key": "failed-creation-version" },
      body: JSON.stringify({ mode: "paste", html: "<h1>New site</h1>", official: true }),
    });
    const id = operationId(await operationOwner(req), "failed-creation-version");
    let siteId = "", versionId = "";
    vi.spyOn(publicationPolicy, "commitVersion").mockImplementation(async input => {
      expect(input.creating).toBe(true);
      siteId = input.site.id; versionId = input.versionId;
      await input.publishOfficial();
      await recordPublishedVersion(input.q, siteId, versionId, true);
      expect(await input.q("SELECT id FROM audit_log WHERE site_id=$1", [siteId])).toHaveLength(2);
      expect((await input.q("SELECT state FROM publish_operations WHERE id=$1", [id]))[0].state).toBe("completed");
      throw new Error("Creation publication rejected");
    });
    expect((await create(req)).status).toBe(500);
    expect(siteId).not.toBe("");
    expect(await getSite(siteId)).toBeNull();
    expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [versionId])).toEqual([]);
    expect(await rbacQuery("SELECT id FROM audit_log WHERE site_id=$1", [siteId])).toEqual([]);
    expect(await rbacQuery("SELECT site_id FROM site_comment_settings WHERE site_id=$1", [siteId])).toEqual([]);
    const [operation] = await rbacQuery("SELECT state,result,lease_until FROM publish_operations WHERE id=$1", [id]);
    expect(operation).toMatchObject({ state: "running", result: null });
    expect(Number(operation.lease_until)).toBe(0);
  });
});
