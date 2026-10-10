import { z } from "zod";
import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// Site visibility is independent of role grants and share-link access.
import type { NextResponse } from "next/server";
import { siteUrl, getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { rbacQuery } from "@/lib/db";
import { requirePermission, describePermissions } from "@/lib/authz";
import { errorResponse, json } from "../../../_util";

const sharingSchema = z.object({ visibility: z.enum(["public", "unlisted", "private"]) }).strict();

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requirePermission(request, view.site, "site.sharing.manage");
    let summary = {};
    if (new URL(request.url).searchParams.get("summary") === "1") {
      const { canManageGrants } = await describePermissions(request, view.site);
      // Only a bounded preview of directly granted users; full grants remain on demand.
      const rows = canManageGrants ? await rbacQuery(
        `SELECT DISTINCT u.id,COALESCE(u.display_name,u.email) AS name FROM role_bindings b
         JOIN users u ON u.id=b.subject_user_id WHERE b.resource_site_id=$1 ORDER BY u.id LIMIT 4`,
        [view.site.id],
      ) : [];
      summary = { canManageMembers: canManageGrants, members: rows.slice(0, 3).map(row => ({ id: row.id, name: row.name })), moreMembers: rows.length > 3 };
    }
    const response = json({ siteId: view.site.id, mainAudience: (await (await import("@/lib/sharing-defaults")).getSiteSharing(view.site)).policy.audience, visibility: view.site.visibility, url: siteUrl(slug), ...summary }, 200);
    response.headers.set("cache-control", "private, no-store");
    return response;
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

    await withPermissionCommit(request,view.site.id,"site.sharing.manage", async (q, site) => {
      const { markSharingManual } = await import("@/lib/sharing-defaults");
      site = await markSharingManual(q, site);
      await q("UPDATE sites SET visibility=$1,updated_at=$2 WHERE id=$3", [visibility, Date.now(), site.id]);
      await markSharingManual(q, site, { audience: visibility === "unlisted" ? "anyone" : visibility });
    });
    await recordSiteAudit(view.site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic
    return json({ visibility, url: siteUrl(slug), independentLinksUnchanged: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
