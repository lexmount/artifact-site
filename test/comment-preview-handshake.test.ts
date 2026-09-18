import { afterEach, describe, expect, it, vi } from "vitest";
import { startPreviewHandshake } from "@/lib/comments/preview-handshake";

afterEach(() => { vi.useRealTimers(); });
describe("preview handshake lifecycle", () => {
  it("keeps retrying past a slow head and stops once it acknowledges", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const handshake = startPreviewHandshake(send);
    vi.advanceTimersByTime(6000);
    expect(send.mock.calls.length).toBeGreaterThan(8);
    expect(handshake.accept("index.html")).toBe(true);
    const count = send.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(count);
  });
  it("ignores an old document's ready before host navigation commits", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const handshake = startPreviewHandshake(send, "other.html");
    expect(handshake.accept("index.html")).toBe(false);
    expect(handshake.accept(null)).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(send.mock.calls.length).toBeGreaterThan(8);
    expect(handshake.accept("other.html")).toBe(true);
  });
  it("accepts the actual redirected path only after a fresh load handshake", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const navigating = startPreviewHandshake(send, "other.html");
    expect(navigating.accept("redirect.html")).toBe(false);
    navigating.stop();
    const loaded = startPreviewHandshake(send);
    expect(loaded.accept("redirect.html")).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("stops after eight unanswered attempts on a loaded frame", () => {
    vi.useFakeTimers();
    const send = vi.fn(), unavailable = vi.fn();
    const handshake = startPreviewHandshake(send, null, unavailable);
    handshake.markLoaded();
    vi.advanceTimersByTime(2400);
    expect(send).toHaveBeenCalledTimes(8);
    expect(unavailable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000);
    expect(send).toHaveBeenCalledTimes(8);
    expect(handshake.accept("index.html")).toBe(false);
  });
  it("allows a loaded frame to acknowledge before the cutoff", () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    const handshake = startPreviewHandshake(vi.fn(), null, unavailable);
    handshake.markLoaded();
    vi.advanceTimersByTime(2100);
    expect(handshake.accept("index.html")).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(unavailable).not.toHaveBeenCalled();
  });
  it("disposes all retries when the frame or scope is replaced", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const handshake = startPreviewHandshake(send);
    handshake.stop();
    vi.advanceTimersByTime(60000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(handshake.accept("index.html")).toBe(false);
  });
});
