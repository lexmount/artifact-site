import { afterEach, describe, expect, it, vi } from "vitest";
import { commentHeaders, commentRequest, CommentRequestError, mergeThreads, commentPollDelay, discoverCommentPermissions } from "../src/components/comments/comment-client";
import type { CommentThreadDetail } from "../src/lib/comments/contracts";

afterEach(() => vi.unstubAllGlobals());
describe("comment client authorization and pagination", () => {
  it("only carries the selected share credential in a host header", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await commentRequest("/api/sites/site/comments?versionId=v1", "secret");
    const [url, init] = fetch.mock.calls[0];
    expect(url).not.toContain("secret");
    expect(init.cache).toBe("no-store");
    expect(init.headers.get("x-artifact-share")).toBe("secret");
    expect(commentHeaders().has("x-artifact-share")).toBe(false);
  });
  it("preserves status for conflicts without rendering raw server errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "private internal detail" }, { status: 409 })));
    await expect(commentRequest("/comments")).rejects.toMatchObject({ status: 409 });
    expect(new CommentRequestError(409).message).not.toContain("private");
  });
  it("deduplicates paginated threads without changing server sort order", () => {
    const row = (id: string, updatedAt: number) => ({ thread: { id, updatedAt } }) as CommentThreadDetail;
    expect(mergeThreads([row("a", 1), row("b", 2)], { items: [row("a", 3), row("c", 2)], nextCursor: null }).map(item => item.thread.id)).toEqual(["a", "b", "c"]);
  });
});

 describe("comment polling retry budget", () => {
  it("backs off repeated failures, caps the wait and returns to normal after success", () => {
    expect([0, 1, 2, 3, 4, 50].map(commentPollDelay)).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
    expect(commentPollDelay(0)).toBe(10_000);
  });
});

describe("permission discovery", () => {
  afterEach(() => vi.useRealTimers());
  it.each([401, 403, 404])("stops after permanent denial %s", async status => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new CommentRequestError(status));
    const { stop } = discoverCommentPermissions(read, vi.fn(), () => false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });
  it("backs off transient failures, skips hidden tabs and stops on success", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const read = vi.fn().mockRejectedValueOnce(new CommentRequestError(429)).mockRejectedValueOnce(new TypeError("network")).mockResolvedValue("access");
    const accept = vi.fn();
    const { stop } = discoverCommentPermissions(read, accept, () => hidden);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    hidden = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(2);
    hidden = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(accept).toHaveBeenCalledWith("access");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });
  it("discovers immediately even when opened in a background tab", async () => {
    const read = vi.fn().mockResolvedValue("access"), accept = vi.fn();
    const { stop } = discoverCommentPermissions(read, accept, () => true);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith("access");
    stop();
  });
  it("resumes a deferred retry immediately on visibility without overlapping requests", async () => {
    vi.useFakeTimers();
    let hidden = true;
    const read = vi.fn().mockRejectedValueOnce(new CommentRequestError(503)).mockResolvedValue("access");
    const accept = vi.fn();
    const { stop, resume } = discoverCommentPermissions(read, accept, () => hidden);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    hidden = false; resume(); resume();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledWith("access");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
  it.each([401, 403, 404])("settles denial %s and only rechecks expired identity on focus", async status => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new CommentRequestError(status)).mockResolvedValue("signed in");
    const denied = vi.fn(), accept = vi.fn();
    const { stop, resume } = discoverCommentPermissions(read, accept, () => false, denied);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(denied).toHaveBeenCalledWith(status);
    expect(read).toHaveBeenCalledTimes(1);
    resume();await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    if(status === 401) expect(accept).toHaveBeenCalledWith("signed in");
    stop();
  });
  it.each([401, 503])("throttles repeated host focus during failure %s", async status => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new CommentRequestError(status));
    const {stop, resume} = discoverCommentPermissions(read, vi.fn(), () => false);
    await Promise.resolve();
    resume(); await Promise.resolve();
    for(let i=0;i<10;i++){resume();await Promise.resolve();}
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    resume(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores late responses after unmount", async () => {
    let resolve!: (value: string) => void;
    const accept = vi.fn();
    const { stop } = discoverCommentPermissions(() => new Promise<string>(r => {resolve = r;}), accept, () => false);
    stop(); resolve("late"); await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
  });
});
