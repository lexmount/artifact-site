// Site-level views — the storage contract for site_views and the read-side aggregates over BOTH view
// tables, plus logSiteOpen's door policy. Written as the product's questions, not CRUD coverage:
//
//   one list      · share_views ∪ site_views come back as ONE newest-first list; a direct open
//                   carries shareId null, a share open keeps its shareId
//   one reader    · the collapse identity is the same strict ladder as share views (account,
//                   else browser, else IP; no identity matches nothing)
//   honest stats  · opens/uniqueViewers clip to the window, lastViewedAt does not; the owner and
//                   collaborators are excluded from the numbers, not from the log
//   viewer key    · unique viewers key on COALESCE(user, anon, ip); a row with none of the three
//                   counts as an open but never as a viewer
//   door policy   · prefetches and crawlers are dropped at the door; a real reader is recorded
//                   once per collapse window
//   retention     · pruneSiteViews takes strictly-older rows and leaves share_views alone
//
// The suite runs on SQLite. The Postgres half is asserted in test/db-postgres.integration.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDbForTests,
  createShare,
  getSite,
  getSiteViewStats,
  hasRecentSiteView,
  insertSite,
  listShareViews,
  listSiteOpens,
  pruneSiteViews,
  recordShareView,
  recordSiteView,
  recordSiteOpen,
  upsertUser,
} from "@/lib/db";
import { config } from "@/lib/config";
import { pruneViewDetails } from "@/lib/view-retention";
import { CRAWLER_UA_RE, logSiteOpen, logShareView } from "@/lib/share";
import type { Session, Site, SiteView } from "@/lib/types";

const SITE = "site_views_site";
/** A fixed clock for the aggregate tests. logSiteOpen uses the wall clock; those tests only rely
 *  on "two calls land inside one collapse window", which is true for any healthy clock. */
const T = 1_700_000_000_000;
const DAY = 86_400_000;

const dirs: string[] = [];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-site-views-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  await insertSite({ id: SITE, slug: "site-views-slug", title: "Site Views", kind: "single", editToken: "tok", visibility: "public" });
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_VIEW_RETENTION_DAYS;
});

/** A direct opening. Defaults are the anonymous-with-ip case; tests override what they are about. */
function mkView(over: Partial<SiteView> = {}): SiteView {
  return { siteId: SITE, userId: null, anonId: null, ip: "10.0.0.9", userAgent: "vitest", viewedAt: T, ...over };
}

async function site(): Promise<Site> {
  return (await getSite(SITE))!;
}

/** The only field logSiteOpen reads off a session. */
function sessionOf(userId: string): Session {
  return { userId } as Session;
}

function requestFor(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/s/site-views-slug", {
    headers: { "x-real-ip": "203.0.113.7", "user-agent": "Mozilla/5.0 (real reader)", ...headers },
  });
}

describe("listSiteOpens — one list, both doors", () => {
  it("merges share_views and site_views newest-first; direct rows carry shareId null", async () => {
    const share = await createShare({
      id: "shr_direct_1", siteId: SITE, tokenHash: "th-direct-1", policy: "public",
      passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null,
    });
    await recordShareView({ shareId: share.id, siteId: SITE, userId: null, anonId: "anon_a", ip: null, userAgent: null, viewedAt: T + 1 });
    await recordSiteView(mkView({ viewedAt: T + 2, anonId: "anon_b", ip: null }));
    await recordSiteView(mkView({ viewedAt: T }));

    const opens = await listSiteOpens(SITE, 10);
    expect(opens.map((o) => o.viewedAt)).toEqual([T + 2, T + 1, T]);
    expect(opens.map((o) => o.shareId)).toEqual([null, share.id, null]);
  });

  it("honours the limit across the union, not per table", async () => {
    await recordSiteView(mkView({ viewedAt: T }));
    await recordSiteView(mkView({ viewedAt: T + 1 }));
    await recordSiteView(mkView({ viewedAt: T + 2 }));
    const opens = await listSiteOpens(SITE, 2);
    expect(opens).toHaveLength(2);
    expect(opens[0].viewedAt).toBe(T + 2);
  });
});

