import { managementReason } from "@/lib/management-reason";
import { getReadableView } from "@/lib/read-view";
import { canReadVersion } from "@/lib/share";
// GET /api/sites/:slug/export — the requested (default current) version as a zip.
//
// The read half of the re-edit loop: an agent (the embedded assistant, or any tool holding the
// user's publish token) pulls the source here, edits in its own sandbox, and posts the tree back
// to POST /versions with `expected_version` set to this response's `x-artifact-version` header —
// export and lock base come from one snapshot. Capability "content": everyone who may edit may
// pull the source; a mere reader may not (previews already serve them the rendered files, but a
// one-request bundle of the raw tree is an editor's tool).
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
    // The completed export below is the audit event for this request, not its read gate.
    const view = await getReadableView(request, slug, { audit: false });
    if (!view) return json({ error: "site not found" }, 404);
    const { viewer } = await requirePermission(request, view.site, "site.source.export", undefined, false);
    const session = viewer.session;
    const requestedVersion = new URL(request.url).searchParams.get("version") || new URL(request.url).searchParams.get("v") || view.version.id;
    if (!(await canReadVersion(request, view.site, requestedVersion, session))) return json({ error: "version not accessible" }, 404);

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
