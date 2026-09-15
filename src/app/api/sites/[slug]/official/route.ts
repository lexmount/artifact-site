import { getUser } from "@/lib/db";
import { checkRateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import { canReadSite, readableVersionFilter } from "@/lib/share";
import { describePermissions } from "@/lib/authz";
import { listVersions, getSiteView } from "@/lib/sites";
import { requirePermission } from "@/lib/authz";
import { assertMutationOrigin } from "@/lib/request-auth";
import { apiAuditContext } from "@/lib/audit";
import { setOfficialVersion } from "@/lib/official-version";
import { errorResponse, json } from "../../../_util";

const schema = z.object({ versionId: z.string().min(1).optional(), expectedRevision: z.number().int().nonnegative().optional() });
async function change(request: Request, context: { params: Promise<{ slug: string }> }, clear: boolean) {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await assertMutationOrigin(request, view.site);
    const { actor } = await requirePermission(request, view.site, "site.version.official.manage");
    const text = await request.text();
    const body = schema.parse(text ? JSON.parse(text) : {});
    if (!clear && !body.versionId) return json({ error: "versionId is required" }, 400);
    const result = await setOfficialVersion(view.site.id, clear ? null : body.versionId!, apiAuditContext(request, actor), body.expectedRevision);
    return json({ slug, currentVersionId: result.currentVersionId, officialVersionId: result.officialVersionId, officialRevision: result.officialRevision, officialSetAt: result.officialSetAt, previousOfficialVersionId: result.previousOfficialVersionId });
  } catch (e) { return errorResponse(e); }
}
export const PUT = (request: Request, context: { params: Promise<{ slug: string }> }) => change(request, context, false);
export const DELETE = (request: Request, context: { params: Promise<{ slug: string }> }) => change(request, context, true);

/** Only disclose versions the credential can actually read; never return anonymous owner IDs. */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view || !(await canReadSite(request, view.site))) return json({ error: "site not found" }, 404);
    const all = await listVersions(slug) ?? [];
    const allows = await readableVersionFilter(request, view.site);
    const readable = all.filter(v => allows(v.id)).map(v => ({ id: v.id, number: v.number, current: v.current, official: v.official }));
    const permissions = await describePermissions(request, view.site);
    const setter = permissions.canManageSharing && view.site.officialSetBy ? await getUser(view.site.officialSetBy) : null;
    return json({ officialSetByName: permissions.canManageSharing ? setter?.displayName ?? null : undefined, versions: readable, officialVersionId: readable.find(v => v.official)?.id ?? null,
      currentVersionId: readable.find(v => v.current)?.id ?? null,
      officialRevision: permissions.canManageSharing ? view.site.officialRevision : undefined,
      officialSetAt: readable.some(v => v.official) ? view.site.officialSetAt : null,
      canManage: permissions.canManageSharing });
  } catch (e) { return errorResponse(e); }
}
