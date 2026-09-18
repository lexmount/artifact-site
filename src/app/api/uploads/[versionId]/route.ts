import { listUploadSessionsForTarget } from "@/lib/db";
import { getUploadSession, ownerKeyFor, UPLOAD_SESSION_TTL_MS } from "@/lib/upload-session";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { errorResponse, json } from "@/app/api/_util";
export async function GET(request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const { versionId } = await context.params;
    const session = await getUploadSession(versionId, await ownerKeyFor(request));
    if (!session) return json({ error: "Upload session not found or expired", code: "upload_not_found" }, 404);
    const parts = await listUploadSessionsForTarget(`mcp-parts:${session.ownerKey}`, versionId);
    const partialFiles = parts.map(part => {
      const chunks = part.files.filter(f => !["mcp-complete", "mcp-assembled"].includes(f.relpath));
      return { path: part.title, nextIndex: chunks.length, bytes: chunks.reduce((n, f) => n + f.bytes, 0), finalized: part.files.some(f => f.relpath === "mcp-assembled") };
    });
    return json({ partialFiles, versionId, status: "uploading", files: session.files, expiresAt: session.createdAt + UPLOAD_SESSION_TTL_MS });
  } catch (error) { return errorResponse(error); }
}
