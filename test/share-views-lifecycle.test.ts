import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => (() => void)>, writes: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (value: unknown) => [value, hooks.writes],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void)) => hooks.effects.push(effect),
}));
vi.mock("@/components/locale-provider", () => ({ useT: () => (s: string) => s, useLocale: () => "en" }));
import ShareViews from "@/components/share-views";

beforeEach(() => { hooks.effects.length = 0; hooks.writes.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

it("does not publish state when cleanup aborts pending response-body parsing", async () => {
  let resolveBody!: (value: unknown) => void;
  const body = new Promise(resolve => { resolveBody = resolve; });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: () => body })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ shares: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  ShareViews({ slug: "example" });
  const cleanup = hooks.effects[0]();
  await Promise.resolve();
  cleanup();
  hooks.writes.mockClear();
  resolveBody({});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetchMock.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
  expect(hooks.writes).not.toHaveBeenCalled();
});
