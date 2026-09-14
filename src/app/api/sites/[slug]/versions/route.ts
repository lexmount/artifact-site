// /api/sites/:slug/versions
//   GET   the version timeline (newest first, each flagged current). Read-only, open.
//   POST  whole-thing re-upload → a new immutable version becomes current.
//         · document sites: re-upload the file (wrapper regenerated, office re-converted).
//         · html sites (single/folder): re-upload the whole tree — the write-back half of the
//           re-edit loop; `?expected_version=<id>` makes it an optimistic-locked commit that
//           answers 409 instead of burying a concurrent save.
//         Same wire format as creating; same authz shape as the edit route: capability
//         "content", CSRF only for ambient (cookie) credentials.
import type { NextResponse } from "next/server";
import { ensureAnonId } from "@/lib/anon";
import { AuthError } from "@/lib/auth";
import { requireActor } from "@/lib/authz";
import { checkRateLimit } from "@/lib/ratelimit";
import { csrfSafe } from "@/lib/session";
import { canReadSite } from "@/lib/share";
import { getSiteView, listVersions, replaceDocument, replaceSiteContent, siteUrl } from "@/lib/sites";
import { auditRequestMeta, type AuditContext } from "@/lib/audit";
import { errorResponse, json, parseExpectedVersion, parseUploadInput, versionConflictResponse } from "../../../_util";

/**
 * Version history is publicly readable — but that sentence only holds under the premise that "the
 * site itself is readable".
 *
 * For a private site both `/s/` and `/api/preview` answer 404 and reveal not even its existence; this
 * endpoint used to answer anyone outright, so holding a slug was enough to confirm that a private
 * site existed, how many versions it had, how big it was and when it was uploaded (siteId and
 * versionId were handed out too). With one exit of the same site locked tight and another standing
 * open, the locked one guards nothing.
 *
 * So the decision follows the same `canReadSite` as `/s/`, and the answer is likewise 404 rather
 * than 403 — to someone who should not know, "no access" is already a piece of information.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view || !(await canReadSite(request, view.site))) return json({ error: "site not found" }, 404);
    const versions = await listVersions(slug);
    if (!versions) return json({ error: "site not found" }, 404);
    const currentVersionId = versions.find((v) => v.current)?.id ?? null;
    return json({ versions, currentVersionId });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);

    const { anonId, cookie } = ensureAnonId(request);
    const { actor, viewer } = await requireActor(request, view.site, "content"); // same bar as editing
    // CSRF only for ambient credentials — token/Bearer callers set headers deliberately (an
    // attacker's page cannot), and demanding same-origin would 401 every non-browser client.
    const ambientlyAuthed = !viewer.editToken && !viewer.isAdmin;
    if (ambientlyAuthed && !csrfSafe(request)) throw new AuthError("Cross-site request rejected");

    const input = await parseUploadInput(request);
    const ctx: AuditContext = {
      actor: { ...actor, anonId: actor.anonId ?? anonId },
      method: "api",
      ...auditRequestMeta(request),
    };

    const parsedExpected = parseExpectedVersion(request);
    if (parsedExpected.rejection) return parsedExpected.rejection;
    const result = view.site.kind === "document"
      ? await replaceDocument(slug, input, ctx, parsedExpected.value)
      : await replaceSiteContent(slug, input, ctx, parsedExpected.value);
    if (result && "conflict" in result) return versionConflictResponse(result.currentVersionId);
    if (!result) return json({ error: "site not found" }, 404);

    const res = json({
      slug: result.site.slug,
      url: siteUrl(result.site.slug),
      title: result.site.title,
      kind: result.site.kind,
      versionId: result.version.id,
    });
    if (cookie) res.headers.append("set-cookie", cookie);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
