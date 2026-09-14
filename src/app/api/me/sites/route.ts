// GET /api/me/sites — the personal centre's data: what I own, and what I may edit.
import type { NextResponse } from "next/server";
import { listSitesByOwner, listSitesForCollaborator } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    const [owned, collaborating] = await Promise.all([
      listSitesByOwner(session.userId),
      listSitesForCollaborator(session.userId),
    ]);
    return json({ owned, collaborating }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
