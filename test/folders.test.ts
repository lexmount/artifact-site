// Folders — the browser-local shelf that organises My sites. The invariants below are the ones the
// UI leans on: the ops are TOTAL (a refused edit returns the same state, never throws), folders are
// labels rather than containers (deleting one deletes no site), and a dangling assignment can never
// hide a site from both Unfiled and every folder.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILTER_ALL,
  FILTER_UNFILED,
  FOLDERS_KEY,
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  assignSite,
  countsByFolder,
  createFolder,
  deleteFolder,
  filterByFolder,
  folderOf,
  newFolderId,
  normalizeFolderName,
  parseFolders,
  pruneAssignments,
  renameFolder,
  serializeFolders,
  type FolderState, filterBySearch } from "@/lib/folders";
import type { SiteSummary } from "@/lib/types";

const EMPTY: FolderState = { folders: [], assign: {} };

function site(slug: string): SiteSummary {
  return { slug, title: slug, kind: "single", entry: "index.html", versionCount: 1, createdAt: 0, updatedAt: 0 };
}

/** A shelf with two folders and one filed site. */
function shelf(): FolderState {
  let s = createFolder(EMPTY, "工作", "f_work", 1);
  s = createFolder(s, "玩具", "f_toy", 2);
  return assignSite(s, "alpha", "f_work");
}

describe("folders — create", () => {
  it("appends a folder", () => {
    const s = createFolder(EMPTY, "工作", "f_1", 100);
    expect(s.folders).toEqual([{ id: "f_1", name: "工作", createdAt: 100 }]);
  });

  it("trims and collapses whitespace in the name", () => {
    expect(createFolder(EMPTY, "  我的  草稿 \n", "f_1", 0).folders[0].name).toBe("我的 草稿");
  });

  it("caps the name length", () => {
    const long = "长".repeat(MAX_FOLDER_NAME + 30);
    expect(createFolder(EMPTY, long, "f_1", 0).folders[0].name).toHaveLength(MAX_FOLDER_NAME);
  });

  it("refuses a blank name by returning the SAME state (that identity is the UI's error signal)", () => {
    expect(createFolder(EMPTY, "   ", "f_1", 0)).toBe(EMPTY);
    expect(createFolder(EMPTY, "工作", "", 0)).toBe(EMPTY);
  });

  it("refuses a duplicate id", () => {
    const s = createFolder(EMPTY, "工作", "f_1", 0);
    expect(createFolder(s, "另一个", "f_1", 0)).toBe(s);
  });

  it("allows two folders with the same name (they are labels, ids are what identify them)", () => {
    const s = createFolder(createFolder(EMPTY, "草稿", "f_1", 0), "草稿", "f_2", 0);
    expect(s.folders).toHaveLength(2);
  });

  it("stops at the cap", () => {
    let s = EMPTY;
    for (let i = 0; i < MAX_FOLDERS; i++) s = createFolder(s, `f${i}`, `f_${i}`, 0);
    expect(s.folders).toHaveLength(MAX_FOLDERS);
    expect(createFolder(s, "再来一个", "f_extra", 0)).toBe(s);
  });

  it("mints ids that can never collide with the rail's own filter values", () => {
    const id = newFolderId();
    expect(id.startsWith("f_")).toBe(true);
    expect(id).not.toBe(FILTER_ALL);
    expect(id).not.toBe(FILTER_UNFILED);
    expect(newFolderId()).not.toBe(id);
  });
});

describe("folders — rename and delete", () => {
  it("renames in place, keeping membership", () => {
    const s = renameFolder(shelf(), "f_work", " 正事 ");
    expect(s.folders.find((f) => f.id === "f_work")?.name).toBe("正事");
    expect(folderOf(s, "alpha")).toBe("f_work");
  });

  it("refuses a blank rename or an unknown folder", () => {
    const s = shelf();
    expect(renameFolder(s, "f_work", "  ")).toBe(s);
    expect(renameFolder(s, "f_nope", "名字")).toBe(s);
  });

  it("deleting a folder un-files its sites and deletes nothing else", () => {
    const s = deleteFolder(shelf(), "f_work");
    expect(s.folders.map((f) => f.id)).toEqual(["f_toy"]);
    expect(folderOf(s, "alpha")).toBeNull(); // the site remains, it just returns to Unfiled
  });

  it("deleting an unknown folder is a no-op", () => {
    const s = shelf();
    expect(deleteFolder(s, "f_nope")).toBe(s);
  });
});

