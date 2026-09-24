import { addCollaborator, setSiteOwnerIfUnowned } from "./fixtures/legacy-identity";
// Unlisted — the read side of the `visibility` column.
//
// The column had a writer (PUT /api/sites/:slug/sharing) and no reader at all: a site set to
// `unlisted` kept its card on the home page and its row in GET /api/sites, so the setting promised
// something the product never did. These tests pin both halves of the fix, because the obvious
// over-correction is worse than the bug — hiding a site from the person who made it.
//
//   listed      · a stranger's directory contains public rows and nothing else
//   still there · unlisted is NOT private: the direct link keeps working, unauthenticated
//   still mine  · owner and collaborator views are unfiltered, and the directory makes an
//                 exception for rows the asking viewer owns
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listGET } from "@/app/api/sites/route";
import { GET as itemGET } from "@/app/api/sites/[slug]/route";
import { GET as previewGET } from "@/app/api/preview/[slug]/[[...path]]/route";
import {
  closeDbForTests,
  rbacQuery,
  recordSiteView,
  pruneSiteViews,
  listSitesByOwner,
  listSitesForCollaborator,
  updateSiteVisibility,
  upsertUser,
} from "@/lib/db";
import { createSite, getSiteView, listSites } from "@/lib/sites";
import type { Site, Visibility } from "@/lib/types";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-visibility-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

/** A live site with a title, optionally owned and optionally not-public. */
async function makeSite(
  title: string,
  visibility: Visibility = "public",
  owner: { anonOwnerId?: string | null; ownerId?: string | null } = {},
): Promise<Site> {
  const { site } = await createSite({ mode: "paste", html: `<html><head><title>${title}</title></head><body>${title}</body></html>` }, owner);
  if (visibility !== "public") await updateSiteVisibility(site.id, visibility);
  return site;
}

const slugs = async (viewer?: { userId?: string | null; anonId?: string | null }) =>
  (await listSites(viewer)).map((s) => s.slug);

describe("the public listing excludes unlisted sites", () => {
  it("listSites() — a stranger sees the public site and not the unlisted one", async () => {
    const open = await makeSite("Public");
    const hidden = await makeSite("Unlisted", "unlisted");

    expect(await slugs()).toEqual([open.slug]);
    expect(await slugs()).not.toContain(hidden.slug);
  });

  it("`private` is excluded from the directory too", async () => {
    const open = await makeSite("Public");
    const secret = await makeSite("Private", "private");

    expect(await slugs()).toEqual([open.slug]);
    expect(await slugs()).not.toContain(secret.slug);
  });

  it("GET /api/sites — the public collection endpoint drops it as well", async () => {
    const open = await makeSite("Public");
    const hidden = await makeSite("Unlisted", "unlisted");

    const res = await listGET();
    expect(res.status).toBe(200);
    const { sites } = (await res.json()) as { sites: { slug: string }[] };
    expect(sites.map((s) => s.slug)).toContain(open.slug);
    expect(sites.map((s) => s.slug)).not.toContain(hidden.slug);
  });

  it("flipping the switch back to public re-lists it", async () => {
    const site = await makeSite("Toggle", "unlisted");
    expect(await slugs()).not.toContain(site.slug);

    await updateSiteVisibility(site.id, "public");
    expect(await slugs()).toContain(site.slug);
  });
});

