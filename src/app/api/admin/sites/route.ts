// GET /api/admin/sites?q=&owner=<userId>&anonymous=1&state=live|taken_down|deleted&limit=&offset=
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { listSitesAdmin } from "@/lib/db";
import { errorResponse, json } from "../../_util";
import { adminSite } from "./_shape";

const query = z.object({
  q: z.string().trim().max(200).default(""),
  owner: z.string().trim().max(100).default(""),
  anonymous: z.enum(["1", "0", ""]).default(""),
  state: z.enum(["live", "taken_down", "deleted"]).default("live"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    await requireAdmin(request);
    const p = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { rows, total } = await listSitesAdmin({
      q: p.q, ownerId: p.owner || null, anonymousOnly: p.anonymous === "1", state: p.state, limit: p.limit, offset: p.offset,
    });
    return json({ sites: rows.map(adminSite), total, limit: p.limit, offset: p.offset });
  } catch (error) {
    return errorResponse(error);
  }
}
