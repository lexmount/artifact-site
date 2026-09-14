// POST /api/uploads — open a chunked upload session.
//
// Each file then goes through PUT /api/uploads/<versionId>/files/<relpath> (streamed, never held in
// memory), and once everything is up, POST /api/uploads/<versionId>/commit turns it into a version.
//
// Why not keep the one-shot upload: that path reads the whole project into memory, projects with
// video easily run to hundreds of MB, and in practice that crashed the process (everyone got 503s
// meanwhile). Chunked, the server handles one buffer of one file at any given moment.
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import { createUploadSession, ownerKeyFor, sweepExpiredSessions } from "@/lib/upload-session";
import { getSiteView } from "@/lib/sites";
import { requireActor } from "@/lib/authz";
import { ensureAnonId } from "@/lib/anon";
import { assertCanCreate, assertPresentedBearerAlive, AuthError } from "@/lib/auth";
import { csrfSafe, resolveSession } from "@/lib/session";
import { errorResponse, json } from "../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    // Lazy cleanup: someone opening a new session means the system is in use, so collect the expired orphans while here. No timer needed.
    void sweepExpiredSessions().catch(() => {});

    // Same gate as /api/sites: a revoked publish token is refused right here, rather than letting an agent upload 300MB and then fail at commit.
    await assertPresentedBearerAlive(request, await resolveSession(request));
    const body = (await request.json().catch(() => ({}))) as { slug?: string; title?: string };
    // An anonymous user without a cookie gets one minted here and **written back on the response**:
    // every later PUT has to match the session by it; without the write-back the next request would be a different "person".
    const { anonId, cookie } = ensureAnonId(request);
    const ownerKey = await ownerKeyFor(request, anonId);
    if (!ownerKey) return json({ error: "Could not identify the caller" }, 400);

    let session;
    if (body.slug) {
      // Uploading a new version to an existing site needs the same tier of permission as /edit; creating a new site follows the deployment create policy.
      const view = await getSiteView(body.slug);
      if (!view) return json({ error: "site not found" }, 404);
      const { viewer } = await requireActor(request, view.site, "content");
      // Same CSRF rule as the one-shot /versions route: an Origin is demanded only when authorization
      // rode credentials the browser attached by itself. Opening a session for a NEW site stays
      // ungated, like POST /api/sites — it rides nobody's identity.
      const ambientlyAuthed = !viewer.editToken && !viewer.isAdmin;
      if (ambientlyAuthed && !csrfSafe(request)) throw new AuthError("Cross-site request rejected");
      session = await createUploadSession({ siteId: view.site.id, targetSlug: body.slug, title: body.title, ownerKey });
    } else {
      await assertCanCreate(request);
      session = await createUploadSession({ title: body.title, ownerKey });
    }
    const res = json({ versionId: session.versionId }, 201);
    if (cookie) res.headers.append("set-cookie", cookie);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
