// Share links — the storage layer.
//
// These are the queries the read gate will sit on, so the tests are written as the gate's
// questions rather than as CRUD coverage:
//
//   secrets       · the owner-facing projection must not carry token_hash / passcode_hash
//   live          · revoked and expired links are OUT; a link with no expiry stays in
//   admits        · account grant, e-mail grant folded on case — and a reader with no VERIFIED
//                   address matches no e-mail row at all
//   one reader    · the view-collapsing identity is a strict ladder (account, else browser, else
//                   IP), never an OR across the three
//   idempotent    · re-inviting the same person is a no-op, on either partial unique index
//   retention     · pruning takes what is strictly older than the line and leaves the line itself
//
// The suite runs on SQLite. The Postgres half of each contract is asserted in
// test/db-postgres.integration.test.ts, which needs a real server and skips without one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addShareGrant,
  closeDbForTests,
  createShare,
  getShare,
  getShareByTokenHash,
  hasRecentShareView,
  insertSite,
  listLiveShares,
  listShareGrants,
  listShareViews,
  listShares,
  pruneShareViews,
  recordShareView,
  removeShareGrant,
  revokeShare,
  shareAdmits,
  updateSharePolicy,
  upsertUser,
} from "@/lib/db";
import type { InsertShareInput, Share, User } from "@/lib/types";

const SITE = "site_share";
/** A fixed clock. Wall-clock ms would make the expiry boundaries flaky for no benefit. */
const T = 1_700_000_000_000;

const dirs: string[] = [];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-share-store-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  // site_shares.site_id is a real FK, so every test needs its site to exist first.
  await insertSite({ id: SITE, slug: "share-store-slug", title: "Share Store", kind: "single", editToken: "tok", visibility: "public" });
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

let seq = 0;
/** A share on SITE. Defaults are the boring case; every test overrides just what it is about. */
async function mkShare(over: Partial<InsertShareInput> = {}): Promise<Share> {
  seq += 1;
  const input: InsertShareInput = {
    id: `shr_${seq}`,
    siteId: SITE,
    tokenHash: `token-hash-${seq}`, // UNIQUE column — never reuse one
    policy: "login",
    passcodeHash: null,
    label: null,
    createdBy: null,
    createdAnonId: null,
    expiresAt: null,
    ...over,
  };
  return createShare(input);
}

function mkUser(subject: string, displayName?: string): Promise<User> {
  return upsertUser({ authProvider: "test", providerSubject: subject, displayName: displayName ?? null });
}

describe("allowAi (the AI Q&A tier) — off unless the owner says so", () => {
  it("defaults false, round-trips true, and flips via its own setter", async () => {
    const { setShareAllowAi } = await import("@/lib/db");
    const off = await mkShare();
    expect(off.allowAi).toBe(false);

    const on = await mkShare({ allowAi: true });
    expect(on.allowAi).toBe(true);
    expect((await getShare(on.id))?.allowAi).toBe(true);

    await setShareAllowAi(on.id, false);
    expect((await getShare(on.id))?.allowAi).toBe(false);
    // The setter touches ONLY the flag — policy/passcode/expiry stay put.
    expect((await getShare(on.id))?.policy).toBe("login");
  });
});

