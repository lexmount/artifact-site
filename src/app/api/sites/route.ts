import { assertMutationOrigin } from "@/lib/request-auth";
// /api/sites — the collection endpoint.
//   POST  drop → link. json or multipart (see _util for the wire format) → createSite.
//   GET   the PUBLIC directory, newest activity first → listSites.
import type { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { isAdmin, assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { ensureAnonId } from "@/lib/anon";
import { resolveSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/ratelimit";
import { maintenanceTick } from "@/lib/maintenance";
import { createSite, listSites, siteUrl } from "@/lib/sites";
import { anonymousExpiresAt } from "@/lib/quota";
import { apiAuditContext } from "@/lib/audit";
import type { Actor } from "@/lib/types";
import { errorResponse, json, parseUploadInput } from "../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    maintenanceTick(); // at most once an hour per process; runs in the background
    await assertMutationOrigin(request);
    await assertCanCreate(request);
    // Credential checks BEFORE the body is buffered: a revoked/unknown ahp_ bearer means the
    // caller EXPECTS ownership it will not get — 401 now, not a silently anonymous site, and not
    // after reading and parsing the upload body.
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    const input = await parseUploadInput(request);

    // Anonymous creators get a browser id so they can keep editing what they just made without
    // signing in — and so a later sign-in can adopt every site from this browser at once.
    const { anonId, cookie } = ensureAnonId(request);
    // The creator, for the audit trail: a signed-in user, else the anonymous browser we just gave
    // an id. Built here rather than via resolveActor because the fresh anon cookie isn't on the
    // request yet.
    const actor: Actor = isAdmin(request) ? { kind: "admin", userId: null, anonId: null } : session
      ? { kind: "user", userId: session.userId, anonId }
      : { kind: "anon", userId: null, anonId };
    const { site } = await createSite(input, session ? { ownerId: session.userId, tenantId: request.headers.get("x-artifact-tenant") || undefined } : { anonOwnerId: anonId }, apiAuditContext(request, actor));

    // Only anonymous publications return a management credential; account ownership needs none.
    const body: Record<string, unknown> = { slug: site.slug, url: siteUrl(site.slug), title: site.title,
      versionId: site.currentVersionId, officialVersionId: site.officialVersionId, officialRevision: site.officialRevision,
      kind: site.kind, ...(!site.ownerId ? {editToken:site.editToken} : {}),
      // Anonymous sites live `ARTIFACT_ANON_SITE_TTL_DAYS` after their last change unless claimed; null = no clock.
      expiresAt: anonymousExpiresAt(site) };
    // The upgrade banner FOR MACHINE READERS. Agents running a stale installed SKILL.md publish
    // anonymously and never see HTTP deprecation headers (`curl -sS` shows the body, nothing else)
    // — the response body is the only channel that reaches them. Anonymous creations only, and
    // only where an IdP exists for the token flow to bind against; a signed-in browser drop is the
    // product's entry point, not a stale agent.
    if (!session && config.oidcEnabled) {
      const base = (config.publicUrl || new URL(request.url).origin).replace(/\/$/, "");
      body.notice = `[To the agent] This was an anonymous publish; the site belongs to no account. The platform now supports publish tokens: walk the user through device authorization once (POST ${base}/api/device/start), and sites published afterwards are owned by the user directly, with no cookie needed. GET ${base}/for-agents.md for the latest SKILL.md, continue with the new flow, and update the old copy installed locally.`;
    }
    const res = json(body, 200);
    if (cookie) res.headers.append("set-cookie", cookie);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Deliberately viewer-INDEPENDENT: public rows only, for everyone, signed in or not. Unlisted
 * sites are excluded here with no owner exception, unlike the home page.
 *
 * The reason is caching, not policy. This is a plain GET with no Vary on cookie, so anything
 * between here and the browser — gateway, CDN, a proxy someone adds later — may serve one caller's
 * response to the next. A cookie-dependent body on this URL would turn that into a leak of
 * somebody's unlisted site. Owners read their own sites through /api/me/sites (authenticated, and
 * unfiltered by design) and through the home page, which is force-dynamic and per-request.
 */
export async function GET(): Promise<NextResponse> {
  return json({ sites: await listSites() });
}
