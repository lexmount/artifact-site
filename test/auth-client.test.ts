import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const user = { id: "u1", email: null, displayName: "User", avatarUrl: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

it("shares account updates with every subscriber and bypasses HTTP caches", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true }));
  vi.stubGlobal("fetch", fetcher);
  const store = await import("@/lib/auth-store");
  const a = vi.fn(), b = vi.fn();
  const offA = store.subscribeAuth(a), offB = store.subscribeAuth(b);
  await Promise.all([store.refreshAuth(), store.refreshAuth()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ cache: "no-store" }));
  expect(store.getAuthSnapshot().user).toEqual(user);
  await store.refreshAuth();
  expect(store.getAuthSnapshot().user).toBeNull();
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(2);
  offA(); offB();
});

it("keeps known identity on server failure and permits retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ error: "unavailable" }, 503))
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  await store.refreshAuth();
  expect(store.getAuthSnapshot()).toMatchObject({ user, error: true });
  await store.refreshAuth();
  expect(store.getAuthSnapshot()).toMatchObject({ user: null, error: false });
});

it.each(["headers", "body"])("releases a stalled account %s request so the same tab can retry", async stage => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn().mockImplementationOnce((_url, init: RequestInit) => {
    signal = init.signal ?? undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    return stage === "headers" ? stalled : Promise.resolve({ ok: true, json: () => stalled });
  }).mockResolvedValueOnce(response({ user, oidcEnabled: true }));
  vi.stubGlobal("fetch", fetcher);
  const store = await import("@/lib/auth-store");
  const pending = store.refreshAuth();
  expect(store.refreshAuth()).toBe(pending);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.getAuthSnapshot()).toMatchObject({ loading: false, error: true, user: null });
  expect(signal?.aborted).toBe(true);
  await pending;
  await store.refreshAuth();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(store.getAuthSnapshot()).toMatchObject({ loading: false, error: false, user });
  expect(vi.getTimerCount()).toBe(0);
});

it("retains a confirmed identity when a later account check times out", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  const pending = store.refreshAuth();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.getAuthSnapshot()).toMatchObject({ loading: false, error: true, user });
  await pending;
});

it("does not let a superseded timeout publish an error or clear the newer request", async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const store = await import("@/lib/auth-store");
  const old = store.refreshAuth();
  await vi.advanceTimersByTimeAsync(5_000);
  store.resetAuthCache();
  const current = store.refreshAuth();
  await vi.advanceTimersByTimeAsync(5_000);
  await old;
  expect(store.getAuthSnapshot()).toMatchObject({ loading: true, error: false });
  expect(store.refreshAuth()).toBe(current);
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(response({ user, oidcEnabled: true }));
  await current;
  expect(store.getAuthSnapshot()).toMatchObject({ loading: false, error: false, user });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not treat a rejected logout as success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ error: "Cross-site request rejected" }, 401)));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  await expect(store.logoutAuth()).rejects.toThrow();
  expect(store.getAuthSnapshot().user).toEqual(user);
});

it("ignores a stale signed-in request arriving after logout", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(response({ ok: true })));
  const store = await import("@/lib/auth-store");
  const pending = store.refreshAuth();
  await store.logoutAuth();
  finish(response({ user, oidcEnabled: true }));
  await pending;
  expect(store.getAuthSnapshot().user).toBeNull();
});

it("revalidates on focus and cross-tab account changes and removes listeners", async () => {
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ user, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  const off = store.subscribeAuth(vi.fn());
  await store.refreshAuth();
  browser.dispatchEvent(new Event("focus"));
  await store.refreshAuth();
  expect(store.getAuthSnapshot().user).toBeNull();
  const event = new Event("storage");
  Object.assign(event, { key: "artifact-site:auth-change" });
  browser.dispatchEvent(event);
  await store.refreshAuth();
  expect(store.getAuthSnapshot().user).toEqual(user);
  off();
  browser.dispatchEvent(new Event("focus"));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("uses the deployment subpath for account checks and logout", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifacts");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ ok: true })));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  await store.logoutAuth();
  expect(fetch).toHaveBeenNthCalledWith(1, "/artifacts/api/auth/me", expect.any(Object));
  expect(fetch).toHaveBeenNthCalledWith(2, "/artifacts/api/auth/logout", expect.objectContaining({ method: "POST" }));
});

it("invalidates permission and data caches when identity changes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  const { registerClientCache } = await import("@/lib/client-cache");
  const clear = vi.fn();
  registerClientCache(clear);
  await store.refreshAuth();
  clear.mockClear();
  await store.refreshAuth();
  expect(clear).toHaveBeenCalledOnce();
});

