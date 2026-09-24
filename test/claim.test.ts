import { adoptAnonymousSites, setSiteOwnerIfUnowned, transferSiteOwner } from "./fixtures/legacy-identity";
// Claiming is the one irreversible identity change in the product, so the guarantees it rests on
// get their own tests: it must be atomic, it must be a one-shot, and it must leave no gap in the
// version history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertAdminLog, attributeUnattributedVersions, claimSiteAudited, clearSiteOwner, closeDbForTests, createId,
  getSite, insertAudit, insertSiteWithVersion, listSitesByOwner,
  updateSiteVisibility, upsertUser, type InsertAuditInput,
} from "@/lib/db";
import { mintSession } from "@/lib/session";
import { POST } from "@/app/api/me/adopt/route";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-claim-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

async function anonymousSite(slug = "s1") {
  const siteId = createId("site");
  await insertSiteWithVersion(
    { id: siteId, slug, title: "t", kind: "single", editToken: "et", visibility: "public" },
    { id: createId("ver"), siteId, entry: "index.html", fileCount: 1, byteSize: 4, source: "upload" },
  );
  return siteId;
}

describe("claiming", () => {
  it("attaches an unowned site to the claimant", async () => {
    const siteId = await anonymousSite();
    const u = await upsertUser({ authProvider: "t", providerSubject: "a" });

    expect((await getSite(siteId))!.ownerId).toBeNull();
    expect(await setSiteOwnerIfUnowned(siteId, u.id)).toBe(true);
    expect((await getSite(siteId))!.ownerId).toBe(u.id);
  });

  // Two people signing in at once must not both end up owning it.
  it("is atomic — a second claimant loses rather than overwriting", async () => {
    const siteId = await anonymousSite();
    const a = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const b = await upsertUser({ authProvider: "t", providerSubject: "b" });

    const [first, second] = await Promise.all([
      setSiteOwnerIfUnowned(siteId, a.id),
      setSiteOwnerIfUnowned(siteId, b.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const owner = (await getSite(siteId))!.ownerId;
    expect([a.id, b.id]).toContain(owner);
  });

  it("cannot be replayed once the site has an owner", async () => {
    const siteId = await anonymousSite();
    const a = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const b = await upsertUser({ authProvider: "t", providerSubject: "b" });

    expect(await setSiteOwnerIfUnowned(siteId, a.id)).toBe(true);
    expect(await setSiteOwnerIfUnowned(siteId, b.id)).toBe(false);
    expect((await getSite(siteId))!.ownerId).toBe(a.id);
  });

  // Open claiming: the audit row is the only accountability left, so "claimed but unrecorded"
  // must be unrepresentable — a failing audit insert has to take the ownership write down with it.
  it("claimSiteAudited rolls the claim back when the audit insert fails", async () => {
    const siteId = await anonymousSite();
    const u = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const row = (id: string): InsertAuditInput => ({
      id, siteId, versionId: null, action: "claim", editorKind: "user",
      actorUserId: u.id, actorAnonId: null, method: "api", ip: null, userAgent: null,
    });

    await insertAudit(row("aud_dup")); // occupy the PK so the transactional insert must fail
    await expect(claimSiteAudited(siteId, u.id, row("aud_dup"))).rejects.toThrow();
    expect((await getSite(siteId))!.ownerId, "audit failed → claim must not survive").toBeNull();

    const adminLog = { id: "adm_dup", actorKind: "user" as const, actorUserId: u.id, action: "site.assign_owner" as const, targetKind: "site" as const, targetId: siteId, reason: "test", ip: null, createdAt: Date.now() };
    await insertAdminLog(adminLog);
    await expect(claimSiteAudited(siteId, u.id, row("aud_log_failure"), adminLog)).rejects.toThrow();
    expect((await getSite(siteId))!.ownerId).toBeNull();

    // And the healthy path commits both sides.
    expect(await claimSiteAudited(siteId, u.id, row("aud_fresh"))).toBe(true);
    expect((await getSite(siteId))!.ownerId).toBe(u.id);
    expect(await claimSiteAudited(siteId, u.id, row("aud_again")), "already owned → false, no throw").toBe(false);
  });

  it("backfills authorship so the anonymous upload is not left unattributed", async () => {
    const siteId = await anonymousSite();
    const u = await upsertUser({ authProvider: "t", providerSubject: "a" });

    const n = await attributeUnattributedVersions(siteId, u.id);
    expect(n).toBe(1);
    // Idempotent: a re-run finds nothing left to attribute and does not touch other people's rows.
    expect(await attributeUnattributedVersions(siteId, u.id)).toBe(0);
  });
});

describe("ownership escape hatches", () => {
  // Production runs with PUBLISH_API_TOKEN empty, so there is no admin to appeal to — a mis-claim
  // has to be recoverable by the owner alone.
  it("disowning returns the site to a claimable state", async () => {
    const siteId = await anonymousSite();
    const a = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const b = await upsertUser({ authProvider: "t", providerSubject: "b" });

    await setSiteOwnerIfUnowned(siteId, a.id);
    await clearSiteOwner(siteId);
    expect((await getSite(siteId))!.ownerId).toBeNull();
    expect(await setSiteOwnerIfUnowned(siteId, b.id)).toBe(true);
  });

  it("transferring moves it directly, without passing through unowned", async () => {
    const siteId = await anonymousSite();
    const a = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const b = await upsertUser({ authProvider: "t", providerSubject: "b" });

    await setSiteOwnerIfUnowned(siteId, a.id);
    await transferSiteOwner(siteId, b.id);
    expect((await getSite(siteId))!.ownerId).toBe(b.id);
  });

  it("lists only the caller's own sites", async () => {
    const s1 = await anonymousSite("one");
    const s2 = await anonymousSite("two");
    const a = await upsertUser({ authProvider: "t", providerSubject: "a" });
    const b = await upsertUser({ authProvider: "t", providerSubject: "b" });

    await setSiteOwnerIfUnowned(s1, a.id);
    await setSiteOwnerIfUnowned(s2, b.id);

    const mine = await listSitesByOwner(a.id);
    expect(mine.map((s) => s.slug)).toEqual(["one"]);
  });
});

// The token route (/api/me/adopt) exists only for sites predating the identity migration, which
// have no creating browser on record. Once a site DOES record one, that is stronger evidence and
// the cookie route settles it — so the token must stop being sufficient. Otherwise holding a
// colleague's shared ?t= token is enough to take their site, including tokens the pre-fix client
// had already filed under the created-by-me prefix.
describe("token-based adoption defers to recorded browser provenance", () => {
  /** Drive the real route as a signed-in caller holding `token` for `slug`. */
  async function adoptViaRoute(slug: string, token: string, userId: string) {
    const { cookie } = await mintSession(new Request("https://x/", { headers: { "x-forwarded-proto": "https" } }), userId);
    const res = await POST(new Request("https://x/api/me/adopt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://x",
        "x-forwarded-proto": "https",
        cookie: cookie.split(";")[0],
      },
      body: JSON.stringify({ sites: [{ slug, editToken: token }] }),
    }));
    return res.status;
  }

  it("refuses a site that recorded its creating browser, so a shared token cannot take it", async () => {
    const id = createId("site");
    await insertSiteWithVersion(
      { id, slug: "has-anon", title: "t", kind: "single", editToken: "et", anonOwnerId: "anon_creator", visibility: "public" },
      { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    const recipient = await upsertUser({ authProvider: "t", providerSubject: "recipient" });

    // The recipient holds a valid token for an unowned site — everything the old check asked for.
    expect(await adoptViaRoute("has-anon", "et", recipient.id)).toBe(400);
    expect((await getSite(id))!.ownerId).toBeNull();

    // And the creator still gets it, through the cookie route that actually knows who they are.
    const creator = await upsertUser({ authProvider: "t", providerSubject: "creator" });
    expect(await adoptAnonymousSites("anon_creator", creator.id)).toBe(1);
    expect((await getSite(id))!.ownerId).toBe(creator.id);
  });

  it("refuses token-only automatic adoption of pre-identity sites", async () => {
    const id = createId("site");
    await insertSiteWithVersion(
      { id, slug: "legacy", title: "t", kind: "single", editToken: "et", visibility: "public" },
      { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    const author = await upsertUser({ authProvider: "t", providerSubject: "legacy-author" });
    expect(await adoptViaRoute("legacy", "et", author.id)).toBe(400);
    expect((await getSite(id))!.ownerId).toBeNull();
  });

  it("still rejects a wrong token on a pre-identity site", async () => {
    const id = createId("site");
    await insertSiteWithVersion(
      { id, slug: "legacy2", title: "t", kind: "single", editToken: "et", visibility: "public" },
      { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    const stranger = await upsertUser({ authProvider: "t", providerSubject: "stranger" });
    expect(await adoptViaRoute("legacy2", "guessed", stranger.id)).toBe(400);
    expect((await getSite(id))!.ownerId).toBeNull();
  });
});

describe("anonymous browser identity", () => {
  it("adopts every site from a browser on sign-in, in one statement", async () => {
    const a = createId("site");
    const b = createId("site");
    for (const [id, slug] of [[a, "a1"], [b, "b1"]] as const) {
      await insertSiteWithVersion(
        { id, slug, title: "t", kind: "single", editToken: "e", anonOwnerId: "anon_browser_1", visibility: "public" },
        { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
      );
    }
    const u = await upsertUser({ authProvider: "t", providerSubject: "a" });

    expect(await adoptAnonymousSites("anon_browser_1", u.id)).toBe(2);
    expect((await getSite(a))!.ownerId).toBe(u.id);
    expect((await getSite(b))!.ownerId).toBe(u.id);
    // The anonymous marker is cleared, so a second browser presenting the same id gets nothing.
    expect((await getSite(a))!.anonOwnerId).toBeNull();
    expect(await adoptAnonymousSites("anon_browser_1", u.id)).toBe(0);
  });

  it("never pulls a site away from an account that already owns it", async () => {
    const id = createId("site");
    const owner = await upsertUser({ authProvider: "t", providerSubject: "owner" });
    const other = await upsertUser({ authProvider: "t", providerSubject: "other" });
    await insertSiteWithVersion(
      { id, slug: "owned", title: "t", kind: "single", editToken: "e", anonOwnerId: "anon_browser_2", ownerId: owner.id, visibility: "public" },
      { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );

    expect(await adoptAnonymousSites("anon_browser_2", other.id)).toBe(0);
    expect((await getSite(id))!.ownerId).toBe(owner.id);
  });
});

describe("disowning", () => {
  it("also closes the open edit tier", async () => {
    const id = createId("site");
    const owner = await upsertUser({ authProvider: "t", providerSubject: "o" });
    await insertSiteWithVersion(
      { id, slug: "opened", title: "t", kind: "single", editToken: "e", ownerId: owner.id, visibility: "public" },
      { id: createId("ver"), siteId: id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
    );
    await updateSiteVisibility(id, "public");

    // Disowning while 'login' stayed set left the site writable by every authenticated user with
    // nobody able to change it back — sharing settings are owner-only, and there was no owner.
    await clearSiteOwner(id);
    const after = (await getSite(id))!;
    expect(after.ownerId).toBeNull();
  });
});