describe("folders — site assignment", () => {
  it("files and re-files a site (one folder at a time)", () => {
    let s = assignSite(shelf(), "alpha", "f_toy");
    expect(folderOf(s, "alpha")).toBe("f_toy");
    s = assignSite(s, "alpha", null);
    expect(folderOf(s, "alpha")).toBeNull();
  });

  it("refuses to file into a folder that does not exist (no dangling pointers)", () => {
    const s = shelf();
    expect(assignSite(s, "beta", "f_ghost")).toBe(s);
    expect(folderOf(assignSite(s, "beta", "f_ghost"), "beta")).toBeNull();
  });

  it("re-filing into the same folder, or un-filing an unfiled site, changes nothing", () => {
    const s = shelf();
    expect(assignSite(s, "alpha", "f_work")).toBe(s);
    expect(assignSite(s, "beta", null)).toBe(s);
    expect(assignSite(s, "", "f_work")).toBe(s);
  });
});

describe("folders — counts and filtering", () => {
  const sites = [site("alpha"), site("beta"), site("gamma")];

  it("counts All / Unfiled / each folder", () => {
    const s = assignSite(shelf(), "beta", "f_work");
    expect(countsByFolder(sites, s)).toEqual({ all: 3, unfiled: 1, byId: { f_work: 2, f_toy: 0 } });
  });

  it("counts a site whose folder vanished as Unfiled, not as missing", () => {
    const s: FolderState = { folders: [], assign: { alpha: "f_gone" } };
    expect(countsByFolder(sites, s)).toEqual({ all: 3, unfiled: 3, byId: {} });
  });

  it("filters by folder, by Unfiled, and by All", () => {
    const s = shelf();
    expect(filterByFolder(sites, s, "f_work").map((x) => x.slug)).toEqual(["alpha"]);
    expect(filterByFolder(sites, s, "f_toy")).toEqual([]);
    expect(filterByFolder(sites, s, FILTER_UNFILED).map((x) => x.slug)).toEqual(["beta", "gamma"]);
    expect(filterByFolder(sites, s, FILTER_ALL).map((x) => x.slug)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("an unknown filter falls back to All (an unexplained empty grid is worse)", () => {
    expect(filterByFolder(sites, shelf(), "f_deleted")).toHaveLength(3);
  });
});

describe("folders — tolerant parsing", () => {
  it("round-trips what it writes", () => {
    const s = shelf();
    expect(parseFolders(serializeFolders(s))).toEqual(s);
  });

  it("treats every kind of broken storage as an empty shelf", () => {
    for (const raw of [null, "", "not json", "[]", "12", '"x"', "null"]) {
      expect(parseFolders(raw)).toEqual({ folders: [], assign: {} });
    }
  });

  it("drops malformed folders and de-duplicates ids", () => {
    const raw = JSON.stringify({
      v: 1,
      folders: [{ id: "f_1", name: "A", createdAt: 1 }, { name: "无 id" }, null, "x", { id: "f_1", name: "重复" }],
      assign: {},
    });
    expect(parseFolders(raw).folders).toEqual([{ id: "f_1", name: "A", createdAt: 1 }]);
  });

  it("gives a nameless folder a placeholder instead of an unclickable blank chip", () => {
    const raw = JSON.stringify({ folders: [{ id: "f_1" }], assign: {} });
    expect(parseFolders(raw).folders[0]).toEqual({ id: "f_1", name: "Untitled folder", createdAt: 0 });
  });

  it("drops assignments that point at a folder which is not in the list", () => {
    // The dangling case is the dangerous one: such a site would show under no folder AND not
    // under Unfiled, i.e. disappear from every view while still existing.
    const raw = JSON.stringify({ folders: [{ id: "f_1", name: "A", createdAt: 0 }], assign: { a: "f_1", b: "f_gone", c: 7 } });
    expect(parseFolders(raw).assign).toEqual({ a: "f_1" });
  });

  it("ignores a non-object assign map", () => {
    const raw = JSON.stringify({ folders: [{ id: "f_1", name: "A", createdAt: 0 }], assign: ["a", "b"] });
    expect(parseFolders(raw).assign).toEqual({});
  });

  it("applies the folder cap on read too", () => {
    const folders = Array.from({ length: MAX_FOLDERS + 10 }, (_, i) => ({ id: `f_${i}`, name: `n${i}`, createdAt: 0 }));
    expect(parseFolders(JSON.stringify({ folders, assign: {} })).folders).toHaveLength(MAX_FOLDERS);
  });
});

describe("folders — pruning deleted sites", () => {
  it("forgets the membership of sites that no longer exist", () => {
    const s = assignSite(shelf(), "beta", "f_toy");
    const pruned = pruneAssignments(s, new Set(["alpha"]));
    expect(pruned.assign).toEqual({ alpha: "f_work" });
    expect(pruned.folders).toEqual(s.folders); // the folders themselves stay — an empty folder is still a folder
  });

  it("returns the SAME state when there is nothing to forget (no pointless write)", () => {
    const s = shelf();
    expect(pruneAssignments(s, new Set(["alpha", "beta"]))).toBe(s);
  });

  it("an empty live set means 'unknown' and prunes nothing", () => {
    const s = shelf();
    expect(pruneAssignments(s, new Set())).toBe(s);
  });
});

describe("folders — name normalisation", () => {
  it("is the single place the name rules live", () => {
    expect(normalizeFolderName("  a   b  ")).toBe("a b");
    expect(normalizeFolderName("\t\n ")).toBe("");
    expect(normalizeFolderName("x".repeat(200))).toHaveLength(MAX_FOLDER_NAME);
  });
});

/**
 * The shelf only exists in localStorage, so "the write failed" is its one real failure mode — and
 * it used to be swallowed: the UI reported "folder created" and selected a folder that was never stored,
 * so it vanished on the next read with no explanation. `writeLocal` now answers truthfully and the
 * panel branches on that answer (see `mutate`/`report` in my-sites.tsx).
 *
 * Stubs localStorage rather than pulling in a DOM environment — the same approach the edit-token
 * provenance suite uses. `window` is stubbed too because writeLocal broadcasts a store event.
 */
describe("folders — a failed write must be reported truthfully", () => {
  function installStorage(options: { failWrites?: boolean } = {}) {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (options.failWrites) {
          const error = new Error("QuotaExceededError");
          error.name = "QuotaExceededError";
          throw error;
        }
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        if (options.failWrites) throw new Error("SecurityError");
        map.delete(k);
      },
      clear: () => map.clear(),
    });
    vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });
    return map;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("reports success when the value actually lands", async () => {
    const map = installStorage();
    const { readLocal, writeLocal } = await import("@/lib/local-store");
    expect(writeLocal(FOLDERS_KEY, serializeFolders(shelf()))).toBe(true);
    expect(parseFolders(readLocal(FOLDERS_KEY)).folders.map((f) => f.id)).toEqual(["f_work", "f_toy"]);
    expect(map.size).toBe(1);
  });

  // The bug: a full (or blocked) store threw, the throw was swallowed, and the caller was told the
  // folder had been created. The next read had no such folder.
  it("reports failure when the store is full, and nothing is written", async () => {
    const map = installStorage({ failWrites: true });
    const { readLocal, writeLocal } = await import("@/lib/local-store");
    expect(writeLocal(FOLDERS_KEY, serializeFolders(shelf()))).toBe(false);
    expect(map.size).toBe(0);
    expect(parseFolders(readLocal(FOLDERS_KEY))).toEqual({ folders: [], assign: {} });
  });

  it("reports failure when a delete is refused too", async () => {
    installStorage({ failWrites: true });
    const { writeLocal } = await import("@/lib/local-store");
    expect(writeLocal(FOLDERS_KEY, null)).toBe(false);
  });

  it("degrades to 'no shelf' when storage is unreadable, instead of throwing into a render", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); } });
    vi.stubGlobal("window", { dispatchEvent: () => true });
    const { readLocal } = await import("@/lib/local-store");
    expect(readLocal(FOLDERS_KEY)).toBeNull();
    expect(parseFolders(readLocal(FOLDERS_KEY))).toEqual({ folders: [], assign: {} });
  });

  it("still broadcasts after a failed write, so other readers re-sync rather than freeze", async () => {
    installStorage({ failWrites: true });
    let broadcasts = 0;
    vi.stubGlobal("window", { dispatchEvent: () => { broadcasts += 1; return true; } });
    const { writeLocal } = await import("@/lib/local-store");
    expect(writeLocal(FOLDERS_KEY, "{}")).toBe(false);
    expect(broadcasts).toBe(1);
  });
});

describe("filterBySearch — the rail's search box", () => {
  const site = (slug: string, title: string) => ({ slug, title, kind: "single" as const, entry: "index.html", versionCount: 1, createdAt: 1, updatedAt: 1 });
  const sites = [site("q3-report", "Quarterly report"), site("landing-draft", "Landing page draft"), site("Ab12", "Übersicht")];
  it("matches title or address, case-insensitively, trimming the query; blank keeps everything", () => {
    expect(filterBySearch(sites, "").map((s) => s.slug)).toEqual(["q3-report", "landing-draft", "Ab12"]);
    expect(filterBySearch(sites, "  REPORT ").map((s) => s.slug)).toEqual(["q3-report"]);
    expect(filterBySearch(sites, "draft").map((s) => s.slug)).toEqual(["landing-draft"]);
    expect(filterBySearch(sites, "ab1").map((s) => s.slug)).toEqual(["Ab12"]);   // address
    expect(filterBySearch(sites, "übersicht").map((s) => s.slug)).toEqual(["Ab12"]);
    expect(filterBySearch(sites, "nothing")).toEqual([]);
  });
});
