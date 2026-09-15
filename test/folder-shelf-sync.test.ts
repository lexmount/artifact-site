// The silent hand-over of a browser-local folder shelf to the account (issue #35): once per user,
// shared between every caller on the page, local copy forgotten only after the account has it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const KEY = "sites:folders:v1";
const shelf = JSON.stringify({ v: 1, folders: [{ id: "f_1", name: "Work", createdAt: 1 }], assign: { abc: "f_1" } });
let calls: { url: string; body: string | undefined }[];
let respond: (url: string) => Response;

beforeEach(() => {
  store.clear();
  calls = [];
  respond = () => new Response(JSON.stringify({ folders: [], assign: {} }), { status: 200 });
  vi.stubGlobal("window", { localStorage: localStorageStub, location: { origin: "http://x" }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal("localStorage", localStorageStub);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body as string | undefined }); return respond(url); }));
});
afterEach(async () => {
  const { __resetShelfSyncForTests } = await import("@/lib/folder-shelf");
  const { __resetAdoptionForTests } = await import("@/lib/adoption");
  __resetShelfSyncForTests();
  __resetAdoptionForTests();
  vi.unstubAllGlobals();
});

describe("syncLocalShelf", () => {
  it("does nothing without a local shelf", async () => {
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    expect(await syncLocalShelf("u1")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("posts the stored JSON verbatim, then forgets the local copy", async () => {
    store.set(KEY, shelf);
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    expect(await syncLocalShelf("u1")).toBe(true);
    expect(calls).toEqual([{ url: "/api/me/folders/import", body: shelf }]);
    expect(store.get(KEY)).toBeUndefined();
  });

  it("is one request per user per page even when several callers race, and none after success", async () => {
    store.set(KEY, shelf);
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    const [a, b] = await Promise.all([syncLocalShelf("u1"), syncLocalShelf("u1")]);
    expect([a, b]).toEqual([true, true]);
    expect(await syncLocalShelf("u1")).toBe(true); // cached promise, no new request
    expect(calls).toHaveLength(1);
  });

  it("keeps the local copy when the account refuses, and tries again on the next call", async () => {
    store.set(KEY, shelf);
    respond = () => new Response(JSON.stringify({ error: "Please sign in first" }), { status: 401 });
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    expect(await syncLocalShelf("u1")).toBe(false);
    expect(store.get(KEY)).toBe(shelf);
    respond = () => new Response(JSON.stringify({ folders: [], assign: {} }), { status: 200 });
    expect(await syncLocalShelf("u1")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(store.get(KEY)).toBeUndefined();
  });
});

describe("edits made while the import is in flight", () => {
  it("are not wiped: the local copy is cleared only if it is still what was sent", async () => {
    store.set(KEY, shelf);
    const edited = JSON.stringify({ v: 1, folders: [{ id: "f_1", name: "Work" }, { id: "f_2", name: "Added meanwhile" }], assign: {} });
    respond = () => { store.set(KEY, edited); return new Response(JSON.stringify({ folders: [], assign: {} }), { status: 200 }); };
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    expect(await syncLocalShelf("u1")).toBe(true);
    expect(store.get(KEY)).toBe(edited); // survives; the next page load imports it (idempotently)
  });
});

describe("ordering with site adoption", () => {
  it("does not claim sites implicitly when importing folders", async () => {
    store.set(KEY, shelf);
    store.set("sites:editToken:abc", "tok-abc");
    respond = (url) => new Response(JSON.stringify(url.endsWith("/adopt") ? { adopted: 1, slugs: ["abc"] } : { folders: [], assign: {} }), { status: 200 });
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    expect(await syncLocalShelf("u1")).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["/api/me/folders/import"]);
  });

  it("welcome and folder import never claim sites automatically", async () => {
    store.set(KEY, shelf);
    store.set("sites:editToken:abc", "tok-abc");
    respond = (url) => new Response(JSON.stringify(url.endsWith("/adopt") ? { adopted: 0 } : { folders: [], assign: {} }), { status: 200 });
    const { adoptStoredSites } = await import("@/lib/adoption");
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    await Promise.all([adoptStoredSites(), syncLocalShelf("u1")]);
    expect(calls.filter((c) => c.url === "/api/me/adopt")).toHaveLength(0);
  });

  it("without stored tokens nothing is offered for adoption and the import goes straight through", async () => {
    store.set(KEY, shelf);
    const { syncLocalShelf } = await import("@/lib/folder-shelf");
    await syncLocalShelf("u1");
    expect(calls.map((c) => c.url)).toEqual(["/api/me/folders/import"]);
  });
});
