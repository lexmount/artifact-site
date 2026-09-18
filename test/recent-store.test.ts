import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocal, writeLocal } from "@/lib/local-store";
import { updateRecent } from "@/lib/recent-store";

vi.mock("@/lib/local-store", () => ({ readLocal: vi.fn(), writeLocal: vi.fn() }));
beforeEach(() => {
  vi.mocked(readLocal).mockReturnValue(null);
  vi.mocked(writeLocal).mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function lockThatRunsCallback() {
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, callback: () => void) => callback() } });
}
describe("recent history storage failures", () => {
  it("falls back when locks are unavailable before the callback starts", async () => {
    vi.stubGlobal("navigator", { locks: { request: async () => { throw new DOMException("Disabled", "SecurityError"); } } });
    await updateRecent(items => items);
    expect(writeLocal).toHaveBeenCalledTimes(1);
  });
  it("does not replay a failed transform after it has acquired the lock", async () => {
    lockThatRunsCallback();
    const change = vi.fn(() => { throw new Error("Invalid transformation"); });
    await expect(updateRecent(change)).rejects.toThrow("Invalid transformation");
    expect(change).toHaveBeenCalledTimes(1);
    expect(writeLocal).not.toHaveBeenCalled();
  });
  it("does not retry a quota failure handled by the local-storage wrapper", async () => {
    lockThatRunsCallback();
    vi.mocked(writeLocal).mockReturnValue(false);
    await updateRecent(items => items);
    expect(writeLocal).toHaveBeenCalledTimes(1);
  });
});
