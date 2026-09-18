import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// Sharing settings. Owner-only: a tier that may merely edit content must never be able to widen
// its own access, which is what letting `login` editors change edit_policy would amount to.
import type { NextResponse } from "next/server";
import { getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import type { EditPolicy, Visibility } from "@/lib/types";
import { errorResponse, json } from "../../../_util";

/**
 * `private` is back, and now it means something: lib/share.canReadSite gates all four content
 * outlets (/s/<slug>, GET /api/sites/<slug>, /api/preview/*, and fork — the last one copies the
 * whole version tree, so leaving it open would have made the other three theatre). PR#27 refused
 * this value precisely because none of that existed yet.
 */
const VISIBILITY: Visibility[] = ["public", "unlisted", "private"];


export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requirePermission(request, view.site, "site.sharing.manage");
    return json({ visibility: view.site.visibility, editPolicy: "owner" }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor } = await requirePermission(request, view.site, "site.sharing.manage");
    await assertMutationOrigin(request, view.site);

    const body = (await request.json()) as { visibility?: unknown; editPolicy?: unknown };
    const visibility = body.visibility as Visibility;
    const editPolicy: EditPolicy = "owner";
    if (!VISIBILITY.includes(visibility)) return json({ error: "Invalid visibility value" }, 400);
    if (body.editPolicy !== undefined && body.editPolicy !== "owner") return json({ error: "Editing is controlled by members and share permissions" }, 400);

    await withPermissionCommit(request,view.site.id,"site.sharing.manage", q => q("UPDATE sites SET visibility=$1,edit_policy=$2,updated_at=$3 WHERE id=$4",[visibility,editPolicy,Date.now(),view.site.id]));
    await recordSiteAudit(view.site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic
    return json({ visibility, editPolicy }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
