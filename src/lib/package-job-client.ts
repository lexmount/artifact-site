export const packageStages: Record<string, string> = { assembling: "Assembling uploaded package", queued: "Waiting to process", validating: "Checking package", extracting: "Extracting package", uploading_preview_files: "Preparing preview files", publishing: "Publishing package", failed: "Package processing failed", completed: "Ready to preview" };
import type { PackageJobStatus } from "@/lib/package-job-contract";
export function isPackageJob(value: unknown): value is PackageJobStatus {
  return Boolean(value && typeof value === "object" && "status" in value && ["queued", "processing", "failed", "completed"].includes(String(value.status)));
}
/** A failed poll does not mean the durable task failed; allow normal transient recovery. */
export async function waitForPackageJob(versionId: string, request: typeof fetch, headers: HeadersInit = {}, progress?: (job: PackageJobStatus) => void, reject?: (response: Response) => Promise<unknown>): Promise<Record<string, unknown>> {
  let failures = 0;
  for (;;) {
    const response = await request(`/api/uploads/${encodeURIComponent(versionId)}`, { headers }).catch(() => null);
    if (!response || response.status >= 500) {
      if (++failures >= 5) throw new Error(`Could not check package processing. Resume upload ${versionId} from My sites.`);
    } else {
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "Could not check package processing");
      if (!isPackageJob(job)) throw new Error("Unexpected package processing response");
      failures = 0; progress?.(job);
      if (job.status === "completed" && job.result) return job.result;
      if (job.status === "failed") {
        if (job.failure && reject) await reject(Response.json(job.failure.body, { status: job.failure.status }));
        throw new Error(job.error || "Package processing failed");
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
