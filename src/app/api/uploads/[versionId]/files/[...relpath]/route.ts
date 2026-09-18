import { createHash } from "node:crypto";
import { requirePermission } from "@/lib/authz";
import { getSiteView } from "@/lib/sites";
import { assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { creationTenant } from "@/lib/rbac-access";
// PUT /api/uploads/<versionId>/files/<relpath> — **stream** one file into the version.
//
// The request body is the file's raw bytes, not multipart: multipart has to be parsed into FormData
// before its content is reachable, and that step reads the whole file into memory — exactly what
// this route exists to avoid. One file per request also makes each request exactly as large as that
// file, which naturally keeps it within the gateway's per-request limit.
import type { NextResponse } from "next/server";
import { checkUploadRateLimit } from "@/lib/ratelimit";
import { getStorage, safeRelativePath } from "@/lib/storage";
import { beginUploadedFile, assertSessionRoom, getUploadSession, ownerKeyFor, recordUploadedFile } from "@/lib/upload-session";
import { CROSS_SITE_REJECTED, isCrossSiteForTarget } from "@/lib/upload-csrf";
import { errorResponse, json } from "../../../../_util";

export async function PUT(request: Request, context: { params: Promise<{ versionId: string; relpath: string[] }> }): Promise<NextResponse> {
  try {
    checkUploadRateLimit(request);
    const { versionId, relpath } = await context.params;
    // An identity mismatch is treated as "no such session" — do not reveal to an outsider holding the versionId that it exists.
    const session = await getUploadSession(versionId, await ownerKeyFor(request));
    if (!session) return json({ error: "The upload session does not exist or has expired; please start again" }, 404);
    if (await isCrossSiteForTarget(request, session)) return json({ error: CROSS_SITE_REJECTED }, 401);
    await assertPresentedBearerAlive(request, await resolveSession(request));
    if (session.targetSlug) {
      const view = await getSiteView(session.targetSlug);
      if (!view) return json({ error: "site not found" }, 404);
      await requirePermission(request, view.site, "site.content.edit", undefined, false);
    } else {
      await assertCanCreate(request);
      await creationTenant((await resolveSession(request))?.userId ?? null, session.tenantId);
    }
    if (!request.body) return json({ error: "The request has no body" }, 400);

    // Content-Length is only a pre-check, used to reject the obviously oversized before writing; the
    // real byte count is whatever actually streams through (clients can lie, or omit it entirely).
    const target = safeRelativePath(relpath.join("/"));
    const remaining = { ...session, files: session.files.filter(f => f.relpath !== target) };
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 0) assertSessionRoom(remaining, declared);

    await beginUploadedFile(session, target);
    const hash = createHash("sha256");
    const counted = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(bytes, controller) { hash.update(bytes); controller.enqueue(bytes); } }));
    const written = await getStorage().writeStreamToVersion(session.siteId, session.versionId, target, counted);
    // Record the real byte count and check aggregate limits against the snapshot committed by CAS.
    await recordUploadedFile(session, target, written, hash.digest("hex"));
    return json({ relpath: target, bytes: written });
  } catch (error) {
    return errorResponse(error);
  }
}
