import { managedMainPasscode } from "@/lib/main-passcode";
import { resolveSession } from "@/lib/session";
import { z } from "zod";
import { getSiteBySlug, rbacQuery } from "@/lib/db";
import {
  getSiteSharing,
  siteSharingChange,
  activeSource,
} from "@/lib/sharing-defaults";
import { canSelectOrganization, sharingPolicySchema } from "@/lib/sharing-policy";
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
    const session = await resolveSession(request);
    const [organization] = await rbacQuery("SELECT t.name,u.tenant_id FROM tenants t LEFT JOIN users u ON u.id=$2 WHERE t.id=$1", [site.tenantId, session?.userId ?? null]);
    return json({
      ...(await getSiteSharing(site)),
      passcode: await managedMainPasscode(site.id),
      organization: { name: String(organization?.name ?? ""), canSelect: canSelectOrganization(organization?.tenant_id as string | undefined, site.tenantId) },
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
        action: z.enum(["custom", "follow", "stop", "reset-passcode"]),
        policy: sharingPolicySchema.optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(await request.json());
    const state = await siteSharingChange(request, site.id, input);
    await requirePermission(request, site, "site.sharing.manage");
    return json({ ...state, passcode: await managedMainPasscode(site.id) });
  } catch (e) {
    return errorResponse(e);
  }
}
