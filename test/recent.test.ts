// Recently viewed — the browser-local shelf on the home page. Everything here is pure list algebra over
// values that came out of localStorage, i.e. out of a store the user can edit, another tab can
// race, and an older build may have written. The rules worth pinning down are exactly the ones a
// UI cannot recover from: losing order, growing without bound, or throwing on garbage.
import { describe, expect, it } from "vitest";
import {
  RECENT_LIMIT,
  addRecent,
  parseRecent,
  recentShelfItems, recentHref, recentPreview, refreshRecent,
  removeRecent,
  serializeRecent,
  toSummary,
  type RecentEntry,
} from "@/lib/recent";

function entry(slug: string, visitedAt: number, extra: Partial<RecentEntry> = {}): RecentEntry {
  return {
    slug,
    title: `站点 ${slug}`,
    kind: "single",
    entry: "index.html",
    versionCount: 1,
    createdAt: visitedAt,
    updatedAt: visitedAt,
    visitedAt,
    ...extra,
  };
}

describe("Recently viewed — recording and de-duplication", () => {
  it("puts the newest visit first", () => {
    const list = addRecent(addRecent([], entry("a", 1)), entry("b", 2));
    expect(list.map((i) => i.slug)).toEqual(["b", "a"]);
  });

  it("re-visiting moves a site to the front instead of duplicating it", () => {
    let list = addRecent([], entry("a", 1));
    list = addRecent(list, entry("b", 2));
    list = addRecent(list, entry("a", 3));
    expect(list.map((i) => i.slug)).toEqual(["a", "b"]);
    expect(list[0].visitedAt).toBe(3);
  });

  it("refreshes the stored snapshot on re-visit (a rename must not stick)", () => {
    const list = addRecent(addRecent([], entry("a", 1)), entry("a", 2, { title: "新标题", versionCount: 4 }));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("新标题");
    expect(list[0].versionCount).toBe(4);
  });

  it("a clock that jumps backwards still lands the new visit first", () => {
    // Ordering is by insertion, not by timestamp — otherwise the page you just opened could be
    // buried under an entry written while the clock was ahead.
    const list = addRecent([entry("old", 9_999_999_999_999)], entry("fresh", 1));
    expect(list[0].slug).toBe("fresh");
  });

  it("caps the shelf and drops the oldest", () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENT_LIMIT + 12; i++) list = addRecent(list, entry(`s${i}`, i));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].slug).toBe(`s${RECENT_LIMIT + 11}`);
    expect(list.some((i) => i.slug === "s0")).toBe(false);
  });

  it("removes one entry without touching the rest", () => {
    const list = removeRecent([entry("a", 2), entry("b", 1)], "a");
    expect(list.map((i) => i.slug)).toEqual(["b"]);
    expect(removeRecent(list, "nope").map((i) => i.slug)).toEqual(["b"]);
  });
});

describe("Recently viewed — tolerant parsing", () => {
  it("round-trips what it writes", () => {
    const list = [entry("a", 2), entry("b", 1)];
    expect(parseRecent(serializeRecent(list))).toEqual(list);
  });

  it("treats every kind of broken storage as 'no history', never an exception", () => {
    for (const raw of [null, "", "not json", "42", '"a string"', "[", "null", "{}", '{"items":"nope"}']) {
      expect(parseRecent(raw)).toEqual([]);
    }
  });

  it("accepts a bare array (shape written by an older build)", () => {
    expect(parseRecent(JSON.stringify([entry("a", 1)])).map((i) => i.slug)).toEqual(["a"]);
  });

  it("drops entries with no slug and keeps the rest", () => {
    const raw = JSON.stringify({ v: 1, items: [{ title: "无 slug" }, null, 7, entry("ok", 1)] });
    expect(parseRecent(raw).map((i) => i.slug)).toEqual(["ok"]);
  });

  it("fills in missing cosmetic fields rather than dropping the entry", () => {
    const raw = JSON.stringify({ v: 1, items: [{ slug: "a", visitedAt: 5 }] });
    const [item] = parseRecent(raw);
    expect(item).toEqual({
      slug: "a",
      title: "a", // no title stored → the slug is at least addressable
      kind: "single",
      entry: "index.html",
      versionCount: 1,
      createdAt: 5,
      updatedAt: 5,
      visitedAt: 5,
    });
  });

  it("rejects a bogus kind rather than passing it through to the card", () => {
    const raw = JSON.stringify({ v: 1, items: [{ slug: "a", kind: "wat", visitedAt: 1 }] });
    expect(parseRecent(raw)[0].kind).toBe("single");
  });

  it("survives NaN / non-numeric timestamps (JSON turns NaN into null)", () => {
    const raw = '{"v":1,"items":[{"slug":"a","visitedAt":null,"updatedAt":"soon","versionCount":-3}]}';
    const [item] = parseRecent(raw);
    expect(item.visitedAt).toBe(0);
    expect(item.updatedAt).toBe(0);
    expect(item.versionCount).toBe(0);
  });

  it("de-duplicates a hand-edited file, keeping the FIRST record of each slug", () => {
    const items = [entry("a", 1), entry("b", 5), entry("a", 9)];
    const parsed = parseRecent(JSON.stringify({ v: 1, items }));
    expect(parsed.map((i) => i.slug)).toEqual(["a", "b"]); // stored order, first "a" wins
    expect(parsed[0].visitedAt).toBe(1);
  });

  // The bug: parseRecent used to re-sort by visitedAt, undoing on the very next read the insertion
  // order addRecent goes out of its way to preserve. One backwards clock tick (NTP correction, a
  // profile copied off another machine, a manually changed date) and the site you just opened sank
  // to the bottom of the shelf — or off it, once 50 entries were in front of it.
  it("keeps the stored order: a visit recorded with a backwards clock stays at the front", () => {
    const ahead = entry("stale", 9_999_999_999_999);
    const now = entry("just-opened", 1);
    const written = serializeRecent(addRecent([ahead], now));
    expect(parseRecent(written).map((i) => i.slug)).toEqual(["just-opened", "stale"]);
  });

  it("survives the full write → read → write loop without shuffling anything", () => {
    // Exactly what the product does: RecentTracker writes on every visit, the home page parses.
    let stored = "";
    for (const [slug, clock] of [["a", 500], ["b", 100], ["c", 300]] as const) {
      stored = serializeRecent(addRecent(parseRecent(stored || null), entry(slug, clock)));
    }
    expect(parseRecent(stored).map((i) => i.slug)).toEqual(["c", "b", "a"]);
  });

  it("never returns more than the cap, and keeps the FRONT of the stored list", () => {
    // The front is the newest by insertion, so the cap must cut the tail — not the lowest clocks.
    const items = Array.from({ length: RECENT_LIMIT + 20 }, (_, i) => entry(`s${i}`, i));
    const parsed = parseRecent(JSON.stringify({ v: 1, items }));
    expect(parsed).toHaveLength(RECENT_LIMIT);
    expect(parsed[0].slug).toBe("s0");
    expect(parsed[RECENT_LIMIT - 1].slug).toBe(`s${RECENT_LIMIT - 1}`);
  });
});

