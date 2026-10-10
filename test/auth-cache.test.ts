import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ path: "/", previous: undefined as unknown }));
vi.mock("next/navigation", () => ({ usePathname: () => hooks.path }));

// Exercise the external store through the hook adapter, without mounting a DOM.
vi.mock("react", () => ({
  useEffect: (effect: () => void, deps: unknown[]) => {
    if (hooks.previous !== deps[0]) { hooks.previous = deps[0]; effect(); }
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
afterEach(() => { hooks.previous = undefined; hooks.path = "/"; vi.unstubAllGlobals(); vi.resetModules(); });

it("ignores an old identity response after an explicit auth reset", async () => {
  const pending: ((response: Response) => void)[] = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))));
  const { useAuth, resetAuthCache } = await import("@/lib/use-auth");
  expect(useAuth().loading).toBe(true);
  resetAuthCache();
  expect(pending).toHaveLength(2);
  pending[1](Response.json({user: {id: "current"}, oidcEnabled: true}));
  await vi.waitFor(() => expect(useAuth().user?.id).toBe("current"));
  pending[0](Response.json({user: {id: "previous"}, oidcEnabled: true}));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(useAuth().user?.id).toBe("current");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rechecks the account when navigating with a mounted header", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ user: null, oidcEnabled: true }))
    .mockResolvedValueOnce(Response.json({ user: { id: "current" }, oidcEnabled: true })));
  const { useAuth } = await import("@/lib/use-auth");
  useAuth();
  await vi.waitFor(() => expect(useAuth().loading).toBe(false));
  hooks.path = "/me";
  useAuth();
  await vi.waitFor(() => expect(useAuth().user?.id).toBe("current"));
  expect(fetch).toHaveBeenCalledTimes(2);
});
