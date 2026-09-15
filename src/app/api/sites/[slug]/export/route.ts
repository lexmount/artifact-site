import { canReadVersion } from "@/lib/share";
// GET /api/sites/:slug/export — the CURRENT version's whole tree as one zip.
//
// The read half of the re-edit loop: an agent (the embedded assistant, or any tool holding the
// user's publish token) pulls the source here, edits in its own sandbox, and posts the tree back
// to POST /versions with `expected_version` set to this response's `x-artifact-version` header —
// export and lock base come from one snapshot. Capability "content": everyone who may edit may
// pull the source; a mere reader may not (previews already serve them the rendered files, but a
// one-request bundle of the raw tree is an editor's tool).
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/authz";
import { checkRateLimit } from "@/lib/ratelimit";
import { exportSiteZip, getSiteView } from "@/lib/sites";
import { errorResponse, json } from "../../../_util";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requireCapability(request, view.site, "content");
    const requestedVersion = new URL(request.url).searchParams.get("version") || new URL(request.url).searchParams.get("v") || view.site.currentVersionId;
    if(!(await canReadVersion(request,view.site,requestedVersion))) return json({error:"version not accessible"},404);

    const exported = await exportSiteZip(slug, requestedVersion);
    if (!exported) return json({ error: "site not found" }, 404);
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