describe("Recently viewed — pruning deleted sites", () => {
  it("keeps unlisted history missing from the public directory", () => {
    const list = [entry("a", 3), entry("b", 2), entry("c", 1)];
    expect(recentShelfItems(list, [toSummary(entry("a", 3)), toSummary(entry("c", 1))]).map((i) => i.summary.slug)).toEqual(["a", "b", "c"]);
  });

  it("an empty live set means 'unknown' and prunes nothing", () => {
    // Guards against wiping a user's whole history the one time the site list comes back empty.
    const list = [entry("a", 1)];
    expect(recentShelfItems(list, []).map((i) => i.summary.slug)).toEqual(["a"]);
  });
});

describe("Recently viewed — card projection", () => {
  it("projects an entry onto the card shape without the visit stamp", () => {
    expect(toSummary(entry("a", 7))).toEqual({
      slug: "a",
      title: "站点 a",
      kind: "single",
      entry: "index.html",
      versionCount: 1,
      createdAt: 7,
      updatedAt: 7,
    });
  });
});


describe("recent navigation and metadata", () => {
  it("retains document kind, share credentials and pinned versions through storage", () => {
    const value = { ...entry("doc", 123), kind: "document" as const, shareToken: "share_abc", versionId: "v_old" };
    const parsed = parseRecent(serializeRecent([value]))[0];
    expect(parsed).toMatchObject(value);
    expect(recentHref(parsed)).toBe("/v/share_abc?version=v_old");
    expect(recentPreview(parsed)).toBe("/api/preview/doc?thumb=1&share=share_abc&v=v_old");
  });
  it("refreshes metadata without moving a visit or changing its time", () => {
    const items = [entry("a", 20), entry("b", 10)];
    const refreshed = refreshRecent(items, { ...entry("b", 99), title: "Renamed" });
    expect(refreshed.map(i => i.slug)).toEqual(["a", "b"]);
    expect(refreshed[1]).toMatchObject({ title: "Renamed", visitedAt: 10 });
  });
  it("encodes stored navigation fields instead of allowing arbitrary URLs", () => {
    expect(recentHref({ ...entry("a", 1), shareToken: "//evil.test/#" })).toBe("/v/%2F%2Fevil.test%2F%23");
  });
});

describe("failed entrances", () => {
  it("removes only the failed direct version, preserving another entrance", async () => {
    const { forgetRecentEntrance } = await import("@/lib/recent");
    const direct = entry("a", 1, { versionId: "old" });
    const shared = entry("b", 2, { shareToken: "live" });
    expect(forgetRecentEntrance([direct, shared], "/s/a", "?version=old")).toEqual([shared]);
    expect(forgetRecentEntrance([direct, shared], "/s/a", "?version=other")).toEqual([direct, shared]);
    expect(forgetRecentEntrance([shared], "/s/b", "")).toEqual([shared]);
  });
  it("drops a dead pinned share even when its original URL had no version query", async () => {
    const { forgetRecentEntrance } = await import("@/lib/recent");
    const shared = entry("a", 1, { shareToken: "dead", versionId: "pinned" });
    expect(forgetRecentEntrance([shared], "/v/dead", "")).toEqual([]);
    expect(forgetRecentEntrance([shared], "/v/another", "")).toEqual([shared]);
    expect(forgetRecentEntrance([shared], "/v/dead", "?version=other")).toEqual([shared]);
  });
});