function callbackMarker(marker = "callback-event") {
  let cookie = `artifact_auth_change=${marker}`;
  const storage = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem } });
  const removeCookie = vi.fn((value: string) => { if (value.includes("Max-Age=0")) cookie = ""; });
  vi.stubGlobal("document", { get cookie() { return cookie; }, set cookie(value: string) { removeCookie(value); } });
  return { setItem, removeCookie, replay: () => { cookie = `artifact_auth_change=${marker}`; } };
}

it("consumes a callback-issued sync marker once after confirming the session", async () => {
  const marker = callbackMarker();
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifacts");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response({ user, oidcEnabled: true }))));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  expect(marker.setItem).toHaveBeenCalledWith("artifact-site:auth-change", "callback-event");
  expect(marker.removeCookie).toHaveBeenCalledWith(expect.stringContaining("Path=/artifacts;"));
  await store.refreshAuth();
  marker.replay(); // A second tab reading the same marker must not emit another storage event.
  vi.resetModules();
  const otherTab = await import("@/lib/auth-store");
  await otherTab.refreshAuth();
  expect(marker.setItem).toHaveBeenCalledOnce();
});

it("retains a callback sync marker on a failed check and consumes it on retry", async () => {
  const marker = callbackMarker();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ error: "unavailable" }, 503))
    .mockResolvedValueOnce(response({ user, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  expect(marker.setItem).not.toHaveBeenCalled();
  expect(marker.removeCookie).not.toHaveBeenCalled();
  await store.refreshAuth();
  expect(marker.setItem).toHaveBeenCalledOnce();
});

it("does not broadcast routine account checks or anonymous callback landings", async () => {
  const marker = callbackMarker();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user: null, oidcEnabled: true }))
    .mockResolvedValueOnce(response({ user, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  expect(marker.setItem).not.toHaveBeenCalled();
  // An anonymous result consumes the stale marker without announcing a login.
  expect(marker.removeCookie).toHaveBeenCalledOnce();
  await store.refreshAuth();
  expect(marker.setItem).not.toHaveBeenCalled();
});

it("does not turn successful logout into failure when browser sync APIs are unavailable", async () => {
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ok: true })));
  const store = await import("@/lib/auth-store");
  await expect(store.logoutAuth()).resolves.toBeUndefined();
});

it("does not let a pre-login account request consume a newer callback marker", async () => {
  const marker = callbackMarker();
  document.cookie = "artifact_auth_change=; Max-Age=0";
  marker.removeCookie.mockClear();
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(response({ user, oidcEnabled: true })));
  const store = await import("@/lib/auth-store");
  const pending = store.refreshAuth();
  marker.replay(); // The login callback completes while the old anonymous request is in flight.
  finish(response({ user: null, oidcEnabled: true }));
  await pending;
  expect(marker.removeCookie).not.toHaveBeenCalled();
  expect(marker.setItem).not.toHaveBeenCalled();
  await store.refreshAuth();
  expect(marker.setItem).toHaveBeenCalledOnce();
});

it("automatically authenticates once, preserving mounted path, query and fragment", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifacts");
  const replace = vi.fn();
  const memory = new Map<string, string>();
  const browser = { location: { pathname: "/artifacts/me", search: "?view=all", hash: "#folder", replace },
    sessionStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v) } };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response({ user: null, oidcEnabled: true, autoLogin: true }))));
  const store = await import("@/lib/auth-store");
  await store.refreshAuth();
  await store.refreshAuth();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledWith("/artifacts/api/auth/login?silent=1&return_to=%2Fartifacts%2Fme%3Fview%3Dall%23folder");
  vi.resetModules();
  await (await import("@/lib/auth-store")).refreshAuth();
  expect(replace).toHaveBeenCalledTimes(1);
});

it("does not restart automatic navigation on focus after the initial guest cooldown expires", async () => {
  const replace = vi.fn();
  const browser = Object.assign(new EventTarget(), {
    location: { pathname: "/", search: "", hash: "", replace },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
  });
  vi.stubGlobal("window", browser);
  let now = 100_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true, autoLogin: false }))
    .mockResolvedValueOnce(response({ user: null, oidcEnabled: true, autoLogin: true })));
  const store = await import("@/lib/auth-store");
  const off = store.subscribeAuth(vi.fn());
  try {
    await store.refreshAuth();
    now += 61_000;
    browser.dispatchEvent(new Event("focus"));
    await store.refreshAuth();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  } finally { off(); clock.mockRestore(); }
});
