import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  SHARE_EDUCATION_KEY, SHARE_EDUCATION_DISMISSED_KEY, SHARE_EDUCATION_INTERVAL, SHARE_EDUCATION_CHANGED_EVENT,
  readShareEducation, claimShareEducation, dismissShareEducationForever,
  copyShareLink, isShareEducationStorageKey,
} from "@/lib/share-education";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
// Separate tab wrappers share the same origin-wide lock manager.
function locks() {
  const queues = new Map<string, Promise<unknown>>();
  return { request: <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    const result = (queues.get(name) ?? Promise.resolve()).then(run);
    queues.set(name, result.catch(() => undefined));
    return result;
  } };
}
beforeEach(() => {
  vi.stubGlobal("navigator", { locks: locks() });
  vi.stubGlobal("indexedDB", new IDBFactory());
});
async function flushEducation() {
  await navigator.locks.request(SHARE_EDUCATION_KEY, () => undefined);
}
const now = Date.UTC(2026, 8, 25, 10);
afterEach(() => vi.unstubAllGlobals());

describe("private-site education", () => {
  it("shows once per site session and at most once every 24 hours across sites", async () => {
    const local = memory(), session = memory();
    expect(await claimShareEducation(local, session, "a", now)).toBe(true);
    expect(await claimShareEducation(local, session, "b", now + 1)).toBe(false);
    expect(await claimShareEducation(local, memory(), "a", now + SHARE_EDUCATION_INTERVAL - 1)).toBe(false);
    expect(await claimShareEducation(local, session, "a", now + SHARE_EDUCATION_INTERVAL)).toBe(false);
    expect(await claimShareEducation(local, session, "b", now + SHARE_EDUCATION_INTERVAL)).toBe(true);
    expect(await claimShareEducation(local, memory(), "a", now + 2 * SHARE_EDUCATION_INTERVAL)).toBe(true);
    expect(readShareEducation(local).copies).toBe(0);
  });
  it("never reminds again after the browser opts out", async () => {
    const local = memory();
    dismissShareEducationForever(local);
    expect(readShareEducation(local).dismissed).toBe(true);
    expect(await claimShareEducation(local, memory(), "new-site", now)).toBe(false);
  });
  it("counts only successful clipboard writes, including repeated copies of an existing link", async () => {
    const local = memory(), events: Event[] = [];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText } });
    vi.stubGlobal("window", { localStorage: local, dispatchEvent: (event: Event) => { events.push(event); return true; } });
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    expect(readShareEducation(local).copies).toBe(1);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(copyShareLink("https://example.com/v/two")).rejects.toThrow("denied");
    expect(readShareEducation(local).copies).toBe(1);
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    expect(await claimShareEducation(local, memory(), "a", now)).toBe(true);
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    expect(readShareEducation(local).copies).toBe(3);
    expect(await claimShareEducation(local, memory(), "b", now + SHARE_EDUCATION_INTERVAL)).toBe(false);
    expect(events.map(event => event.type)).toEqual(Array(3).fill(SHARE_EDUCATION_CHANGED_EVENT));
  });
  it("finishes repeated copies while education is locked, then records them after release", async () => {
    const local = memory(), dispatchEvent = vi.fn(() => true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { localStorage: local, dispatchEvent });
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText } });
    let release!: () => void;
    const holding = navigator.locks.request(SHARE_EDUCATION_KEY, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
      for (let n = 1; n <= 2; n++) {
        const result = await Promise.race([
          copyShareLink("https://example.com/v/one").then(() => "copied"),
          new Promise(resolve => setTimeout(() => resolve("blocked"), 100)),
        ]);
        expect(result).toBe("copied");
        expect(writeText).toHaveBeenCalledTimes(n);
      }
      expect(readShareEducation(local).copies).toBe(0);
      expect(dispatchEvent).not.toHaveBeenCalled();
      dismissShareEducationForever(local);
    } finally {
      release(); await holding;
      await navigator.locks.request(SHARE_EDUCATION_KEY, () => undefined);
    }
    expect(readShareEducation(local)).toMatchObject({ copies: 2, dismissed: true });
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it("does not inherit old acknowledgement or creation counters", async () => {
    const local = memory();
    local.setItem("artifact-site:share-education:v1", JSON.stringify({ acknowledgements: 3, linksCreated: 3 }));
    expect(await claimShareEducation(local, memory(), "a", now)).toBe(true);
  });
  it("tolerates corrupt, unavailable and full storage without breaking copy", async () => {
    vi.resetModules();
    const { copyShareLink } = await import("@/lib/share-education");
    const local = memory();
    local.setItem(SHARE_EDUCATION_KEY, "broken");
    expect(readShareEducation(local)).toEqual({ copies: 0, dismissed: false, lastShownAt: null });
    local.setItem(SHARE_EDUCATION_KEY, JSON.stringify({ copies: -2, dismissed: "true", lastShownAt: "bad" }));
    expect(readShareEducation(local)).toEqual({ copies: 0, dismissed: false, lastShownAt: null });
    const broken = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } };
    expect(() => dismissShareEducationForever(broken)).not.toThrow();
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.stubGlobal("window", { get localStorage() { throw Error(); }, dispatchEvent: () => true });
    await expect(copyShareLink("https://example.com/v/one")).resolves.toBeUndefined();
    await flushEducation();
  });
  it("serializes competing claims before either tab can read the shared state", async () => {
    const local = memory();
    const getItem = vi.spyOn(local, "getItem");
    let release!: () => void;
    const holding = navigator.locks.request(SHARE_EDUCATION_KEY, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const first = claimShareEducation(local, memory(), "a", now);
    const second = claimShareEducation(local, memory(), "b", now);
    expect(getItem).not.toHaveBeenCalled();
    release(); await holding;
    expect(await Promise.all([first, second])).toEqual([true, false]);
  });
  it("uses committed state even when a second renderer still has a stale localStorage snapshot", async () => {
    // Chromium can deliver Web Lock grants before another renderer's localStorage cache update.
    const firstRenderer = memory(), staleRenderer = memory();
    expect(await Promise.all([
      claimShareEducation(firstRenderer, memory(), "a", now),
      claimShareEducation(staleRenderer, memory(), "b", now),
    ])).toEqual([true, false]);
  });
  it.each(["copy", "claim"])("cannot overwrite an opt-out interleaved with a %s snapshot", async action => {
    const local = memory();
    const getItem = local.getItem;
    let interrupt = true;
    local.getItem = key => {
      const snapshot = getItem(key);
      if (key === SHARE_EDUCATION_KEY && interrupt) {
        interrupt = false;
        dismissShareEducationForever(local);
      }
      return snapshot;
    };
    vi.stubGlobal("window", { localStorage: local, dispatchEvent: () => true });
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    if (action === "copy") { await copyShareLink("https://example.com/v/one"); await flushEducation(); }
    else await claimShareEducation(local, memory(), "a", now);
    expect(readShareEducation(local).dismissed).toBe(true);
    expect(await claimShareEducation(local, memory(), "b", now + SHARE_EDUCATION_INTERVAL)).toBe(false);
  });
  it("keeps copy progress when another renderer has an old localStorage cache", async () => {
    const first = memory(), stale = memory();
    vi.stubGlobal("navigator", {locks:navigator.locks,clipboard:{writeText:vi.fn().mockResolvedValue(undefined)}});
    vi.stubGlobal("window", {localStorage:first,dispatchEvent:()=>true});
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    vi.stubGlobal("window", {localStorage:stale,dispatchEvent:()=>true});
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    await copyShareLink("https://example.com/v/one");
    await flushEducation();
    expect(readShareEducation(stale).copies).toBe(3);
    expect(await claimShareEducation(memory(), memory(), "new-site", now)).toBe(false);
  });
  it("does not consume the cooldown when an unmounted component was waiting for the lock", async () => {
    const local = memory();
    let active = true;
    const pending = claimShareEducation(local, memory(), "a", now, () => active);
    active = false;
    expect(await pending).toBe(false);
    expect(readShareEducation(local).lastShownAt).toBeNull();
  });
  it("keeps opt-out even when the progress JSON is corrupt", () => {
    const local = memory();
    dismissShareEducationForever(local);
    local.setItem(SHARE_EDUCATION_KEY, "broken");
    expect(readShareEducation(local).dismissed).toBe(true);
  });
  it("keeps all concurrent successful copies", async () => {
    const local = memory();
    vi.stubGlobal("window", { localStorage: local, dispatchEvent: () => true });
    vi.stubGlobal("navigator", { locks: navigator.locks, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await Promise.all(Array.from({length:3}, () => copyShareLink("https://example.com/v/one")));
    await flushEducation();
    expect(readShareEducation(local).copies).toBe(3);
  });
  it("skips optional guidance when cross-tab coordination is unavailable without failing copy", async () => {
    const local = memory();
    vi.stubGlobal("window", { localStorage: local, dispatchEvent: () => true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    for (const locks of [undefined, {request: () => Promise.reject(new Error("blocked"))}]) {
      vi.stubGlobal("navigator", { locks, clipboard: { writeText } });
      expect(await claimShareEducation(local, memory(), "a", now)).toBe(false);
      await expect(copyShareLink("https://example.com/v/one")).resolves.toBeUndefined();
    }
    expect(writeText).toHaveBeenCalledTimes(2);
  });
  it("skips guidance without breaking copy when IndexedDB is unavailable", async () => {
    const local = memory();
    vi.stubGlobal("window", {localStorage:local,dispatchEvent:()=>true});
    vi.stubGlobal("navigator", {locks:navigator.locks,clipboard:{writeText:vi.fn().mockResolvedValue(undefined)}});
    for (const storage of [undefined,{open:()=>{throw new Error("blocked");}}]) {
      vi.stubGlobal("indexedDB",storage);
      expect(await claimShareEducation(local,memory(),"a",now)).toBe(false);
      await expect(copyShareLink("https://example.com/v/one")).resolves.toBeUndefined();
    }
  });
  it("only reacts to the current education key or storage clearing", () => {
    expect(isShareEducationStorageKey(SHARE_EDUCATION_KEY)).toBe(true);
    expect(isShareEducationStorageKey(SHARE_EDUCATION_DISMISSED_KEY)).toBe(true);
    expect(isShareEducationStorageKey(null)).toBe(true);
    expect(isShareEducationStorageKey("locale")).toBe(false);
  });
});
