/**
 * The provenance split is a security boundary: a token that arrived on someone else's editable
 * link must never be redeemable for ownership of their site.
 *
 * Stubs localStorage + a window event target rather than pulling in a DOM environment — the code
 * under test is plain key/prefix logic, and the stub keeps the suite dependency-free.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { allStoredEditTokens, countAdoptableSites, rememberEditToken, rememberSharedToken } = await import("@/lib/edit-token");

beforeEach(() => { store.clear(); });

const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();

describe("edit token provenance", () => {
  it("offers sites this browser created for adoption", () => {
    rememberEditToken("mine-a", "tok-a");
    rememberEditToken("mine-b", "tok-b");
    expect(slugs(allStoredEditTokens())).toEqual(["mine-a", "mine-b"]);
    expect(countAdoptableSites()).toBe(2);
  });

  // The bug this test exists for: open a colleague's ?t= link once, sign in anywhere later, and
  // their (still unowned) site silently became yours.
  it("never offers a site whose token merely arrived on someone else's editable link", () => {
    rememberSharedToken("theirs", "tok-theirs");
    expect(allStoredEditTokens()).toEqual([]);
    expect(countAdoptableSites()).toBe(0);
  });

  it("keeps the two kinds apart when both are present", () => {
    rememberEditToken("mine", "tok-mine");
    rememberSharedToken("theirs", "tok-theirs");
    expect(slugs(allStoredEditTokens())).toEqual(["mine"]);
  });

  // Authorship must not be demoted by later receiving a link to your own site — otherwise a
  // creator who clicks their own shared link loses the ability to claim what they made.
  it("does not let a received link overwrite this browser's own record", () => {
    rememberEditToken("mine", "tok-mine");
    rememberSharedToken("mine", "tok-from-link");
    expect(allStoredEditTokens()).toEqual([{ slug: "mine", editToken: "tok-mine" }]);
  });
});
