import { permissionsForRole, resolveAuthority, resolveViewer } from "@/lib/authz";
import { getSiteBySlug } from "@/lib/db";
import { rolePermissions } from "@/lib/role-bindings";
import { resolveSession } from "@/lib/session";
import { canReadSite } from "@/lib/share";
import { assertMutationOrigin } from "@/lib/request-auth";
import { anonymousEditCookie } from "@/lib/anonymous-access";
import { errorResponse, json } from "../../../_util";
type Context = {
    params: Promise<{
        slug: string;
    }>;
};
export async function GET(request: Request, context: Context) {
    try {
        const { slug } = await context.params;
        const site = await getSiteBySlug(slug);
        if (!site || site.deletedAt || !site.currentVersionId) return json({error:"site not found"},404);
        const session=await resolveSession(request);
        const viewer=resolveViewer(request,session);
        const authority=await resolveAuthority(viewer,site);
        if(!await canReadSite(request,site,session,true,authority))return json({error:"site not found"},404);
        return json({permissions:permissionsForRole(viewer,site,await rolePermissions(authority.role))});
    }
    catch (e) {
        return errorResponse(e);
    }
}
/** Exchange an anonymous management receipt for a server-readable cookie, never an ownership claim. */
export async function POST(request: Request, context: Context) {
    try {
        const { slug } = await context.params;
        const site = await getSiteBySlug(slug);
        if (!site || site.deletedAt || !site.currentVersionId)
            return json({ error: "site not found" }, 404);
        await assertMutationOrigin(request, site);
        const session = await resolveSession(request);
        const viewer = resolveViewer(request, session);
        const authority = await resolveAuthority(viewer, site);
        if (!await canReadSite(request, site, session, true, authority))
            return json({ error: "site not found" }, 404);
        const response = json({ permissions: permissionsForRole(viewer, site, await rolePermissions(authority.role)) });
        if (authority.source === "anonymous-token")
            response.headers.append("set-cookie", anonymousEditCookie(request, slug, viewer.editToken));
        return response;
    }
    catch (e) {
        return errorResponse(e);
    }
}
