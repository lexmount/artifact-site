import { afterEach, expect, it, vi } from "vitest";

const key = "artifact-comment-rail-collapsed";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("defaults to collapsed and honors a saved expanded preference", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("window", new EventTarget());
  const { commentRailPreference: preference } = await import("@/components/comments/comment-preferences");
  expect(preference.getServerSnapshot()).toBe(true);
  expect(preference.getSnapshot()).toBe(true);
  const changed = vi.fn();
  const unsubscribe = preference.subscribe(changed);
  preference.set(false);
  expect(values.get(key)).toBe("false");
  expect(preference.getSnapshot()).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  vi.resetModules();
  const restored = await import("@/components/comments/comment-preferences");
  expect(restored.commentRailPreference.getSnapshot()).toBe(false);
});

it("still toggles when browser storage is blocked", async () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); } });
  vi.stubGlobal("window", new EventTarget());
  const { commentRailPreference: preference } = await import("@/components/comments/comment-preferences");
  expect(preference.getSnapshot()).toBe(true);
  preference.set(false);
  expect(preference.getSnapshot()).toBe(false);
  preference.set(true);
  expect(preference.getSnapshot()).toBe(true);
});
