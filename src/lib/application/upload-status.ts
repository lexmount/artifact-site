import { packageJobStatus, readablePackageJob } from "@/lib/package-jobs";
import { OperationError } from "@/lib/publish-operation";
import { PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { listUploadSessionsForTarget } from "@/lib/db";
import { getUploadSession, ownerKeyFor, UPLOAD_SESSION_TTL_MS } from "@/lib/upload-session";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { errorResponse, json } from "@/lib/api-http";
export async function GET(request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const { versionId } = await context.params;
    const owner = await ownerKeyFor(request);
    const job = await packageJobStatus(versionId, owner);
    if (job) return json(await readablePackageJob(request, job));
    const session = await getUploadSession(versionId, owner);
    if (!session) return json({ error: "Upload session not found or expired", code: "upload_not_found" }, 404);
    const parts = await listUploadSessionsForTarget(`mcp-parts:${session.ownerKey}`, versionId);
    const partialFiles = parts.map(part => {
      const chunks = part.files.filter(f => !["mcp-complete", "mcp-assembled"].includes(f.relpath));
      return { chunks: chunks.map(f => ({ bytes: f.bytes, sha256: f.sha256 })), path: part.title, nextIndex: chunks.length, bytes: chunks.reduce((n, f) => n + f.bytes, 0), sealed: part.files.some(f => f.relpath === "mcp-complete"), finalized: part.files.some(f => f.relpath === "mcp-assembled") };
    });
    return json({ partialFiles, versionId, status: "uploading", files: session.files.map(f => ({ ...f, relpath: f.relpath === PACKAGE_ORIGINAL ? "original" : f.relpath })), expiresAt: session.createdAt + UPLOAD_SESSION_TTL_MS });
  } catch (error) {
    if (error instanceof OperationError) return json({ error: error.message, code: error.code }, error.statusCode);
    return errorResponse(error);
  }
}