describe("createShare / getShare*", () => {
  it("round-trips every field, and the Share projection carries neither hash", async () => {
    const owner = await mkUser("owner", "站长");
    const before = Date.now();
    const share = await createShare({
      id: "shr_one",
      siteId: SITE,
      tokenHash: "token-hash-one",
      token: "recoverable-token",
      policy: "passcode",
      passcodeHash: "passcode-hash-one",
      label: "给客户的",
      createdBy: owner.id,
      createdAnonId: null,
      expiresAt: T,
    });

    expect(share).toMatchObject({
      id: "shr_one",
      siteId: SITE,
      policy: "passcode",
      label: "给客户的",
      hasPasscode: true, // derived from the hash — there is no boolean column
      createdBy: owner.id,
      createdAnonId: null,
      expiresAt: T,
      revokedAt: null,
    });
    expect(share.createdAt).toBeGreaterThanOrEqual(before);

    // The whole reason token_hash is stored instead of the token: neither hash may leave lib/.
    expect(Object.keys(share)).not.toContain("tokenHash");
    expect(Object.keys(share)).not.toContain("passcodeHash");
    expect(JSON.stringify(share)).not.toContain("token-hash-one");
    expect(JSON.stringify(share)).not.toContain("passcode-hash-one");

    // …but the storage-layer read does carry them, because the gate has to compare them.
    const row = await getShareByTokenHash("token-hash-one");
    expect(row?.id).toBe("shr_one");
    expect(row?.token).toBe("recoverable-token");
    expect(share).not.toHaveProperty("token");
    expect(row?.tokenHash).toBe("token-hash-one");
    expect(row?.passcodeHash).toBe("passcode-hash-one");
    expect(row?.createdAt).toBe(share.createdAt);
    expect(row?.expiresAt).toBe(T);

    expect((await getShare("shr_one"))?.tokenHash).toBe("token-hash-one");
    expect(await getShareByTokenHash("no-such-hash")).toBeNull();
    expect(await getShare("shr_missing")).toBeNull();
  });

  it("a share with no passcode reports hasPasscode false and a null hash", async () => {
    const share = await mkShare({ policy: "login" });
    expect(share.hasPasscode).toBe(false);
    expect((await getShare(share.id))?.passcodeHash).toBeNull();
  });

  it("getShareByTokenHash returns revoked and expired rows too — the caller decides", async () => {
    // "Revoked" and "never existed" must be able to answer identically at the HTTP layer, which
    // only works if the lookup itself hands back the dead row rather than hiding it.
    const share = await mkShare({ tokenHash: "dead-hash", expiresAt: T - 1 });
    await revokeShare(share.id, T);
    const row = await getShareByTokenHash("dead-hash");
    expect(row?.id).toBe(share.id);
    expect(row?.revokedAt).toBe(T);
  });

  it("updateSharePolicy assigns all three columns — null clears the passcode and the expiry", async () => {
    const share = await mkShare({ policy: "passcode", passcodeHash: "pc", expiresAt: T });
    await updateSharePolicy(share.id, "login", null, null);
    const row = await getShare(share.id);
    expect(row?.policy).toBe("login");
    expect(row?.passcodeHash).toBeNull();
    expect(row?.hasPasscode).toBe(false);
    expect(row?.expiresAt).toBeNull();
  });

  it("revokeShare keeps the first revocation's timestamp", async () => {
    const share = await mkShare();
    await revokeShare(share.id, T);
    await revokeShare(share.id, T + 60_000); // re-revoking is a no-op, not a rewrite
    expect((await getShare(share.id))?.revokedAt).toBe(T);
  });
});

describe("listLiveShares — the read gate's input", () => {
  it("drops revoked and expired links, keeps the one with no expiry", async () => {
    const forever = await mkShare({ expiresAt: null });
    const later = await mkShare({ expiresAt: T + 60_000 });
    const boundary = await mkShare({ expiresAt: T }); // expires exactly now
    const past = await mkShare({ expiresAt: T - 1 });
    const revoked = await mkShare({ expiresAt: null });
    await revokeShare(revoked.id, T - 5_000);

    const live = (await listLiveShares(SITE, T)).map((s) => s.id);
    expect(live).toContain(forever.id); // expires_at IS NULL never expires
    expect(live).toContain(later.id);
    expect(live).not.toContain(boundary.id); // `> now`, not `>= now`
    expect(live).not.toContain(past.id);
    expect(live).not.toContain(revoked.id);
    expect(live).toHaveLength(2);

    // ShareRow, not Share: the gate is the one caller that must see the passcode hash.
    expect(await listLiveShares(SITE, T)).toSatisfy((rows: unknown) =>
      (rows as { tokenHash?: string }[]).every((r) => typeof r.tokenHash === "string"));

    // Another site's links are never in this list.
    await insertSite({ id: "site_other", slug: "other-slug", title: "Other", kind: "single", editToken: "t", visibility: "public" });
    await mkShare({ siteId: "site_other" });
    expect((await listLiveShares(SITE, T)).map((s) => s.id)).toEqual(live);
  });

  it("the expiry moves with the clock", async () => {
    const share = await mkShare({ expiresAt: T });
    expect((await listLiveShares(SITE, T - 1)).map((s) => s.id)).toEqual([share.id]);
    expect(await listLiveShares(SITE, T)).toEqual([]);
    expect(await listLiveShares(SITE, T + 1)).toEqual([]);
  });

  it("listShares keeps everything the site ever minted, in a stable order", async () => {
    const a = await mkShare();
    const b = await mkShare({ expiresAt: T - 1 });
    const c = await mkShare();
    await revokeShare(c.id, T);

    const all = await listShares(SITE);
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort()); // dead links included
    expect(Object.keys(all[0])).not.toContain("tokenHash"); // still the owner-facing projection
    // Same order twice: created_at ties are broken deterministically, not left to the planner.
    expect((await listShares(SITE)).map((s) => s.id)).toEqual(all.map((s) => s.id));
    expect(await listShares("site_nothing")).toEqual([]);
  });
});

