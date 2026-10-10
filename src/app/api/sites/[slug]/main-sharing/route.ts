import { z } from "zod";
import { getSiteBySlug, rbacQuery } from "@/lib/db";
import {
  getSiteSharing,
  siteSharingChange,
  activeSource,
} from "@/lib/sharing-defaults";
import { sharingPolicySchema } from "@/lib/sharing-policy";
import { requirePermission, describePermissions } from "@/lib/authz";
import { errorResponse, privateJson as json } from "@/app/api/_util";
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const site = await getSiteBySlug((await context.params).slug);
    if (!site || site.deletedAt)
      return json({ error: "Document not found" }, 404);
    await requirePermission(request, site, "site.sharing.manage");
    const [links] = await rbacQuery(
      "SELECT COUNT(*) AS n FROM site_shares WHERE site_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)",
      [site.id, Date.now()],
    );
    const [members] = await rbacQuery(
      "SELECT COUNT(*) AS n FROM role_bindings WHERE resource_site_id=$1",
      [site.id],
    );
    return json({
      ...(await getSiteSharing(site)),
      follow: site.ownerId ? await activeSource(rbacQuery, site) : null,
      links: Number(links.n),
      members: Number(members.n),
      canStop: Boolean(
        (await describePermissions(request, site)).canManageAdmins,
      ),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(request: Request, context: Context) {
  try {
    const site = await getSiteBySlug((await context.params).slug);
    if (!site || site.deletedAt)
      return json({ error: "Document not found" }, 404);
    const input = z
      .object({
        action: z.enum(["custom", "follow", "stop"]),
        policy: sharingPolicySchema.optional(),
      })
      .strict()
      .parse(await request.json());
    return json(await siteSharingChange(request, site.id, input));
  } catch (e) {
    return errorResponse(e);
  }
}
