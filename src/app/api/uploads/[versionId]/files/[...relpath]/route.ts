// PUT /api/uploads/<versionId>/files/<relpath> — **stream** one file into the version.
//
// The request body is the file's raw bytes, not multipart: multipart has to be parsed into FormData
// before its content is reachable, and that step reads the whole file into memory — exactly what
// this route exists to avoid. One file per request also makes each request exactly as large as that
// file, which naturally keeps it within the gateway's per-request limit.
import type { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import { getStorage } from "@/lib/storage";
import { assertSessionRoom, getUploadSession, ownerKeyFor, recordUploadedFile } from "@/lib/upload-session";
import { CROSS_SITE_REJECTED, isCrossSiteForTarget } from "@/lib/upload-csrf";
import { errorResponse, json } from "../../../../_util";

export async function PUT(request: Request, context: { params: Promise<{ versionId: string; relpath: string[] }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { versionId, relpath } = await context.params;
    // An identity mismatch is treated as "no such session" — do not reveal to an outsider holding the versionId that it exists.
    const session = await getUploadSession(versionId, await ownerKeyFor(request));
    if (!session) return json({ error: "The upload session does not exist or has expired; please start again" }, 404);
    if (isCrossSiteForTarget(request, session)) return json({ error: CROSS_SITE_REJECTED }, 401);
    if (!request.body) return json({ error: "The request has no body" }, 400);

    // Content-Length is only a pre-check, used to reject the obviously oversized before writing; the
    // real byte count is whatever actually streams through (clients can lie, or omit it entirely).
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 0) assertSessionRoom(session, declared);

    const target = relpath.join("/");
    const written = await getStorage().writeStreamToVersion(session.siteId, session.versionId, target, request.body);
    // After streaming, re-check the total against the real byte count (a lying Content-Length is caught here)
    assertSessionRoom({ ...session, files: session.files.filter((f) => f.relpath !== target) }, written);
    await recordUploadedFile(session, target, written);
    return json({ relpath: target, bytes: written });
  } catch (error) {
    return errorResponse(error);
  }
}
