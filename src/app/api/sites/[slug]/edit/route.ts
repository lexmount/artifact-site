import { assertMutationOrigin } from "@/lib/request-auth";
// /api/sites/:slug/edit — POST an in-browser save → a new immutable version becomes current.
//   single site: { content }            replaces the whole entry document
//   folder site: { path, content }      copies the prior tree, overwrites/adds one file
// editSite enforces the shape against site.kind (throws → 400); unknown/deleted slug → 404.
//
// Every save is recorded in the audit trail, in the same transaction as the version, so a committed
// edit always has an attributable row — see lib/sites editSite. The actor is resolved server-side
// from the session/token, never trusted from the body; `method` is descriptive metadata only.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { checkRateLimit } from "@/lib/ratelimit";
import { canReadVersion } from "@/lib/share";
import { editSite, getSiteView, siteUrl } from "@/lib/sites";
import { auditRequestMeta, type AuditContext } from "@/lib/audit";
import { ensureAnonId } from "@/lib/anon";
import type { EditInput } from "@/lib/types";
import { readBodyWithinUploadLimit, errorResponse, json, parseExpectedVersion, versionConflictResponse } from "../../../_util";

const editSchema = z.object({
  content: z.string(),
  baseVersionId: z.string().min(1).optional(),
  path: z.string().optional(),
  // How the edit was made, for the audit trail. Default "source" — the only editor posting here
  // today. A lying client can only mislabel HOW it edited, never WHO: identity is server-resolved.
  method: z.enum(["source", "visual", "api"]).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);

    // Give an anonymous editor (e.g. a shared-link holder with no cookie yet) a persistent handle,
    // so the trail can name the same browser across edits and a later claim can join it to a user.
    const { anonId, cookie } = ensureAnonId(request);
    const { actor } = await requireActor(request, view.site, "content"); // content edits only

    // CSRF applies only to AMBIENT credentials — a cookie the browser attaches cross-site on its
    // own. When the edit is authorized by a per-site token or the admin Bearer, the caller had to
    // set that header deliberately (an attacker's page can't), so same-origin is not required and
    // demanding it would 401 every non-browser API client. Authorization ran first, so a request
    // with no credentials at all was already refused (403) and never reaches this check.
      await assertMutationOrigin(request, view.site);

    const { content, path, method, baseVersionId } = editSchema.parse(await (await readBodyWithinUploadLimit(request)).json());
    const edit: EditInput = path === undefined ? { content } : { path, content };
    const ctx: AuditContext = {
      authorizationRequest: request,
      actor: { ...actor, anonId: actor.anonId ?? anonId },
      method: method ?? "source",
      ...auditRequestMeta(request),
    };
    // Optimistic lock (optional). SINGLE-file sites are edited through this route, so an agent
    // told to base its edit on a versionId lands here — before this the parameter was accepted
    // and ignored, which let a concurrent save be buried while the caller believed it was safe.
    const expected = parseExpectedVersion(request);
    if (expected.rejection) return expected.rejection;

    if (baseVersionId && !expected.value) return json({ error: "expected_version is required with baseVersionId" }, 400);
    if (baseVersionId && !(await canReadVersion(request, view.site, baseVersionId))) return json({ error: "version not found" }, 404);
    const result = await editSite(slug, edit, ctx, expected.value, baseVersionId);
    if (!result) return json({ error: "site not found" }, 404);
    if ("conflict" in result) return versionConflictResponse(result.currentVersionId);

    const res = json({
      slug: result.site.slug,
      url: siteUrl(result.site.slug),
      title: result.site.title,
      kind: result.site.kind,
      versionId: result.version.id,
      version: result.version,
    });
    if (cookie) res.headers.append("set-cookie", cookie); // persist a freshly-minted anon handle
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
