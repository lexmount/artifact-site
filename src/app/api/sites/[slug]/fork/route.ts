// /api/sites/:slug/fork — POST "Save as new site". Duplicates the site's CURRENT version into a brand-new,
// independent site (new slug + new siteId, title = source + " (copy)", starting at v1). Editing either
// side afterwards never touches the other. Unknown/deleted slug → 404.
import type { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import { ensureAnonId } from "@/lib/anon";
import { resolveActor, resolveViewer } from "@/lib/authz";
import { AuthError, assertPresentedBearerAlive } from "@/lib/auth";
import { csrfSafe, resolveSession } from "@/lib/session";
import { forkSite, getSiteView, siteUrl } from "@/lib/sites";
import { apiAuditContext } from "@/lib/audit";
import { canForkSite } from "@/lib/share";
import { errorResponse, json } from "../../../_util";

// Fork is OPEN — anyone who can VIEW may duplicate a site (it never modifies the source). The new,
// independent site is owned by the forker: recorded ownership under enforcement, plus its OWN fresh
// edit token, returned here, for the legacy regime.
// Rate-limited: each fork is a full cp-r of the current version tree (disk amplification).
//
// Open to anyone who can view, but the COPY is attributed to whoever the request resolves to — so a
// cross-site POST mints sites under someone else's identity and burns their storage. A hosted
// artifact reaches this as a bodyless SIMPLE request (nothing preflights it) while riding the
// viewer's cookies, and being sandboxed without allow-same-origin it sends `Origin: null`.
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    // The read gate the whole feature stands on. Fork copies the source's entire version tree into
    // a site the FORKER owns, so leaving it open would hand anyone a private artifact's contents no
    // matter how tightly /s and /api/preview were shut. The comment in lib/sites.forkSite has said
    // so since PR#27; this is it being honoured.
    const forkView = await getSiteView(slug);
    if (forkView && !(await canForkSite(request, forkView.site))) {
      return json({ error: "site not found" }, 404);
    }
    const session = await resolveSession(request);
    // Same rule as create: a dead ahp_ bearer fails loudly instead of forking anonymously.
    await assertPresentedBearerAlive(request, session);
    const { anonId, cookie } = ensureAnonId(request);
    // Fork is open, so the actor is whoever the request resolves to (a user if signed in, else this
    // browser). The audit records who spun off the copy — the new site's provenance. The anon id is
    // spliced into the viewer BEFORE resolving the actor because a freshly minted cookie is not on
    // the request yet: reading it back afterwards would file a first-time anonymous forker under
    // `legacy-token`, the tier that deliberately names nobody, and would staple that same brand-new
    // browser id onto an admin actor resolveActor keeps anonymous on purpose.
    const viewer = { ...resolveViewer(request, session), anonId };
    const actor = resolveActor(viewer);
    // Only gate the case that is actually forgeable: the request RIDES an identity it never
    // presented deliberately — a session, or an anon cookie the browser attached by itself
    // (`cookie` is non-null only when we just minted a fresh id, i.e. the caller had none to ride).
    // A scripted fork carrying nothing, an edit token, or a Bearer is not a CSRF vector; demanding
    // an Origin from those would only break non-browser clients. Mirrors the edit route.
    const ridesAmbientIdentity = !viewer.editToken && !viewer.isAdmin && (!!session || cookie === null);
    if (ridesAmbientIdentity && !csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    // Ownership follows the caller's real identity, exactly as POST /api/sites decides it: the two
    // markers are exclusive, and `ownerId` is what authz.resolveCapability actually consults for a
    // signed-in caller. Hardcoding `anonOwnerId` here orphaned every fork a signed-in user made —
    // owned by nobody, so its own creator could not edit, rename or delete it.
    const owner = session ? { ownerId: session.userId, tenantId: request.headers.get("x-artifact-tenant") || undefined } : { anonOwnerId: anonId };
    const result = await forkSite(slug, owner, apiAuditContext(request, actor));
    if (!result) return json({ error: "site not found" }, 404);
    const res = json({
      slug: result.site.slug,
      url: siteUrl(result.site.slug),
      title: result.site.title,
      kind: result.site.kind,
      editToken: result.site.editToken,
      claimToken: result.site.claimToken,
    });
    if (cookie) res.headers.append("set-cookie", cookie);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
