import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDbForTests, createId, getSite, rbacQuery, updateSiteVisibility, upsertUser } from "@/lib/db";
import { createSite, editSite, renameSite, replaceSiteContent, rollbackTo } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { readDirectory } from "@/lib/directory";
import { canReadSite } from "@/lib/share";
import { createUserFolder, assignUserSite } from "@/lib/user-folders";
import { getSiteSharing, moveSharing, scopeChange } from "@/lib/sharing-defaults";
import { PUT as mainSharing } from "@/app/api/sites/[slug]/main-sharing/route";
import { PUT as legacySharing } from "@/app/api/sites/[slug]/sharing/route";
import { POST as batchSharing } from "@/app/api/me/sharing/batch/route";
import { testAudit } from "./helpers";
import type { Site } from "@/lib/types";

const origin = "https://sharing.test";
beforeEach(() => {
  vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "private");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDbForTests();
});

async function fixture() {
  const owner = await upsertUser({ authProvider: "timestamp-test", providerSubject: createId("owner") });
  const { cookie } = await mintSession(new Request(origin), owner.id);
  const request = (body?: unknown, method = "PUT") => new Request(origin + "/api/test", {
    method, headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sites: Site[] = [];
  for (let i = 0; i < 3; i++) {
    const { site } = await createSite({ mode: "paste", html: `<title>Document ${i}</title><p>Original content</p>` }, { ownerId: owner.id });
    await rbacQuery("UPDATE sites SET updated_at=$1 WHERE id=$2", [Date.now() - (3 - i) * 86400000, site.id]);
    sites.push((await getSite(site.id))!);
  }
  const directory = () => readDirectory({ userId: owner.id }, { scope: "owned", folder: "all", q: "", sort: "updated", page: 0 });
  const snapshot = async () => (await directory()).sites.map(({ slug, updatedAt, versionCount }) => ({ slug, updatedAt, versionCount }));
  const before = await snapshot();
  const unchanged = async () => {
    expect(await snapshot()).toEqual(before);
    for (const site of sites) expect((await getSite(site.id))!.currentVersionId).toBe(site.currentVersionId);
  };
  return { owner, sites, request, directory, unchanged };
}

it.each(["main", "legacy", "store"] as const)("preserves timestamps and ordering through %s visibility changes", async entry => {
  const f = await fixture(), site = f.sites[0];
  const context = { params: Promise.resolve({ slug: site.slug }) };
  for (const visibility of ["unlisted", "unlisted", "public", "private"] as const) {
    if (entry === "store") await updateSiteVisibility(site.id, visibility);
    else {
      const response = entry === "main"
        ? await mainSharing(f.request({ action: "custom", policy: { audience: visibility === "unlisted" ? "anyone" : visibility, comments: true } }), context)
        : await legacySharing(f.request({ visibility }), context);
      expect(response.status).toBe(200);
    }
    const fresh = (await getSite(site.id))!;
    expect(fresh.visibility).toBe(visibility);
    expect(await canReadSite(new Request(origin), fresh)).toBe(visibility !== "private");
    await f.unchanged();
  }
});

it("preserves timestamps for comment-only changes, passcode resets and stopping sharing", async () => {
  const f = await fixture(), site = f.sites[0];
  const context = { params: Promise.resolve({ slug: site.slug }) };
  for (const input of [
    { action: "custom", policy: { audience: "private", comments: false } },
    { action: "custom", policy: { audience: "passcode", comments: false } },
    { action: "reset-passcode" },
    { action: "stop" },
  ]) {
    const response = await mainSharing(f.request(input), context);
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.policy).toEqual(input.policy ?? { audience: input.action === "stop" ? "private" : "passcode", comments: false });
    await f.unchanged();
  }
});

it.each(["folder", "all"] as const)("keeps %s followers in content order while access and filters change", async scope => {
  const f = await fixture();
  const folderId = scope === "folder" ? (await createUserFolder(f.owner.id, "Shared folder")).id : null;
  const targets = folderId ? f.sites.slice(0, 2) : f.sites;
  if (folderId) for (const site of targets) await assignUserSite(f.owner.id, site.slug, folderId);
  for (const comments of [true, true, false]) {
    const input = { enabled: true, policy: { audience: "anyone" as const, comments } };
    const preview = await scopeChange(f.request(), folderId, input);
    await f.unchanged();
    await scopeChange(f.request(), folderId, { ...input, confirmation: preview.confirmation });
    for (const site of targets) {
      expect(await getSiteSharing((await getSite(site.id))!)).toMatchObject({ policy: input.policy, source: scope });
      expect(await canReadSite(new Request(origin), (await getSite(site.id))!)).toBe(true);
    }
    expect((await f.directory()).sharingCounts).toEqual({ all: 3, shared: targets.length, private: 3 - targets.length });
    await f.unchanged();
  }
  const preview = await scopeChange(f.request(), folderId, { enabled: false });
  await scopeChange(f.request(), folderId, { enabled: false, confirmation: preview.confirmation });
  expect((await f.directory()).sharingCounts).toEqual({ all: 3, shared: 0, private: 3 });
  await f.unchanged();
});

it("preserves timestamps when moving into and out of a shared folder", async () => {
  const f = await fixture();
  const folder = await createUserFolder(f.owner.id, "Shared folder");
  const input = { enabled: true, policy: { audience: "anyone" as const, comments: true } };
  const preview = await scopeChange(f.request(), folder.id, input);
  await scopeChange(f.request(), folder.id, { ...input, confirmation: preview.confirmation });
  for (const folderId of [folder.id, null]) {
    const move = await moveSharing(f.request(), [f.sites[0].slug], folderId);
    await moveSharing(f.request(), [f.sites[0].slug], folderId, move.confirmation);
    expect((await getSiteSharing((await getSite(f.sites[0].id))!)).policy.audience).toBe(folderId ? "anyone" : "private");
    await f.unchanged();
  }
});

it("preserves timestamps and directory order after selected-site sharing updates", async () => {
  const f = await fixture();
  for (const changes of [{ audience: "anyone" }, { comments: false }, { comments: false }]) {
    const input = { slugs: f.sites.slice(0, 2).map(site => site.slug), changes };
    const preview = await batchSharing(f.request(input, "POST"));
    expect(preview.status).toBe(200);
    const { snapshot, confirmation } = await preview.json();
    const saved = await batchSharing(f.request({ ...input, expectedSnapshot: snapshot, confirmation }, "POST"));
    expect(saved.status).toBe(200);
    expect((await f.directory()).sharingCounts).toEqual({ all: 3, shared: 2, private: 1 });
    for (const site of f.sites.slice(0, 2)) expect((await getSiteSharing((await getSite(site.id))!)).policy).toMatchObject(changes);
    await f.unchanged();
  }
});

it.each(["edit", "upload", "rollback", "rename"] as const)("still advances the timestamp and directory position after %s", async action => {
  const f = await fixture(), site = f.sites[0];
  const audit = testAudit({ actor: { kind: "user", userId: f.owner.id, anonId: null }, authorizationRequest: f.request() });
  if (action === "edit") await editSite(site.slug, { content: "<p>Edited content</p>" }, audit);
  else if (action === "upload") await replaceSiteContent(site.slug, { mode: "paste", html: "<p>Uploaded replacement</p>" }, audit);
  else if (action === "rollback") await rollbackTo(site.slug, site.currentVersionId!, audit);
  else await renameSite(site.slug, "Renamed document", audit);
  const first = (await f.directory()).sites[0];
  expect(first.slug).toBe(site.slug);
  expect(first.updatedAt).toBeGreaterThan(site.updatedAt);
  expect(first.versionCount).toBe(action === "rename" ? 1 : 2);
});
