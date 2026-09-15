import "server-only";
import { getVersion } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { canReadSite, canReadVersion, requestShareAccess } from "@/lib/share";
import { resolveSession } from "@/lib/session";
/** Resolve a fixed share before choosing bytes; never silently substitute the current version. */
// Routes that record a more specific event (such as export) can disable the read audit.
// Authorization and fixed-version selection are unchanged.
export async function getReadableView(request: Request, slug: string, { audit = true }: { audit?: boolean } = {}) {
    const view = await getSiteView(slug);
    if (!view)
        return null;
    const session = await resolveSession(request);
    if (!await canReadSite(request, view.site, session, audit))
        return { ...view, readable: false };
    const share = await requestShareAccess(request, view.site, session);
    const params = new URL(request.url).searchParams;
    const versionId = params.get("version_id") ?? share?.versionId ?? view.version.id;
    if (!await canReadVersion(request, view.site, versionId, session))
        return null;
    const version = versionId === view.version.id ? view.version : await getVersion(versionId);
    return version && version.siteId === view.site.id ? { site: view.site, version, readable: true } : null;
}
