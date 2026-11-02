import { describe, expect, it } from "vitest";
import { acknowledgeJobs, jobNotice, readJobReceipts, unreadJob } from "@/lib/package-job-notices";
import type { PackageJobStatus } from "@/lib/package-job-contract";
const job = (status: PackageJobStatus["status"], id: string = status, attempts = 1): PackageJobStatus => ({ versionId: `ver_${id}`, title: "Archive.zip", targetSlug: null, status, stage: status, attempts, totalFiles: null, processedFiles: 0, retryable: true, expiresAt: 123 });
describe("upload task attention", () => {
  it("prioritizes unread failure over running work over unread success", () => {
    const jobs = [job("completed"), job("queued"), job("failed")];
    expect(jobNotice(jobs, {})).toBe("failed");
    const read = acknowledgeJobs([jobs[2]], {});
    expect(jobNotice(jobs, read)).toBe("running");
    expect(jobNotice([jobs[0], jobs[2]], read)).toBe("completed");
    expect(jobNotice([jobs[0], jobs[2]], acknowledgeJobs(jobs, read))).toBeNull();
  });
  it("keeps queued and processing work visible even after visiting the task tab", () => {
    for (const state of ["queued", "processing"] as const) expect(jobNotice([job(state)], acknowledgeJobs([job(state)], {}))).toBe("running");
  });
  it("only acknowledges the visible results and preserves other receipts", () => {
    const a = job("failed", "a"), b = job("failed", "b");
    const receipts = acknowledgeJobs([a], { ver_old: "completed:1" });
    expect(unreadJob(a, receipts)).toBe(false); expect(unreadJob(b, receipts)).toBe(true);
    expect(receipts.ver_old).toBe("completed:1");
  });
  it("announces a new retry generation even when attempts reset from 3 to 0 to 3", () => {
    const failed = { ...job("failed", "a", 3), generation: "first" };
    const receipts = readJobReceipts(JSON.stringify(acknowledgeJobs([failed], {})));
    expect(unreadJob({ ...failed }, receipts)).toBe(false);
    expect(jobNotice([{ ...failed, status: "queued", attempts: 0, generation: "second" }], receipts)).toBe("running");
    const failedAgain = { ...failed, generation: "second" };
    // It remains unread even if a browser never observed the intermediate queued state.
    expect(unreadJob(failedAgain, receipts)).toBe(true);
    expect(jobNotice([failedAgain], receipts)).toBe("failed");
    expect(unreadJob(failedAgain, acknowledgeJobs([failedAgain], receipts))).toBe(false);
    expect(unreadJob({ ...failedAgain, status: "completed" }, receipts)).toBe(true);
  });
  it("survives reloads, malformed storage and bounded history", () => {
    const receipts = acknowledgeJobs([job("failed")], {});
    expect(jobNotice([job("failed")], readJobReceipts(JSON.stringify(receipts)))).toBeNull();
    for (const value of [null, "bad", "null", "[]", "42"]) expect(readJobReceipts(value)).toEqual({});
    expect(readJobReceipts('{"ver_a":false,"unrelated":"failed:1"}')).toEqual({});
    expect(Object.keys(acknowledgeJobs(Array.from({ length: 150 }, (_, i) => job("completed", String(i))), {}))).toHaveLength(100);
    expect(jobNotice([], {})).toBeNull();
  });
});
