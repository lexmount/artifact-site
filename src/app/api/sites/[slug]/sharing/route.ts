import { z } from "zod";
import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// Site visibility is independent of role grants and share-link access.
import type { NextResponse } from "next/server";
import { getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/authz";
import { errorResponse, json } from "../../../_util";

const sharingSchema = z.object({ visibility: z.enum(["public", "unlisted", "private"]) }).strict();

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requirePermission(request, view.site, "site.sharing.manage");
    return json({ siteId: view.site.id, visibility: view.site.visibility }, 200);
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

    const { visibility } = sharingSchema.parse(await request.json());

    await withPermissionCommit(request,view.site.id,"site.sharing.manage", q => q("UPDATE sites SET visibility=$1,updated_at=$2 WHERE id=$3",[visibility,Date.now(),view.site.id]));
    await recordSiteAudit(view.site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic
    return json({ visibility }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
