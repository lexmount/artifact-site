import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryNavigation } from "@/lib/directory-navigation";
afterEach(() => vi.useRealTimers());
describe("directory editing across delayed navigation", () => {
  it("keeps a pending search when switching views and includes it in immediate filters", () => {
    vi.useFakeTimers();
    const navigate = vi.fn(), view = vi.fn();
    const state = new DirectoryNavigation("page=2", navigate, view);
    state.change("q", "draft", 250);
    state.change("view", "grid");
    expect(view).toHaveBeenCalledWith("grid");
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(new URLSearchParams(navigate.mock.lastCall![0]).get("q")).toBe("draft");
    for (const key of ["sort", "folder", "tab"]) {
      state.change("q", key, 250);
      state.change(key, "selected");
      const query = new URLSearchParams(navigate.mock.lastCall![0]);
      expect(query.get("q")).toBe(key);
      expect(query.has("page")).toBe(false);
    }
  });
  it("preserves new characters and spaces when older search responses arrive", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    const state = new DirectoryNavigation("", navigate, vi.fn());
    state.change("q", "ab", 250);
    vi.advanceTimersByTime(250);
    const old = navigate.mock.lastCall![0];
    state.change("q", "abc ", 250);
    state.receive(old);
    expect(state.snapshot()).toBe("abc ");
    state.change("q", state.snapshot() + "d", 250);
    vi.advanceTimersByTime(250);
    expect(new URLSearchParams(navigate.mock.lastCall![0]).get("q")).toBe("abc d");
  });
  it("reapplies a newer view when an in-flight search commits its older URL", () => {
    vi.useFakeTimers();
    let url = "tab=owned";
    const navigate = vi.fn();
    const view = vi.fn((value: string) => {
      const params = new URLSearchParams(url);
      params.set("view", value);
      return url = params.toString();
    });
    const state = new DirectoryNavigation(url, navigate, view);
    state.change("q", "abc", 250);
    vi.advanceTimersByTime(250);
    const response = navigate.mock.lastCall![0];
    state.change("view", "grid");
    expect(view).not.toHaveBeenCalled();
    expect(state.viewSnapshot()).toBe("grid");
    // The pending router navigation now commits the URL captured before the view switch.
    url = response;
    state.receive(url);
    expect(new URLSearchParams(url).get("view")).toBe("grid");
    expect(new URLSearchParams(url).get("q")).toBe("abc");
    expect(state.viewSnapshot()).toBe("grid");
    expect(navigate).toHaveBeenCalledTimes(1);
    state.receive(url);
    expect(view).toHaveBeenCalledTimes(1);
    state.receive("tab=owned&view=list", true);
    expect(state.viewSnapshot()).toBe("list");
    expect(view).toHaveBeenCalledTimes(1);
  });
  it("syncs a deferred view when a search navigation fails", () => {
    const view = vi.fn();
    const state = new DirectoryNavigation("", vi.fn(), view);
    state.change("q", "search");
    state.change("view", "grid");
    expect(view).not.toHaveBeenCalled();
    state.finish("");
    expect(view).toHaveBeenCalledExactlyOnceWith("grid");
    expect(state.snapshot()).toBe("search");
  });
  it("restores external URLs and Back/Forward, cancelling pending edits", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    const state = new DirectoryNavigation("q=before", navigate, vi.fn());
    state.change("q", "after", 250);
    state.receive("q=before", true);
    vi.advanceTimersByTime(300);
    expect(navigate).not.toHaveBeenCalled();
    expect(state.snapshot()).toBe("before");
    state.receive("q=external");
    expect(state.snapshot()).toBe("external");
  });
});
