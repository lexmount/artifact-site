import { archiveParts, assembleArchive } from "@/lib/mcp/files";
import { enqueuePackageJob, packageJobStatus, readablePackageJob } from "@/lib/package-jobs";
import type { PackageProgress } from "@/lib/package-processing";
import { localeFromRequest } from "@/lib/i18n-server";
import { packageLease, preparePackage } from "@/lib/package-processing";
import { PACKAGE_ENTRY } from "@/lib/package-contract";
import { withPublishOperation } from "@/lib/publish-operation";
// POST /api/uploads/<versionId>/commit — turn the uploaded files into a version.
//
// Legacy uploads select their entry and record the version. Explicit file packages also
// validate/extract content and generate a directory under a renewable processing lease.
//
// A version either exists in full or never existed: commit is the last step, an upload interrupted
// before it leaves only orphan bytes (collected by session-expiry cleanup), and the database never
// holds half a version.
import { z } from "zod";
import type { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import { resolveUploadTarget, resolveUploadTargetForSite, type UploadDocumentTarget } from "@/lib/upload";
import { completeUploadSession, discardUploadSession, getUploadSession, ownerKeyFor } from "@/lib/upload-session";
import { CROSS_SITE_REJECTED, isCrossSiteForTarget } from "@/lib/upload-csrf";
import { commitUploadedVersion, getSiteView } from "@/lib/sites";
import { apiAuditContext } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { isAdmin, assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import type { Actor } from "@/lib/types";
import { errorResponse, json, versionConflictResponse, parseExpectedVersion } from "@/lib/api-http";

export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }): Promise<NextResponse> {
  return withPublishOperation(request, r => executePost(r, context));
}

export async function executePost(request: Request, context: { params: Promise<{ versionId: string }> }, progress?: PackageProgress): Promise<NextResponse> {
  try {
    if (!progress) checkRateLimit(request);
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const { versionId } = await context.params;
    const owner = await ownerKeyFor(request);
    if (!progress) {
      const job = await packageJobStatus(versionId, owner);
      if (job) return json(await readablePackageJob(request, job), job.status === "completed" ? 200 : 202);
    }
    const session = await getUploadSession(versionId, owner);
    if (!session) return json({ error: "The upload session does not exist or has expired; please start again" }, 404);
    if (await isCrossSiteForTarget(request, session)) return json({ error: CROSS_SITE_REJECTED }, 401);
    if (!session.files.length && !session.packageOptions?.directories?.length && !await archiveParts(session)) return json({ error: "No files have been uploaded yet" }, 400);

    const expected = parseExpectedVersion(request);
    if (expected.rejection) return expected.rejection;
    const text = await request.text();
    const body = z.object({ title: z.string().optional(), official: z.boolean().optional() }).parse(text ? JSON.parse(text) : {});
    const relpaths = session.files.map((f) => f.relpath);
    // New site: a single PDF → document site; anything else has its entry detected as an HTML site.
    // Existing site: whatever the site is, the new version must still be (a document site only accepts a single PDF, a web site accepts no documents) — see resolveUploadTargetForSite.
    let target: { entry: string; document?: UploadDocumentTarget };
    if (session.targetSlug) {
      const view = await getSiteView(session.targetSlug);
      if (!view) return json({ error: "site not found" }, 404);
      await requirePermission(request, view.site, "site.content.edit");
      if (body.official) await requirePermission(request, view.site, "site.version.official.manage", undefined, false);
      if (session.packageOptions && view.site.kind !== "folder") return json({ error: "Packages can only replace folder artifacts" }, 400);
      target = session.packageOptions ? { entry: PACKAGE_ENTRY } : resolveUploadTargetForSite(view.site.kind, relpaths);
    } else {
      await assertCanCreate(request);
      target = session.packageOptions ? { entry: PACKAGE_ENTRY } : resolveUploadTarget(relpaths);
    }
    // The audit row uses the same terms as site creation via /api/sites: who (signed-in user / anonymous browser / token-holding agent) created it, and when.
    const who = await resolveSession(request);
    await assertPresentedBearerAlive(request, who);
    const anonId = anonIdFromRequest(request);
    const actor: Actor = isAdmin(request) ? { kind: "admin", userId: null, anonId: null } : who ? { kind: "user", userId: who.userId, anonId } : { kind: "anon", userId: null, anonId };
    if (session.packageOptions && new URL(request.url).searchParams.get("async") === "1" && !progress) return json(await enqueuePackageJob(request, session, body), 202);
    const commit = async () => {
    await assembleArchive(session, progress);
    const packageMeta = session.packageOptions ? await preparePackage(session, localeFromRequest(request), progress) : undefined;
    const result = await commitUploadedVersion(request, {
      packageMeta,
      official: body.official, session, entry: target.entry, document: target.document, expectedVersionId: expected.value,
      title: body.title ?? session.title ?? undefined, ctx: apiAuditContext(request, actor),
    });
    await completeUploadSession(versionId).catch(error => console.error("[upload] session cleanup", error));
    return json(result, 201);
    };
    return session.packageOptions ? await packageLease(session, commit) : await commit();
  } catch (error) {
    // If the commit fails (entry not found, wrong permissions), reclaim the bytes already uploaded — kept, they waste space and nobody claims them.
    const conflict = error as { statusCode?: number; currentVersionId?: string };
    if (conflict.statusCode === 409 && conflict.currentVersionId) return versionConflictResponse(conflict.currentVersionId);
    // Recovery-aware clients retain their draft; legacy calls keep their cleanup contract.
    if (!request.headers.has("idempotency-key") && !(await getUploadSession((await context.params).versionId, await ownerKeyFor(request)))?.packageOptions) {
      const { versionId } = await context.params;
      await discardUploadSession(versionId).catch(() => {});
    }
    return errorResponse(error);
  }
}
