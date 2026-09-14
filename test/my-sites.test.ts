/**
 * My sites — who owns what, and whose data wins.
 *
 * Two bugs live here, and both are invisible from the component: an ownership snapshot taken once
 * per page load was used as CARD DATA (so it silently overwrote fresher server-rendered rows), and
 * a token that merely arrived on someone else's `?t=` link counted as authorship.
 *
 * Stubs localStorage rather than pulling in a DOM environment — the code under test is prefix logic
 * over storage keys plus pure list algebra. Same approach as edit-token-provenance.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteSummary } from "@/lib/types";

function installStorageStub() {
  const map = new Map<string, string>();
  const storage = {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
  return storage;
}

const store = installStorageStub();
const { OWNER_TOKEN_PREFIX, mergeMySites, ownerSlugsFrom, readOwnerSlugs, siteListSignature } =
  await import("@/lib/my-sites");
const { rememberEditToken, rememberSharedToken } = await import("@/lib/edit-token");

beforeEach(() => { store.clear(); });

function site(slug: string, extra: Partial<SiteSummary> = {}): SiteSummary {
  return { slug, title: slug, kind: "single", entry: "index.html", versionCount: 1, createdAt: 0, updatedAt: 0, ...extra };
}

const slugsOf = (sites: readonly SiteSummary[]) => sites.map((s) => s.slug);
const set = (...slugs: string[]) => new Set(slugs);

describe("My sites — ownership sources (a ?t= link is not ownership)", () => {
  it("counts only the tokens of sites this browser created", () => {
    rememberEditToken("mine", "tok-mine");
    rememberSharedToken("theirs", "tok-theirs");
    expect(readOwnerSlugs()).toEqual(["mine"]);
  });

  // The bug: Alice sends Bob /s/alice-site?t=TOKEN. Bob opens it once — useEditToken files the
  // token under sites:sharedToken: — and Alice's site turned up in Bob's My sites, with a delete
  // button, and could be filed into Bob's folders.
  it("keeps a colleague's shared site out of My sites entirely", () => {
    rememberSharedToken("alice-site", "tok-from-link");
    const owned = new Set(readOwnerSlugs());
    expect(owned.has("alice-site")).toBe(false);
    expect(mergeMySites([site("alice-site")], owned, set())).toEqual([]);
  });

  it("still owns a site you created and later opened via your own ?t= link", () => {
    rememberEditToken("mine", "tok-mine");
    rememberSharedToken("mine", "tok-from-link"); // never downgrades an owner record
    expect(readOwnerSlugs()).toEqual(["mine"]);
  });

  it("reads keys by the owner prefix and ignores everything else in the store", () => {
    const keys = [
      `${OWNER_TOKEN_PREFIX}a`,
      "sites:sharedToken:b",
      "sites:recent:v1",
      `${OWNER_TOKEN_PREFIX}`, // prefix with no slug addresses nothing
      null,
      `${OWNER_TOKEN_PREFIX}c`,
    ];
    expect(ownerSlugsFrom(keys)).toEqual(["a", "c"]);
  });

  it("returns a sorted list, so callers can diff it as a string", () => {
    expect(ownerSlugsFrom([`${OWNER_TOKEN_PREFIX}z`, `${OWNER_TOKEN_PREFIX}a`])).toEqual(["a", "z"]);
  });

  it("survives storage being blocked entirely rather than throwing into a render", () => {
    vi.stubGlobal("localStorage", { get length(): number { throw new Error("SecurityError"); } });
    expect(readOwnerSlugs()).toEqual([]);
    vi.stubGlobal("localStorage", store); // put the working stub back for the rest of the suite
  });
});

describe("My sites — merging (fresh data must win)", () => {
  const allSites = [site("a", { updatedAt: 30 }), site("b", { updatedAt: 10 }), site("c", { updatedAt: 20 })];

  it("unions the two ownership sources, newest first", () => {
    expect(slugsOf(mergeMySites(allSites, set("b"), set("a")))).toEqual(["a", "b"]);
  });

  it("counts a site once when both sources claim it", () => {
    expect(slugsOf(mergeMySites(allSites, set("a"), set("a")))).toEqual(["a"]);
  });

  // The bug: /api/me/sites is fetched once per page load (useAuth caches `user` for the whole
  // lifetime of the page), so after deleting a site the stale snapshot still listed it — and the
  // old merge wrote those rows LAST, so they beat the freshly rendered list. The card stayed, with
  // a 404 thumbnail, a tab count that would not go down, and a delete button that kept "working".
  it("drops a site that the server list no longer contains, however loudly the snapshot remembers it", () => {
    const afterDelete = allSites.filter((s) => s.slug !== "a");
    // Both sources still name "a"; the server-rendered universe no longer does, and it decides.
    expect(slugsOf(mergeMySites(afterDelete, set("a", "b"), set("a", "c")))).toEqual(["c", "b"]);
  });

  it("shows the freshly rendered title, not the one the ownership snapshot was taken with", () => {
    const renamed = [site("a", { title: "新名字", updatedAt: 40 })];
    const [card] = mergeMySites(renamed, set("a"), set("a"));
    expect(card.title).toBe("新名字");
    expect(card.updatedAt).toBe(40);
  });

  it("returns the very objects the server rendered (no snapshot fields can leak in)", () => {
    const [card] = mergeMySites(allSites, set(), set("a"));
    expect(card).toBe(allSites[0]);
  });

  it("owning nothing yields nothing, and an empty universe yields nothing", () => {
    expect(mergeMySites(allSites, set(), set())).toEqual([]);
    expect(mergeMySites([], set("a"), set("b"))).toEqual([]);
  });

  it("does not mutate or reorder the caller's list", () => {
    const input = [...allSites];
    mergeMySites(input, set("a", "b", "c"), set());
    expect(slugsOf(input)).toEqual(["a", "b", "c"]);
  });
});

describe("My sites — the signals that trigger a refetch", () => {
  it("changes when a site is deleted, added or saved — and only then", () => {
    const base = [site("a", { updatedAt: 1 }), site("b", { updatedAt: 2 })];
    expect(siteListSignature(base)).toBe(siteListSignature([site("a", { updatedAt: 1 }), site("b", { updatedAt: 2 })]));
    expect(siteListSignature(base)).not.toBe(siteListSignature(base.slice(1)));
    expect(siteListSignature(base)).not.toBe(siteListSignature([...base, site("c")]));
    expect(siteListSignature(base)).not.toBe(siteListSignature([site("a", { updatedAt: 9 }), site("b", { updatedAt: 2 })]));
  });

  it("is stable for a list that only got re-rendered", () => {
    expect(siteListSignature([])).toBe(siteListSignature([]));
  });
});
