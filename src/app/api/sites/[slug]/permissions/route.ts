import { describePermissions, resolveAuthority, resolveViewer } from "@/lib/authz";
import { getSiteView } from "@/lib/sites";
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
        const view = await getSiteView(slug);
        if (!view || !await canReadSite(request, view.site))
            return json({ error: "site not found" }, 404);
        return json({ permissions: await describePermissions(request, view.site) });
    }
    catch (e) {
        return errorResponse(e);
    }
}
/** Exchange an anonymous management receipt for a server-readable cookie, never an ownership claim. */
export async function POST(request: Request, context: Context) {
    try {
        const { slug } = await context.params;
        const view = await getSiteView(slug);
        if (!view)
            return json({ error: "site not found" }, 404);
        await assertMutationOrigin(request, view.site);
        const session = await resolveSession(request);
        const viewer = resolveViewer(request, session);
        const authority = await resolveAuthority(viewer, view.site);
        if (!await canReadSite(request, view.site, session))
            return json({ error: "site not found" }, 404);
        const response = json({ permissions: await describePermissions(request, view.site, session) });
        if (authority.source === "anonymous-token")
            response.headers.append("set-cookie", anonymousEditCookie(request, slug, viewer.editToken));
        return response;
    }
    catch (e) {
        return errorResponse(e);
    }
}
