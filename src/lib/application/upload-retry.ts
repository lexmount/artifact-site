import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { assertMutationOrigin } from "@/lib/request-auth";
import { ownerKeyFor } from "@/lib/upload-session";
import { retryPackageJob, readablePackageJob } from "@/lib/package-jobs";
import { errorResponse, json } from "@/lib/api-http";
export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    await assertMutationOrigin(request);
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const result = await retryPackageJob((await context.params).versionId, await ownerKeyFor(request));
    return result ? json(await readablePackageJob(request, result), 202) : json({ error: "Upload not found or expired" }, 404);
  } catch (error) { return errorResponse(error); }
}
