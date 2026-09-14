// /api/sites/:slug/rollback — POST { versionId } → roll back. Forward-only restore: mints a NEW version
// whose tree copies the chosen earlier one and makes it current; history is never mutated. A
// versionId that is unknown or belongs to another site → 404 (same as an unknown slug).
//
// Same-origin gated when authorization came from ambient cookies: rollback swaps which version the
// public link serves, so a cross-site POST is silent vandalism. A hosted artifact can reach it as a
// SIMPLE request (nothing preflights it), which is exactly the case `csrfSafe` was written for —
// a sandbox without allow-same-origin sends `Origin: null`. An explicit edit token or Bearer is
// exempt: an attacker's page cannot set those headers, and requiring an Origin would break API
// clients. Mirrors the edit route.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireActor } from "@/lib/authz";
import { AuthError } from "@/lib/auth";
import { csrfSafe } from "@/lib/session";
import { checkRateLimit } from "@/lib/ratelimit";
import { getSiteView, rollbackTo, siteUrl } from "@/lib/sites";
import { apiAuditContext } from "@/lib/audit";
import { errorResponse, json } from "../../../_util";

const rollbackSchema = z.object({ versionId: z.string() });

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    // Same bucket as create / fork / edit: a rollback copies the whole chosen version tree, so it
    // amplifies disk and IO exactly like fork's cp -r does. `manage` is required below, so this is
    // hardening (a site's own owner can still stall the box by looping rollback), not a gate on an
    // open hole. Cheapest gate first: shed floods before the site lookup or any body parsing.
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site or version not found" }, 404);
    const { actor, viewer } = await requireActor(request, view.site, "manage"); // rollback rewrites which version is served
    if (!viewer.editToken && !viewer.isAdmin && !csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { versionId } = rollbackSchema.parse(await request.json());
    const result = await rollbackTo(slug, versionId, apiAuditContext(request, actor));
    if (!result) return json({ error: "site or version not found" }, 404);
    return json({
      slug: result.site.slug,
      url: siteUrl(result.site.slug),
      versionId: result.version.id,
      version: result.version,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
