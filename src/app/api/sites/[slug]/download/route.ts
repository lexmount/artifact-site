import { getStorage } from "@/lib/storage";
import { getVersion } from "@/lib/db";
import { versionStream } from "@/lib/package-processing";
import { PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { managementReason } from "@/lib/management-reason";
import { getReadableView } from "@/lib/read-view";
import { canReadVersion } from "@/lib/share";
// Authorized whole-package download: preserve original archive bytes when available;
// folder packages and legacy sites use the existing ZIP export representation.
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authz";
import { managementRole, recordRbacAudit } from "@/lib/rbac-access";
import { rbacQuery } from "@/lib/db";
import { checkRateLimit } from "@/lib/ratelimit";
import { exportSiteZip } from "@/lib/sites";
import { errorResponse, json } from "../../../_util";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    // Audit successful export preparation/link issuance below, rather than the read gate.
    const view = await getReadableView(request, slug, { audit: false });
    if (!view) return json({ error: "site not found" }, 404);
    const { viewer } = await requirePermission(request, view.site, "site.source.export", undefined, false);
    const session = viewer.session;
    const requestedVersion = new URL(request.url).searchParams.get("version") || new URL(request.url).searchParams.get("v") || view.version.id;
    if (!(await canReadVersion(request, view.site, requestedVersion, session))) return json({ error: "version not accessible" }, 404);

    const version = await getVersion(requestedVersion);
    if (version?.packageMeta?.archive) {
      const archive = version.packageMeta.archive;
      const contentType = archive.format === "zip" ? "application/zip" : archive.format === "rar" ? "application/vnd.rar" : archive.format === "tar" ? "application/x-tar" : archive.format === "tar.gz" ? "application/gzip" : "application/x-7z-compressed";
      const storage = getStorage("package");
      const direct = new URL(request.url).searchParams.get("delivery") === "direct" && storage.downloadUrl;
      const url = direct ? await direct.call(storage, view.site.id, version.id, PACKAGE_ORIGINAL, archive.name, contentType) : undefined;
      const reason = managementReason(request);
      if (reason && await managementRole(request, view.site, session)) await recordRbacAudit(rbacQuery, view.site.tenantId, session?.userId ?? null, "site.source.export", view.site.id, reason);
      if (url) return NextResponse.json({ url, expiresIn: 300 }, { headers: { "cache-control": "private, no-store", "x-artifact-version": version.id } });
      return new NextResponse(versionStream(view.site.id, version.id, PACKAGE_ORIGINAL, archive.size), { headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archive.name)}`,
        "content-length": String(archive.size), "x-artifact-version": version.id, "cache-control": "private, no-store",
      } });
    }
    const storage = getStorage("package");
    if (version && new URL(request.url).searchParams.get("delivery") === "direct" && storage.exportDownloadUrl) {
      const url = await storage.exportDownloadUrl(view.site.id, version.id, `${view.site.slug}-${version.id}.zip`, async () => {
        const exported = await exportSiteZip(slug, version.id);
        if (!exported) throw new Error("Export version is no longer available");
        return exported.bytes;
      });
      const reason = managementReason(request);
      if (reason && await managementRole(request, view.site, session)) await recordRbacAudit(rbacQuery, view.site.tenantId, session?.userId ?? null, "site.source.export", view.site.id, reason);
      return NextResponse.json({ url, expiresIn: 300 }, { headers: { "cache-control": "private, no-store", "x-artifact-version": version.id } });
    }
    const exported = await exportSiteZip(slug, requestedVersion);
    if (!exported) return json({ error: "site not found" }, 404);
    // managementRole already validates the reason. Narrow it locally as well so the
    // audit write does not rely on a non-null assertion across that function boundary.
    const reason = managementReason(request);
    if (reason && await managementRole(request, view.site, session)) {
      await recordRbacAudit(rbacQuery, view.site.tenantId, session?.userId ?? null,
        "site.source.export", view.site.id, reason);
    }
    return new NextResponse(Buffer.from(exported.bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        // The optimistic-lock base for the write-back — echo it as ?expected_version= on POST /versions.
        "x-artifact-version": exported.versionId,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