describe("shareAdmits", () => {
  it("admits the named account, and an e-mail grant regardless of case", async () => {
    const share = await mkShare({ policy: "people" });
    const invited = await mkUser("invited", "受邀的人");
    const stranger = await mkUser("stranger");

    await addShareGrant(share.id, { userId: invited.id }, null);
    await addShareGrant(share.id, { email: "Boss@Example.COM" }, invited.id);

    expect(await shareAdmits(share.id, invited.id, null)).toBe(true); // by account
    expect(await shareAdmits(share.id, stranger.id, "boss@example.com")).toBe(true);
    expect(await shareAdmits(share.id, stranger.id, "BOSS@EXAMPLE.COM")).toBe(true);
    expect(await shareAdmits(share.id, stranger.id, "Boss@Example.COM")).toBe(true);

    expect(await shareAdmits(share.id, stranger.id, "someone.else@example.com")).toBe(false);

    // Grants are per LINK. The same person on another share of the same site is not admitted here.
    const other = await mkShare({ policy: "people" });
    expect(await shareAdmits(other.id, invited.id, "boss@example.com")).toBe(false);
  });

  it("a reader with no verified address matches no e-mail row, ever", async () => {
    // The one that turns "invite by e-mail" into "anyone signed in", if the e-mail arm is ever
    // written so that a null address degrades to a wildcard.
    const share = await mkShare({ policy: "people" });
    const stranger = await mkUser("stranger");
    await addShareGrant(share.id, { email: "boss@example.com" }, null);

    expect(await shareAdmits(share.id, stranger.id, null)).toBe(false);
    expect(await shareAdmits(share.id, stranger.id, "")).toBe(false); // "" is not an address either
    // Not even for the account that created the grant: an e-mail row has user_id NULL, so the
    // account arm cannot pick it up.
    const granter = await mkUser("granter");
    await addShareGrant(share.id, { email: "second@example.com" }, granter.id);
    expect(await shareAdmits(share.id, granter.id, null)).toBe(false);
  });

  it("says no on a share with no grants at all", async () => {
    const share = await mkShare({ policy: "people" });
    const anyone = await mkUser("anyone");
    expect(await shareAdmits(share.id, anyone.id, "anyone@example.com")).toBe(false);
  });
});

describe("hasRecentShareView — collapsing a refresh", () => {
  async function threeReaders(shareId: string): Promise<void> {
    const view = { siteId: SITE, userAgent: "UA", viewedAt: T };
    await recordShareView({ ...view, shareId, userId: "usr_signed_in", anonId: null, ip: "10.0.0.1" });
    await recordShareView({ ...view, shareId, userId: null, anonId: "anon-1", ip: "10.0.0.2" });
    await recordShareView({ ...view, shareId, userId: null, anonId: null, ip: "10.0.0.3" });
  }

  it("matches by account", async () => {
    const share = await mkShare();
    await threeReaders(share.id);
    expect(await hasRecentShareView(share.id, "usr_signed_in", null, null, T)).toBe(true);
    expect(await hasRecentShareView(share.id, "usr_someone_else", null, null, T)).toBe(false);
  });

  it("matches by browser when there is no account", async () => {
    const share = await mkShare();
    await threeReaders(share.id);
    expect(await hasRecentShareView(share.id, null, "anon-1", null, T)).toBe(true);
    expect(await hasRecentShareView(share.id, null, "anon-2", null, T)).toBe(false);
  });

  it("falls back to the IP only when there is neither", async () => {
    const share = await mkShare();
    await threeReaders(share.id);
    expect(await hasRecentShareView(share.id, null, null, "10.0.0.3", T)).toBe(true);
    expect(await hasRecentShareView(share.id, null, null, "10.0.0.9", T)).toBe(false);
    // No identity at all matches nothing — otherwise every anonymous reader would be one reader.
    expect(await hasRecentShareView(share.id, null, null, null, T)).toBe(false);
  });

  it("is a ladder, not an OR: a present account shadows the browser and the IP", async () => {
    const share = await mkShare();
    await threeReaders(share.id);
    // An account with no row of its own, carrying an anon id and an IP that DO have rows.
    expect(await hasRecentShareView(share.id, "usr_new", "anon-1", "10.0.0.3", T)).toBe(false);
    // Same one rung down: a browser id with no row, carrying an IP that has one.
    expect(await hasRecentShareView(share.id, null, "anon-new", "10.0.0.3", T)).toBe(false);
  });

  it("honours the window and the share", async () => {
    const share = await mkShare();
    const other = await mkShare();
    await threeReaders(share.id);
    expect(await hasRecentShareView(share.id, "usr_signed_in", null, null, T)).toBe(true); // >= since
    expect(await hasRecentShareView(share.id, "usr_signed_in", null, null, T + 1)).toBe(false);
    expect(await hasRecentShareView(other.id, "usr_signed_in", null, null, T)).toBe(false);
  });
});