describe("hasRecentSiteView — the identity ladder", () => {
  it("matches an account by account only, a browser by anon id only, and IP only as the last rung", async () => {
    await recordSiteView(mkView({ userId: "u1", anonId: null, ip: "1.1.1.1" }));
    // Same account, different address: still the same reader.
    expect(await hasRecentSiteView(SITE, "u1", null, "9.9.9.9", T - 1)).toBe(true);
    // A signed-out browser at the SAME address is NOT folded into the account's view.
    expect(await hasRecentSiteView(SITE, null, "anon_x", "1.1.1.1", T - 1)).toBe(false);

    await recordSiteView(mkView({ userId: null, anonId: "anon_x", ip: "2.2.2.2", viewedAt: T + 1 }));
    expect(await hasRecentSiteView(SITE, null, "anon_x", "9.9.9.9", T - 1)).toBe(true);
    // No account, no cookie: only now does the address speak — and it matches any row at that
    // address, cookie'd or not (same behaviour as the share-side ladder).
    expect(await hasRecentSiteView(SITE, null, null, "2.2.2.2", T - 1)).toBe(true);
    expect(await hasRecentSiteView(SITE, null, null, "8.8.8.8", T - 1)).toBe(false);
    // A reader with no identity at all matches nothing rather than everything anonymous.
    expect(await hasRecentSiteView(SITE, null, null, null, T - 1)).toBe(false);
  });

  it("respects `since`", async () => {
    await recordSiteView(mkView({ userId: "u1", viewedAt: T }));
    expect(await hasRecentSiteView(SITE, "u1", null, null, T + 1)).toBe(false);
    expect(await hasRecentSiteView(SITE, "u1", null, null, T)).toBe(true);
  });
});

describe("getSiteViewStats — honest numbers", () => {
  it("clips opens/uniqueViewers to the window but lets lastViewedAt range over all time", async () => {
    await recordSiteView(mkView({ viewedAt: T - 30 * DAY, anonId: "anon_old", ip: null }));
    await recordSiteView(mkView({ viewedAt: T - 1, anonId: "anon_new", ip: null }));
    const stats = await getSiteViewStats(SITE, T - 7 * DAY, {});
    expect(stats.opens).toBe(1);
    expect(stats.uniqueViewers).toBe(1);
    expect(stats.lastViewedAt).toBe(T - 1);

    // Nothing in the window at all: counts go to zero, the newest opening is still reported.
    const empty = await getSiteViewStats(SITE, T + 1, {});
    expect(empty.opens).toBe(0);
    expect(empty.uniqueViewers).toBe(0);
    expect(empty.lastViewedAt).toBe(T - 1);
  });

  it("aggregates across BOTH tables and keys unique viewers on account, else browser, else IP", async () => {
    const share = await createShare({
      id: "shr_stats_1", siteId: SITE, tokenHash: "th-stats-1", policy: "public",
      passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null,
    });
    // One person, two doors: same anon id through the share link and directly.
    await recordShareView({ shareId: share.id, siteId: SITE, userId: null, anonId: "anon_dual", ip: "5.5.5.5", userAgent: null, viewedAt: T });
    await recordSiteView(mkView({ anonId: "anon_dual", ip: "5.5.5.5", viewedAt: T + 1 }));
    // A second reader identified only by address.
    await recordSiteView(mkView({ anonId: null, ip: "6.6.6.6", viewedAt: T + 2 }));
    // A row with no identity at all: an open, but not an attributable viewer.
    await recordSiteView(mkView({ anonId: null, ip: null, viewedAt: T + 3 }));

    const stats = await getSiteViewStats(SITE, T - 1, {});
    expect(stats.opens).toBe(4);
    expect(stats.uniqueViewers).toBe(2); // anon_dual + 6.6.6.6; the identity-less row counts nowhere
    expect(stats.lastViewedAt).toBe(T + 3);
  });

  it("excludes the given accounts from all three numbers — and an empty list excludes nobody", async () => {
    const owner = await upsertUser({ authProvider: "test", providerSubject: "owner", displayName: "站长" });
    await recordSiteView(mkView({ userId: owner.id, anonId: null, ip: null, viewedAt: T + 5 }));
    await recordSiteView(mkView({ anonId: "anon_guest", ip: null, viewedAt: T }));

    const excluded = await getSiteViewStats(SITE, T - 1, { userIds: [owner.id] });
    expect(excluded.opens).toBe(1);
    expect(excluded.uniqueViewers).toBe(1);
    // The owner's later visit must not leak through as "last opened".
    expect(excluded.lastViewedAt).toBe(T);

    const everyone = await getSiteViewStats(SITE, T - 1, {});
    expect(everyone.opens).toBe(2);
    expect(everyone.lastViewedAt).toBe(T + 5);
  });

  it("excludes an ANONYMOUS owner by browser id — the agent-publish flow has no account to exclude", async () => {
    await recordSiteView(mkView({ anonId: "anon_author", ip: null, viewedAt: T + 3 }));
    await recordSiteView(mkView({ anonId: "anon_guest", ip: null, viewedAt: T }));

    const excluded = await getSiteViewStats(SITE, T - 1, { anonIds: ["anon_author"] });
    expect(excluded.opens).toBe(1);
    expect(excluded.uniqueViewers).toBe(1);
    expect(excluded.lastViewedAt).toBe(T);
  });
});

