// GET /api/search?q=<words>&limit=<n> — sites whose current text contains every word, most
// relevant first, with a passage around the first match. What a viewer can list they can search
// (owner, anonymous creator, collaborator, and public sites); a private site reachable only
// through a share link is deliberately NOT searchable — a link is for whoever holds it, and
// search would enumerate what the link was meant to guard. Reads with a Bearer or a cookie alike.
import type { NextResponse } from "next/server";
import { maintenanceTick } from "@/lib/maintenance";
import { checkRateLimit } from "@/lib/ratelimit";
import { BadRequestError } from "@/lib/errors";
import { searchSites } from "@/lib/search";
import { listViewerFromRequest } from "@/lib/sites";
import { errorResponse, json } from "../_util";

const MAX_QUERY_CHARS = 200;
const MAX_RESULTS = 50;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    maintenanceTick(); // the backfill behind search must not wait for someone to publish
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    if (!q) throw new BadRequestError("q is required");
    if (q.length > MAX_QUERY_CHARS) throw new BadRequestError(`q is too long (at most ${MAX_QUERY_CHARS} characters)`);
    const limitRaw = params.get("limit");
    const limit = limitRaw === null ? 10 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new BadRequestError(`limit must be an integer from 1 to ${MAX_RESULTS}`);
    const results = await searchSites(await listViewerFromRequest(request), q, limit);
    return json({ query: q, results });
  } catch (error) {
    return errorResponse(error);
  }
}