describe("share grants", () => {
  it("adding the same person twice is a no-op, on either unique index", async () => {
    const share = await mkShare({ policy: "people" });
    const mate = await mkUser("mate", "同事小王");

    await addShareGrant(share.id, { userId: mate.id }, null);
    await addShareGrant(share.id, { userId: mate.id }, null); // no throw, no second row
    await addShareGrant(share.id, { email: "Boss@Example.COM" }, mate.id);
    await addShareGrant(share.id, { email: "boss@example.com" }, mate.id); // same key: lower(email)

    expect(await listShareGrants(share.id)).toHaveLength(2);
  });

  it("names the account behind a grant, and leaves an e-mail grant unnamed", async () => {
    const share = await mkShare({ policy: "people" });
    const mate = await mkUser("mate", "同事小王");
    await addShareGrant(share.id, { userId: mate.id }, null);
    await addShareGrant(share.id, { email: "Boss@Example.COM" }, mate.id);

    const grants = await listShareGrants(share.id);
    const byAccount = grants.find((g) => g.userId != null);
    expect(byAccount).toMatchObject({ shareId: share.id, userId: mate.id, email: null, displayName: "同事小王" });
    expect(byAccount?.grantedAt).toBeGreaterThan(0);

    const byEmail = grants.find((g) => g.email != null);
    // LEFT JOIN, so the row survives with no user behind it — an inner join would drop exactly the
    // people who have not signed in yet, which is what e-mail grants are for.
    expect(byEmail).toMatchObject({ shareId: share.id, userId: null, displayName: null });
    expect(byEmail?.email).toBe("Boss@Example.COM"); // stored as typed, matched case-insensitively
  });

  it("removes by either key, folding e-mail case", async () => {
    const share = await mkShare({ policy: "people" });
    const mate = await mkUser("mate");
    await addShareGrant(share.id, { userId: mate.id }, null);
    await addShareGrant(share.id, { email: "boss@example.com" }, null);

    await removeShareGrant(share.id, { email: "BOSS@EXAMPLE.COM" });
    expect((await listShareGrants(share.id)).map((g) => g.userId)).toEqual([mate.id]);

    await removeShareGrant(share.id, { userId: mate.id });
    expect(await listShareGrants(share.id)).toEqual([]);

    await removeShareGrant(share.id, { userId: mate.id }); // removing what is not there is fine
  });

  it("rejects a target that names neither or both", async () => {
    // Not left to the CHECK constraint: SQLite's INSERT OR IGNORE would swallow the violation and
    // report success, so the two backends would disagree about what happened.
    const share = await mkShare({ policy: "people" });
    const mate = await mkUser("mate");
    await expect(addShareGrant(share.id, {}, null)).rejects.toThrow(/exactly one/);
    await expect(addShareGrant(share.id, { userId: null, email: null }, null)).rejects.toThrow(/exactly one/);
    await expect(addShareGrant(share.id, { userId: mate.id, email: "x@y.z" }, null)).rejects.toThrow(/exactly one/);
    await expect(removeShareGrant(share.id, {})).rejects.toThrow(/exactly one/);
    expect(await listShareGrants(share.id)).toEqual([]);
  });
});

describe("share views", () => {
  it("records and lists a view whole, newest first", async () => {
    const share = await mkShare();
    await recordShareView({ shareId: share.id, siteId: SITE, userId: "usr_a", anonId: null, ip: "10.0.0.1", userAgent: "UA/1", viewedAt: T });
    await recordShareView({ shareId: share.id, siteId: SITE, userId: null, anonId: "anon-1", ip: null, userAgent: null, viewedAt: T + 1 });

    const views = await listShareViews(SITE, 10);
    expect(views).toHaveLength(2);
    expect(views[0]).toEqual({ shareId: share.id, siteId: SITE, userId: null, anonId: "anon-1", ip: null, userAgent: null, viewedAt: T + 1 });
    expect(views[1]).toEqual({ shareId: share.id, siteId: SITE, userId: "usr_a", anonId: null, ip: "10.0.0.1", userAgent: "UA/1", viewedAt: T });
    expect(await listShareViews(SITE, 1)).toHaveLength(2 - 1); // the limit is honoured
    expect(await listShareViews("site_nothing", 10)).toEqual([]);
  });

  it("pruneShareViews deletes what is strictly older than the line and reports how many", async () => {
    const share = await mkShare();
    for (const viewedAt of [T - 2, T - 1, T, T + 1]) {
      await recordShareView({ shareId: share.id, siteId: SITE, userId: null, anonId: "a", ip: null, userAgent: null, viewedAt });
    }

    expect(await pruneShareViews(T)).toBe(2); // T-2 and T-1
    expect((await listShareViews(SITE, 10)).map((v) => v.viewedAt)).toEqual([T + 1, T]); // the line itself stays
    expect(await pruneShareViews(T)).toBe(0); // nothing below it any more
    expect(await pruneShareViews(T + 2)).toBe(2); // …and the rest can still go
    expect(await listShareViews(SITE, 10)).toEqual([]);
  });
});