// Unlisted ≠ inaccessible. The label promises the site stays reachable to anyone holding the link,
// so an over-eager filter that also gated the read path would break the feature it implements.
describe("unlisted is still reachable by direct link", () => {
  it("getSiteView (what /s/:slug renders from) resolves it", async () => {
    const hidden = await makeSite("Unlisted", "unlisted");
    const view = await getSiteView(hidden.slug);
    expect(view?.site.slug).toBe(hidden.slug);
    expect(view?.site.visibility).toBe("unlisted");
  });

  it("GET /api/sites/:slug denies source download to a view-only stranger", async () => {
    const hidden = await makeSite("Unlisted", "unlisted");
    const res = await itemGET(
      new Request(`http://test.local/api/sites/${hidden.slug}`),
      { params: Promise.resolve({ slug: hidden.slug }) },
    );
    expect(res.status).toBe(403);

  });

  it("the served page itself still renders", async () => {
    const hidden = await makeSite("Unlisted", "unlisted");
    const res = await previewGET(
      new Request(`http://test.local/api/preview/${hidden.slug}/`),
      { params: Promise.resolve({ slug: hidden.slug, path: undefined }) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unlisted");
  });
});

// The failure mode that would be worse than the bug: a switch that hides a site from its author.
describe("owner views stay unfiltered", () => {
  it("listSitesByOwner still returns my unlisted site", async () => {
    const user = await upsertUser({ authProvider: "t", providerSubject: "owner" });
    const hidden = await makeSite("Mine", "unlisted", { ownerId: user.id });
    const open = await makeSite("Also mine", "public", { ownerId: user.id });

    const mine = (await listSitesByOwner(user.id)).map((s) => s.slug);
    expect(mine).toContain(hidden.slug);
    expect(mine).toContain(open.slug);
  });

  it("listSitesForCollaborator still returns an unlisted site I may edit", async () => {
    const owner = await upsertUser({ authProvider: "t", providerSubject: "owner" });
    const mate = await upsertUser({ authProvider: "t", providerSubject: "mate" });
    const hidden = await makeSite("Shared", "unlisted", { ownerId: owner.id });
    await addCollaborator(hidden.id, mate.id, owner.id);

    expect((await listSitesForCollaborator(mate.id)).map((s) => s.slug)).toContain(hidden.slug);
  });

  it("the directory makes an exception for the signed-in owner — and only for them", async () => {
    const me = await upsertUser({ authProvider: "t", providerSubject: "me" });
    const someone = await upsertUser({ authProvider: "t", providerSubject: "someone" });
    const hidden = await makeSite("Mine", "unlisted", { ownerId: me.id });

    expect(await slugs({ userId: me.id })).toContain(hidden.slug);
    expect(await slugs({ userId: someone.id })).not.toContain(hidden.slug);
    expect(await slugs()).not.toContain(hidden.slug);
  });

  it("the directory makes the same exception for the anonymous browser that created it", async () => {
    const hidden = await makeSite("Anon mine", "unlisted", { anonOwnerId: "anon_me" });

    expect(await slugs({ anonId: "anon_me" })).toContain(hidden.slug);
    expect(await slugs({ anonId: "anon_someone_else" })).not.toContain(hidden.slug);
    expect(await slugs()).not.toContain(hidden.slug);
  });

  it("once an account claims the site the creating browser loses the exception", async () => {
    const claimer = await upsertUser({ authProvider: "t", providerSubject: "claimer" });
    const hidden = await makeSite("Claimed", "unlisted", { anonOwnerId: "anon_me" });

    expect(await slugs({ anonId: "anon_me" })).toContain(hidden.slug);
    expect(await setSiteOwnerIfUnowned(hidden.id, claimer.id)).toBe(true);
    // anon_owner_id survives the claim on the row; the predicate must still defer to the account,
    // exactly as resolveCapability does.
    expect(await slugs({ anonId: "anon_me" })).not.toContain(hidden.slug);
    expect(await slugs({ userId: claimer.id })).toContain(hidden.slug);
  });

  it("an empty/blank viewer is the stranger, never a wildcard", async () => {
    const hidden = await makeSite("Mine", "unlisted", { anonOwnerId: "anon_me" });

    expect(await slugs({})).not.toContain(hidden.slug);
    expect(await slugs({ userId: null, anonId: null })).not.toContain(hidden.slug);
  });

  // A collaborator is not the owner, so the two "it's mine" arms miss them — and the miss is not
  // just a missing card. The home page treats this list as the set of sites that still EXIST:
  // pruneRecent and pruneAssignments delete anything absent from it. Leave collaborators out and
  // someone who can still open and edit the site silently loses their recent-shelf entry and its
  // folder, while their My sites tab (listSitesForCollaborator, unfiltered) still shows it —
  // which is precisely what would make the loss impossible to explain.
  it("a collaborator's directory keeps the unlisted site they were granted", async () => {
    const owner = await upsertUser({ authProvider: "t", providerSubject: "collab-owner" });
    const mate = await upsertUser({ authProvider: "t", providerSubject: "collab-mate" });
    const shared = await makeSite("Shared", "unlisted", { ownerId: owner.id });
    await addCollaborator(shared.id, mate.id, owner.id);

    expect(await slugs({ userId: mate.id })).toContain(shared.slug);
    expect(await slugs({ userId: owner.id })).toContain(shared.slug);
    // …and it stays hidden from everyone else.
    const stranger = await upsertUser({ authProvider: "t", providerSubject: "collab-stranger" });
    expect(await slugs({ userId: stranger.id })).not.toContain(shared.slug);
    expect(await slugs()).not.toContain(shared.slug);
  });
});


describe("home recently updated ownership", () => {
  it("returns only owned sites, newest update first, excluding collaboration and browser ownership when signed in", async () => {
    const owner = await upsertUser({ authProvider: "test", providerSubject: "home-owner" });
    const other = await upsertUser({ authProvider: "test", providerSubject: "home-other" });
    const a = await makeSite("Older", "private", { ownerId: owner.id });
    const b = await makeSite("Newer", "unlisted", { ownerId: owner.id });
    const collab = await makeSite("Collaborating", "private", { ownerId: other.id });
    await addCollaborator(collab.id, owner.id);
    const browser = await makeSite("Browser", "private", { anonOwnerId: "browser" });
    await makeSite("Stranger public");
    await rbacQuery("UPDATE sites SET updated_at=$1 WHERE id=$2", [100, a.id]);
    await rbacQuery("UPDATE sites SET updated_at=$1 WHERE id=$2", [200, b.id]);
    const owned = await listSites({ userId: owner.id, anonId: "browser" }, { ownedOnly: true });
    expect(owned.map(s => s.slug)).toEqual([b.slug, a.slug]);
    expect((await listSites({ userId: owner.id }, { ownedOnly: true, limit: 1 })).map(s => s.slug)).toEqual([b.slug]);
    expect((await listSites({ anonId: "browser" }, { ownedOnly: true })).map(s => s.slug)).toEqual([browser.slug]);
    expect(await listSites({}, { ownedOnly: true })).toEqual([]);
  });
  it("keeps cumulative opens after detail retention runs repeatedly", async () => {
    const s = await makeSite("Retention", "private", { anonOwnerId: "author" });
    for (const viewedAt of [10, 20, 30]) await recordSiteView({ siteId: s.id, userId: null, anonId: "reader", ip: null, userAgent: null, viewedAt });
    const total = async () => (await listSites({ anonId: "author" }, { withViews: true, ownedOnly: true }))[0].totalViews;
    expect(await total()).toBe(3);
    expect(await pruneSiteViews(25)).toBe(2);
    expect(await total()).toBe(3);
    expect(await pruneSiteViews(25)).toBe(0);
    expect(await total()).toBe(3);
  });
  it("keeps each site's total when equal timestamps straddle the cleanup batch boundary", async () => {
    const a = await makeSite("Tied A", "private", { anonOwnerId: "author" });
    const b = await makeSite("Tied B", "private", { anonOwnerId: "author" });
    for (let i = 0; i < 1001; i++) await recordSiteView({ siteId: i % 2 ? b.id : a.id, userId: null, anonId: "reader", ip: null, userAgent: null, viewedAt: 1 });
    const totals = async () => Object.fromEntries((await listSites({ anonId: "author" }, { withViews: true, ownedOnly: true })).map(s => [s.slug, s.totalViews]));
    const expected = { [a.slug]: 501, [b.slug]: 500 };
    expect(await totals()).toEqual(expected);
    expect(await pruneSiteViews(2)).toBe(1000);
    expect(await totals()).toEqual(expected);
    expect(await pruneSiteViews(2)).toBe(1);
    expect(await totals()).toEqual(expected);
  });

});
