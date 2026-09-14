import { describe, it, expect, vi } from "vitest";
import {
  BAR_MODE_KEY, DEFAULT_BAR_MODE, HOVER_DWELL_MS, Dwell,
  hoverArmsReveal, leaveSchedulesHide, modeAutoHides, parseBarMode, readBarMode, writeBarMode, createBarModeStore,
} from "@/lib/bar-mode";

/**
 * The original complaint: "the title bar pops out whenever the mouse crosses the top edge of the
 * page — annoying, I was actually going to click another browser tab".
 * Three things are pinned here: manual by default (hover never reveals); in auto mode the pointer
 * must dwell a full 200ms before revealing; passing through (leaving before the deadline) never reveals.
 */
describe("reveal mode: manual by default, hover does not reveal", () => {
  it("defaults to manual", () => {
    expect(DEFAULT_BAR_MODE).toBe("manual");
    expect(readBarMode(null)).toBe("manual");
    expect(readBarMode(undefined)).toBe("manual");
  });

  it("in manual mode a real mouse entering the hot zone starts no timer, leaving schedules no auto-hide, and no self-hiding is allowed", () => {
    expect(hoverArmsReveal("manual", true)).toBe(false);
    expect(leaveSchedulesHide("manual", true)).toBe(false);
    expect(modeAutoHides("manual")).toBe(false);
    expect(modeAutoHides("auto")).toBe(true);
  });

  it("auto mode only trusts a real mouse: a touch-synthesised enter starts no timer (otherwise tap-to-flash is back)", () => {
    expect(hoverArmsReveal("auto", true)).toBe(true);
    expect(hoverArmsReveal("auto", false)).toBe(false);
    expect(leaveSchedulesHide("auto", true)).toBe(true);
    expect(leaveSchedulesHide("auto", false)).toBe(false);
  });
});

describe("preference persistence", () => {
  function mem(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  }
  it("round-trips through storage under a fixed key", () => {
    const s = mem();
    writeBarMode(s, "auto");
    expect(s.m.get(BAR_MODE_KEY)).toBe("auto");
    expect(readBarMode(s)).toBe("auto");
    writeBarMode(s, "manual");
    expect(readBarMode(s)).toBe("manual");
  });
  it("dirty data and unknown values fall back to the default without throwing", () => {
    expect(readBarMode(mem({ [BAR_MODE_KEY]: "pinned" }))).toBe("manual");
    expect(parseBarMode(42)).toBe("manual");
    expect(parseBarMode(null)).toBe("manual");
  });
  it("a throwing storage (private mode / disabled) does not affect the page: reads return the default, writes are silent", () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(readBarMode(broken)).toBe("manual");
    expect(() => writeBarMode(broken, "auto")).not.toThrow();
  });
});

describe("Dwell timer: a full dwell reveals, passing through does not", () => {
  function make(ms?: number) {
    const onFire = vi.fn();
    const d = new Dwell(onFire, ms, { set: (fn, t) => setTimeout(fn, t) as unknown as number, clear: (id) => clearTimeout(id) });
    return { d, onFire };
  }

  it("defaults to 200ms", () => { expect(HOVER_DWELL_MS).toBe(200); });

  it("fires only after a full 200ms; not yet at 199ms", () => {
    vi.useFakeTimers();
    try {
      const { d, onFire } = make();
      d.arm();
      expect(d.armed).toBe(true);
      vi.advanceTimersByTime(199);
      expect(onFire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(d.armed).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("passing through (cancel before the deadline) never fires — this is the going-to-click-a-tab path", () => {
    vi.useFakeTimers();
    try {
      const { d, onFire } = make();
      d.arm();
      vi.advanceTimersByTime(60); // crossing the 14px hot zone takes less than this
      d.cancel();
      expect(d.armed).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(onFire).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("jitter at the hot-zone edge (repeated arm) only counts the last arm and never accumulates multiple reveals", () => {
    vi.useFakeTimers();
    try {
      const { d, onFire } = make();
      d.arm(); vi.advanceTimersByTime(150);
      d.arm(); vi.advanceTimersByTime(150);
      expect(onFire).not.toHaveBeenCalled(); // only 150ms have elapsed since the second arm
      d.arm(); vi.advanceTimersByTime(200);
      expect(onFire).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("cancel is safe before any arm, and safe again after fire", () => {
    vi.useFakeTimers();
    try {
      const { d, onFire } = make();
      expect(() => d.cancel()).not.toThrow();
      d.arm(); vi.advanceTimersByTime(200);
      expect(() => d.cancel()).not.toThrow();
      expect(onFire).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("store: the layer consumed by useSyncExternalStore", () => {
  function mem() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  }
  it("the server snapshot is always the default; the client snapshot reads storage; set persists and notifies subscribers", () => {
    const s = mem();
    const store = createBarModeStore(() => s);
    expect(store.getServerSnapshot()).toBe("manual");
    expect(store.getSnapshot()).toBe("manual");
    const seen: string[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    store.set("auto");
    expect(s.m.get(BAR_MODE_KEY)).toBe("auto");
    expect(seen).toEqual(["auto"]);
    off();
    store.set("manual");
    expect(seen).toEqual(["auto"]); // no notifications after unsubscribing
    expect(store.getSnapshot()).toBe("manual");
  });
  it("a preference change from another tab (storage event) notifies this page's subscribers; unsubscribing stops listening", () => {
    const s = mem();
    const win = new EventTarget();
    const store = createBarModeStore(() => s, win);
    let notified = 0;
    const off = store.subscribe(() => { notified++; });
    s.m.set(BAR_MODE_KEY, "auto"); // written by another tab
    win.dispatchEvent(Object.assign(new Event("storage"), { key: BAR_MODE_KEY }));
    expect(notified).toBe(1);
    expect(store.getSnapshot()).toBe("auto");
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "unrelated" }));
    expect(notified).toBe(1); // other keys do not disturb us
    win.dispatchEvent(Object.assign(new Event("storage"), { key: null })); // clear() of the whole storage
    expect(notified).toBe(2);
    off();
    win.dispatchEvent(Object.assign(new Event("storage"), { key: BAR_MODE_KEY }));
    expect(notified).toBe(2);
  });
  it("with storage unavailable the snapshot is still the default and set does not throw", () => {
    const store = createBarModeStore(() => null);
    expect(store.getSnapshot()).toBe("manual");
    expect(() => store.set("auto")).not.toThrow();
  });
});