describe("pruneSiteViews", () => {
  it("deletes strictly older than the line, and leaves share_views untouched", async () => {
    const share = await createShare({
      id: "shr_prune_1", siteId: SITE, tokenHash: "th-prune-1", policy: "public",
      passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null,
    });
    await recordShareView({ shareId: share.id, siteId: SITE, userId: null, anonId: null, ip: null, userAgent: null, viewedAt: T - 2 });
    await recordSiteView(mkView({ viewedAt: T - 2 }));
    await recordSiteView(mkView({ viewedAt: T - 1 }));
    await recordSiteView(mkView({ viewedAt: T }));

    expect(await pruneSiteViews(T)).toBe(2); // T-2 and T-1; the row ON the line stays
    expect(await pruneSiteViews(T)).toBe(0);
    expect((await listShareViews(SITE, 10))).toHaveLength(1); // the other table is not this prune's business
  });
});

describe("logSiteOpen — the door policy", () => {
  it("records a real reader once per collapse window, whichever identity they carry", async () => {
    const s = await site();
    await logSiteOpen(requestFor(), s, null, "anon_reader");
    await logSiteOpen(requestFor(), s, null, "anon_reader"); // refresh inside the window
    const opens = await listSiteOpens(SITE, 10);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ shareId: null, anonId: "anon_reader", ip: "203.0.113.7" });
    expect(opens[0].userAgent).toContain("real reader");
  });

  it("attributes a signed-in reader to the account and drops the anon id", async () => {
    const s = await site();
    await logSiteOpen(requestFor(), s, sessionOf("u_owner"), "anon_reader");
    const opens = await listSiteOpens(SITE, 10);
    expect(opens[0]).toMatchObject({ userId: "u_owner", anonId: null });
  });

  it("drops router prefetches and speculative loads", async () => {
    const s = await site();
    await logSiteOpen(requestFor({ "next-router-prefetch": "1" }), s, null, "anon_reader");
    await logSiteOpen(requestFor({ "sec-purpose": "prefetch;prerender" }), s, null, "anon_reader");
    await logSiteOpen(requestFor({ purpose: "prefetch" }), s, null, "anon_reader");
    expect(await listSiteOpens(SITE, 10)).toHaveLength(0);
  });

  it("drops crawlers fetching link previews, and the pattern knows a bot from a person", async () => {
    const s = await site();
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Lark-Bot/1.0",
    ]) {
      await logSiteOpen(requestFor({ "user-agent": ua }), s, null, null);
    }
    expect(await listSiteOpens(SITE, 10)).toHaveLength(0);

    // The short pattern must NOT swallow real readers — including Lark's in-app browser, whose UA
    // carries the product name but not a bot marker.
    expect(CRAWLER_UA_RE.test("Mozilla/5.0 (iPhone) Lark/7.30.5 LarkLocale/zh_CN")).toBe(false);
    expect(CRAWLER_UA_RE.test("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe(false);
  });
});


