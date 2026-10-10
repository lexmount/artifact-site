import { afterEach, beforeEach, expect, it, vi } from "vitest";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const sharing = { siteId: "site-1", visibility: "private", members: [], canManageMembers: true, moreMembers: false };
const comments = { mainPolicy: "login" as const, readerAccess: true };
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("prefetches in parallel, deduplicates entrances and reveals access before comments finish", async () => {
  const access = deferred(), discussion = deferred();
  const fetcher = vi.fn().mockReturnValueOnce(access.promise).mockReturnValueOnce(discussion.promise);
  vi.stubGlobal("fetch", fetcher);
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  const pending = cache.load();
  const second = sharingResource("alice", "demo").load();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(second).toBe(pending);
  access.resolve(response(sharing));
  await vi.waitFor(() => expect(cache.getSnapshot().sharing).toEqual(sharing));
  expect(cache.getSnapshot().comments).toBeNull();
  discussion.resolve(response(comments));
  await pending;
  await cache.load();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(cache.getSnapshot().comments).toEqual(comments);
});

it("keeps loaded content during revalidation but reports a failed refresh", async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes("comment-settings") ? comments : sharing)));
  vi.stubGlobal("fetch", fetcher);
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  await cache.load();
  const wait = deferred();
  fetcher.mockImplementation(() => wait.promise);
  const pending = cache.load(true);
  expect(cache.getSnapshot()).toMatchObject({ sharing, pending: true });
  wait.resolve(response({}, 503));
  await pending;
  expect(cache.getSnapshot()).toMatchObject({ sharing, sharingError: true, commentsError: true, pending: false });
});

it("invalidates on account changes and ignores the previous session's late responses", async () => {
  const a = deferred(), b = deferred();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
  const { sharingResource } = await import("@/lib/sharing-cache");
  const { invalidateClientCaches } = await import("@/lib/client-cache");
  const cache = sharingResource("alice", "demo");
  const changed = vi.fn();
  const stop = cache.subscribe(changed);
  const pending = cache.load();
  invalidateClientCaches();
  a.resolve(response(sharing)); b.resolve(response(comments));
  await pending;
  expect(cache.getSnapshot().sharing).toBeNull();
  expect(cache.getSnapshot().comments).toBeNull();
  expect(sharingResource("bob", "demo").getSnapshot().sharing).toBeNull();
  expect(changed).toHaveBeenCalled();
  stop();
});

it("clears revoked access even when comments respond later", async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes("comment-settings") ? comments : sharing)));
  vi.stubGlobal("fetch", fetcher);
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  await cache.load();
  const b = deferred();
  fetcher.mockImplementationOnce(() => Promise.resolve(response({}, 403))).mockImplementationOnce(() => b.promise);
  const pending = cache.load(true);
  await vi.waitFor(() => expect(cache.getSnapshot().sharing).toBeNull());
  b.resolve(response(comments));
  await pending;
  expect(cache.getSnapshot()).toMatchObject({ sharing: null, comments: null, sharingError: true });
});

it("never overwrites a successful mutation with a preceding read and respects subpaths", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifacts");
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes("comment-settings") ? comments : sharing)));
  vi.stubGlobal("fetch", fetcher);
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  await cache.load();
  expect(fetcher).toHaveBeenCalledWith("/artifacts/api/sites/demo/sharing?summary=1", expect.objectContaining({ cache: "no-store" }));
  const a = deferred(), b = deferred();
  fetcher.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  const pending = cache.load(true);
  cache.update({ sharing: { ...sharing, visibility: "unlisted" } as NonNullable<ReturnType<typeof cache.getSnapshot>["sharing"]> });
  a.resolve(response(sharing)); b.resolve(response(comments));
  await pending;
  expect(cache.getSnapshot().sharing?.visibility).toBe("unlisted");
});

it("does not restore a saved mutation after the account cache was cleared", async () => {
  const { sharingResource } = await import("@/lib/sharing-cache");
  const { invalidateClientCaches } = await import("@/lib/client-cache");
  const cache = sharingResource("alice", "demo");
  const commit = cache.captureMutation();
  invalidateClientCaches();
  expect(commit({ comments })).toBe(false);
  expect(cache.getSnapshot().comments).toBeNull();
});

it("treats unavailable anonymous comment management as an absent section, not a perpetual error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(url.includes("comment-settings") ? response({},404) : response(sharing))));
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("anonymous", "demo");
  await cache.load();
  expect(cache.getSnapshot()).toMatchObject({ sharing, comments: null, commentsError: false, commentsUnavailable: true });
});

it("revalidates expired data without removing it from the snapshot", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes("comment-settings") ? comments : sharing)));
    vi.stubGlobal("fetch", fetcher);
    const { sharingResource } = await import("@/lib/sharing-cache");
    const cache = sharingResource("alice", "demo");
    await cache.load();
    vi.advanceTimersByTime(30_001);
    const pending = cache.load();
    expect(cache.getSnapshot().sharing).toEqual(sharing);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

it("retries failed access while comments are still pending and ignores replaced responses", async () => {
  const oldComments = deferred(), newComments = deferred();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({}, 503)).mockReturnValueOnce(oldComments.promise)
    .mockResolvedValueOnce(response(sharing)).mockReturnValueOnce(newComments.promise);
  vi.stubGlobal("fetch", fetcher);
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  const first = cache.load();
  await vi.waitFor(() => expect(cache.getSnapshot().sharingError).toBe(true));
  expect(cache.getSnapshot()).toMatchObject({ pending: true, sharingPending: false, commentsPending: true });
  const retry = cache.load(true);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(cache.load(true)).toBe(retry);
  await vi.waitFor(() => expect(cache.getSnapshot()).toMatchObject({ sharing, sharingError: false, commentsPending: true }));
  oldComments.resolve(response({ ...comments, mainPolicy: "off" }));
  await first;
  expect(cache.getSnapshot()).toMatchObject({ comments: null, pending: true });
  newComments.resolve(response(comments));
  await retry;
  expect(cache.getSnapshot()).toMatchObject({ sharing, comments, pending: false });
});

it("allows another retry if access fails again before comments finish", async () => {
  const discussions = [deferred(), deferred(), deferred()];
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("comment-settings")
    ? discussions[attempts - 1].promise
    : Promise.resolve(++attempts < 3 ? response({}, 503) : response(sharing))));
  const { sharingResource } = await import("@/lib/sharing-cache");
  const cache = sharingResource("alice", "demo");
  const first = cache.load();
  await vi.waitFor(() => expect(cache.getSnapshot()).toMatchObject({ sharingError: true, sharingPending: false }));
  const second = cache.load(true);
  await vi.waitFor(() => expect(cache.getSnapshot()).toMatchObject({ sharingError: true, sharingPending: false }));
  const third = cache.load(true);
  await vi.waitFor(() => expect(cache.getSnapshot().sharing).toEqual(sharing));
  expect(attempts).toBe(3);
  discussions.forEach(item => item.resolve(response(comments)));
  await Promise.all([first, second, third]);
});
