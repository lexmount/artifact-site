// /api/me/folders/:id — rename (PATCH { name }) or delete (DELETE) one of the user's folders.
// Deleting un-files its members; it never touches a site.
import type { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { csrfSafe, resolveSession } from "@/lib/session";
import { deleteUserFolder, renameUserFolder } from "@/lib/user-folders";
import { errorResponse, json } from "../../../_util";

async function authed(request: Request): Promise<string> {
  checkRateLimit(request);
  if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
  const session = await resolveSession(request);
  if (!session) throw new AuthError("Please sign in first");
  return session.userId;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const userId = await authed(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    await renameUserFolder(userId, id, typeof body.name === "string" ? body.name : "");
    return json({ ok: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const userId = await authed(request);
    const { id } = await context.params;
    await deleteUserFolder(userId, id);
    return json({ deleted: true, id }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
