// /api/me/folders — the signed-in user's folder shelf (issue #35).
//   GET  → { folders, assign }   the whole shelf, same shape the browser-local one has
//   POST → { folder }            create; body { name }
import type { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { csrfSafe, resolveSession } from "@/lib/session";
import { createUserFolder, getFolderState } from "@/lib/user-folders";
import { errorResponse, json } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    return json(await getFolderState(session.userId), 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const folder = await createUserFolder(session.userId, typeof body.name === "string" ? body.name : "");
    return json({ folder }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
