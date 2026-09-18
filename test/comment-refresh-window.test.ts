import { describe, expect, it, vi } from "vitest";
import { refreshCommentWindow } from "@/components/comments/comment-client";
import { requestArtifactRefresh, ARTIFACT_REFRESH_EVENT } from "@/components/site-version-watcher";

describe("expanded comment window refresh", () => {
  it("refetches loaded pages with fresh cursors and tombstones", async () => {
    const read = vi.fn(async (cursor?: string) => cursor
      ? { items: [{ id: "older", body: null }], nextCursor: "remaining" }
      : { items: [{ id: "edited", body: "new" }], nextCursor: "fresh-cursor" });
    const result = await refreshCommentWindow<{ id: string; body: string | null }>(2, read);
    expect(read.mock.calls).toEqual([[undefined], ["fresh-cursor"]]);
    expect(result).toEqual({ items: [{ id: "edited", body: "new" }, { id: "older", body: null }], nextCursor: "remaining" });
  });
  it("retains the first-page total when continuations omit it", async () => {
    const result = await refreshCommentWindow(2, async cursor => cursor
      ? { items: [2], nextCursor: null }
      : { items: [1], nextCursor: "next", total: 2 });
    expect(result).toEqual({ items: [1, 2], nextCursor: null, total: 2 });
  });
  it("stops when deletion shrinks the available window", async () => {
    const read = vi.fn(async () => ({ items: [], nextCursor: null }));
    expect(await refreshCommentWindow(3, read)).toEqual({ items: [], nextCursor: null });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("reports a cancelled refresh without claiming it applied", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    target.addEventListener(ARTIFACT_REFRESH_EVENT, event => event.preventDefault());
    expect(requestArtifactRefresh()).toBe(false);
    vi.unstubAllGlobals();
  });
  it("distinguishes automatic arrivals from an explicit retry", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const details: unknown[] = [];
    target.addEventListener(ARTIFACT_REFRESH_EVENT, event => details.push((event as CustomEvent).detail));
    expect(requestArtifactRefresh("next-version", true)).toBe(true);
    expect(requestArtifactRefresh()).toBe(true);
    expect(details).toEqual([{ versionId: "next-version", automatic: true }, { versionId: undefined, automatic: false }]);
    vi.unstubAllGlobals();
  });
});
