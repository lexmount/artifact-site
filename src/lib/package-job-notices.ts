import type { PackageJobStatus } from "./package-job-contract";
export type JobReceipts = Record<string, string>;
export function jobReceipt(job: PackageJobStatus) { return `${job.status}:${job.attempts}${job.generation ? `:${job.generation}` : ""}`; }
export function unreadJob(job: PackageJobStatus, receipts: JobReceipts) {
  return (job.status === "failed" || job.status === "completed") && receipts[job.versionId] !== jobReceipt(job);
}
export function jobNotice(jobs: PackageJobStatus[], receipts: JobReceipts): "failed" | "running" | "completed" | null {
  if (jobs.some(job => job.status === "failed" && unreadJob(job, receipts))) return "failed";
  if (jobs.some(job => job.status === "queued" || job.status === "processing")) return "running";
  return jobs.some(job => job.status === "completed" && unreadJob(job, receipts)) ? "completed" : null;
}
export function readJobReceipts(value: string | null): JobReceipts {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, v]) => key.startsWith("ver_") && typeof v === "string").slice(-100));
  } catch { return {}; }
}
export function acknowledgeJobs(jobs: PackageJobStatus[], receipts: JobReceipts): JobReceipts {
  const next = { ...receipts };
  for (const job of jobs) if (job.status === "completed" || job.status === "failed") next[job.versionId] = jobReceipt(job);
  return Object.fromEntries(Object.entries(next).slice(-100));
}
