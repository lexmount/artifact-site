import { authorizePreview } from "@/lib/preview-access";
import { canReadVersion } from "@/lib/share";
// GET /api/sites/:slug/edit-frame — the site's page with the visual-editor script injected, for
// the editor to fetch into a srcDoc iframe.
//
// The editor script is injected only here, and requirePermission("site.content.edit") stands in front of it:
// a visitor without edit access gets 403 and not one byte of script. It MUST be fetched (credentials
// travel in headers) and never navigated to by an iframe `src` — an iframe navigation cannot set
// request headers, so in legacy mode the only option would be to put the owner-equivalent edit
// token into `?t=`, i.e. into the URL of a document that runs third-party JS.
//
// What the frame contains, which versions it may be based on, and when it is refused (document
// sites, foreign versions, non-HTML or empty entries, a script ahead of <head>) is decided by
// lib/edit-frame. Authorization runs before ANY of that, so a visitor without edit access can
// neither obtain the script nor use this endpoint to probe whether a version id exists.
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authz";
import { buildEditFrame } from "@/lib/edit-frame";
import { getSiteView } from "@/lib/sites";
import { errorResponse, json } from "../../../_util";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);

    await requirePermission(request, view.site, "site.content.edit");
    const requestedVersion = new URL(request.url).searchParams.get("version") || new URL(request.url).searchParams.get("v") || view.site.currentVersionId;
    if(!(await canReadVersion(request,view.site,requestedVersion))) return json({error:"version not accessible"},404); // no edit access → 403 (and no script)

    // Scope resources to the selected source tree, matching baseVersionId on save.
    const resourceUrl = new URL(request.url);
    resourceUrl.searchParams.set("v", requestedVersion);
    const resourceRequest = new Request(resourceUrl, request);
    const access = await authorizePreview(resourceRequest, view.site, null);
    if (!access) return json({ error: "version not accessible" }, 404);
    const frame = await buildEditFrame(view, slug, requestedVersion, access.key);
    if (!frame.ok) {
      const { status, ...body } = frame;
      return json(body.code ? { error: body.error, code: body.code } : { error: body.error }, status);
    }

    return new NextResponse(frame.body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Private + no-store: this is one authorized visitor's editing surface and must never be
        // cached by a shared proxy and handed to someone else.
        "cache-control": "private, no-store",
        // Only matters when someone navigates to this URL directly (the editor fetches it into
        // srcDoc, and a srcDoc document does not inherit response-header CSP — on that path the
        // egress limit is written into <meta> by withConnectSrcMeta).
        "content-security-policy": "sandbox allow-forms allow-modals allow-popups allow-scripts",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        // Hands the nonce to the parent page, which uses it to pair the save reply with this
        // editing session.
        "x-ah-editor-nonce": frame.nonce,
        // The marker numbering was computed from this version's source; if the parent page holds a
        // different version the offsets do not line up and the save must be refused, not forced.
        // With ?version= this is the requested version.
        "x-ah-editor-version": frame.versionId,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
