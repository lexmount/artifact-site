import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { ownerKeyFor } from "@/lib/upload-session";
import { listPackageJobs, readablePackageJob } from "@/lib/package-jobs";
import { errorResponse, json } from "@/lib/api-http";
export async function GET(request: Request) {
  try {
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const jobs = await listPackageJobs(await ownerKeyFor(request));
    const visible = await Promise.all(jobs.map(job => readablePackageJob(request, job).catch(() => null)));
    return json({ jobs: visible.filter(Boolean) });
  } catch (error) { return errorResponse(error); }
}
