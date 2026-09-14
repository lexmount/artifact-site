// Owner-level transfer and disown operations. Email administrators assign unowned sites
// through /api/admin/sites/:slug/owner; this route retains its same-origin requirement.
//
//   DELETE → disown  (owner_id back to NULL; the site returns to unowned state; reassignment requires an authorized caller)
//   POST   → transfer to another account, by verified email
import type { NextResponse } from "next/server";
import { clearSiteOwner, getUserByVerifiedEmail, transferSiteOwner } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { requireActor } from "@/lib/authz";
import { AuthError } from "@/lib/auth";
import { csrfSafe } from "@/lib/session";
import { errorResponse, json } from "../../../_util";

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor } = await requireActor(request, view.site, "owner");
    await clearSiteOwner(view.site.id);
    await recordSiteAudit(view.site.id, "disown", apiAuditContext(request, actor));
    return json({ ok: true, ownerId: null }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor } = await requireActor(request, view.site, "owner");

    const body = (await request.json()) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) return json({ error: "email is required" }, 400);

    const target = await getUserByVerifiedEmail(email);
    if (!target) return json({ error: "No user with this email has signed in here, or the email is unverified", code: "user_not_found" }, 404);

    await transferSiteOwner(view.site.id, target.id);
    await recordSiteAudit(view.site.id, "transfer", apiAuditContext(request, actor));
    return json({ ok: true, ownerId: target.id }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
