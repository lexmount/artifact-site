// GET /api/sites/:slug/admin-activity — what administrators have done to THIS site, for its owner.
//
// The other half of "staff can access your data": the administration log records every take-down,
// restore, delete and every reading of non-public content; this hands the owner their site's slice
// of it. Dates, actions and the reason an administrator wrote — not the administrator's identity,
// which stays in the console (an owner needs to know that it happened and why, not who to chase).
import type { NextResponse } from "next/server";
import { requireCapability } from "@/lib/authz";
import { listAdminLog } from "@/lib/db";
import { checkRateLimit } from "@/lib/ratelimit";
import { getSiteBySlug } from "@/lib/db";
import { errorResponse, json } from "../../../_util";

const LIMIT = 200;

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    // getSiteBySlug rather than getSiteView, and no deleted_at check: a taken-down or deleted site
    // is exactly when the owner wants this (the `site.delete` row and its reason live here). The
    // row is theirs until it is purged; the capability gate below still decides who may ask.
    const site = await getSiteBySlug(slug);
    if (!site) return json({ error: "site not found" }, 404);
    await requireCapability(request, site, "owner");
    // One more than the page so the response can say whether older rows exist.
    const rows = await listAdminLog({ targetId: site.id, limit: LIMIT + 1 });
    const entries = rows.slice(0, LIMIT).map((e) => ({ id: e.id, action: e.action, at: e.createdAt, reason: e.reason }));
    return json({ entries, truncated: rows.length > LIMIT, limit: LIMIT });
  } catch (error) {
    return errorResponse(error);
  }
}
