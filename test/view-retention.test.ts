import { afterEach, describe, expect, it, vi } from "vitest";
const prune = vi.hoisted(() => ({ share: vi.fn(), site: vi.fn() }));
vi.mock("@/lib/db", () => ({ pruneShareViews: prune.share, pruneSiteViews: prune.site }));
import { pruneViewDetails } from "@/lib/view-retention";

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); delete process.env.ARTIFACT_VIEW_RETENTION_DAYS; });
describe("view retention job", () => {
  it("drains each table independently and yields between batches", async () => {
    process.env.ARTIFACT_VIEW_RETENTION_DAYS = "7";
    prune.share.mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValue(4);
    prune.site.mockResolvedValue(2);
    expect(await pruneViewDetails(1_700_000_000_000)).toBe(2006);
    expect(prune.share).toHaveBeenCalledTimes(3);
    expect(prune.site).toHaveBeenCalledTimes(1);
    expect(prune.share.mock.invocationCallOrder[0]).toBeLessThan(prune.site.mock.invocationCallOrder[0]);
    expect(prune.site.mock.invocationCallOrder[0]).toBeLessThan(prune.share.mock.invocationCallOrder[1]);
  });
  it("starts no further batch after the soft deadline", async () => {
    process.env.ARTIFACT_VIEW_RETENTION_DAYS = "7";
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    prune.share.mockImplementation(async () => { elapsed = 20_001; return 1000; });
    prune.site.mockResolvedValue(1000);
    expect(await pruneViewDetails()).toBe(1000);
    expect(prune.share).toHaveBeenCalledTimes(1);
    expect(prune.site).not.toHaveBeenCalled();
  });
});
