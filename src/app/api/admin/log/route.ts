// GET /api/admin/log?target=<userId|siteId>&limit= — administrative acts, newest first.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, visibleAdminLog } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";

const query = z.object({ target: z.string().trim().max(100).default(""), limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    const actor = await requireAdmin(request);
    const p = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    return json({ entries: await visibleAdminLog(actor, { targetId: p.target || null, limit: p.limit }) });
  } catch (error) {
    return errorResponse(error);
  }
}