describe("unified opening contract", () => {
  it("collapses concurrent direct and different share-link opens for one site", async () => {
    const s = await site();
    const share = await createShare({ id: "shr_atomic", siteId: SITE, tokenHash: "th-atomic", policy: "public", passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null });
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? logShareView(requestFor(), share, null, "same-reader")
      : logSiteOpen(requestFor(), s, null, "same-reader")));
    expect(await listSiteOpens(SITE, 100)).toHaveLength(1);
  });
  it("keeps identities distinct and admits the next visit only after 30 minutes", async () => {
    const view = { ...mkView({ userId: "reader", ip: "10.0.0.1" }), shareId: null };
    await recordSiteOpen(view, 1_800_000);
    await recordSiteOpen({ ...view, viewedAt: T + 1_800_000 }, 1_800_000);
    expect(await listSiteOpens(SITE, 100)).toHaveLength(1);
    await recordSiteOpen({ ...view, viewedAt: T + 1_800_001 }, 1_800_000);
    await recordSiteOpen({ ...view, userId: "another-reader" }, 1_800_000);
    await recordSiteOpen({ ...view, userId: null, anonId: "reader" }, 1_800_000);
    expect(await listSiteOpens(SITE, 100)).toHaveLength(4);
    expect((await getSiteViewStats(SITE, T - 1, {})).uniqueViewers).toBe(3);
  });
  it("ignores share-link preview crawlers and speculative loads", async () => {
    const share = await createShare({ id: "shr_bot", siteId: SITE, tokenHash: "th-bot", policy: "public", passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null });
    await logShareView(requestFor({ "user-agent": "Slackbot-LinkExpanding" }), share, null, "bot");
    await logShareView(requestFor({ "next-router-prefetch": "1" }), share, null, "prefetch");
    expect(await listSiteOpens(SITE, 100)).toHaveLength(0);
  });
});


describe("view detail retention", () => {
  it("fails safe on invalid policies and protects the seven-day window", async () => {
    for (const value of ["", "abc", "-1", "1", "6", "3651", "7.5"]) {
      process.env.ARTIFACT_VIEW_RETENTION_DAYS = value;
      expect(config.viewRetentionDays).toBe(0);
    }
    await recordSiteView(mkView({ viewedAt: T - 8 * DAY }));
    await recordSiteView(mkView({ viewedAt: T - 7 * DAY }));
    process.env.ARTIFACT_VIEW_RETENTION_DAYS = "0";
    expect(await pruneViewDetails(T)).toBe(0);
    process.env.ARTIFACT_VIEW_RETENTION_DAYS = "7";
    expect(await pruneViewDetails(T)).toBe(1);
    expect((await listSiteOpens(SITE, 10)).map(v => v.viewedAt)).toEqual([T - 7 * DAY]);
  });
  it("limits a cleanup batch to 1000 records", async () => {
    for (let i = 0; i < 1001; i++) await recordSiteView(mkView({ viewedAt: T - 1 }));
    expect(await pruneSiteViews(T)).toBe(1000);
    expect(await pruneSiteViews(T)).toBe(1);
    expect(await pruneSiteViews(T)).toBe(0);
  });
});
