// PUT /api/me/folders/assignments — file a site: { slug, folderId } (folderId null = Unfiled).
// Only sites the user owns or collaborates on can be filed; anything else is a 404, not a store.
import type { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { csrfSafe, resolveSession } from "@/lib/session";
import { assignUserSite, FolderError } from "@/lib/user-folders";
import { errorResponse, json } from "../../../_util";

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    const body = (await request.json().catch(() => ({}))) as { slug?: unknown; folderId?: unknown };
    if (typeof body.slug !== "string" || !body.slug) throw new FolderError("slug is required");
    if (body.folderId !== null && typeof body.folderId !== "string") throw new FolderError("folderId must be a folder id or null");
    await assignUserSite(session.userId, body.slug, body.folderId);
    return json({ ok: true, slug: body.slug, folderId: body.folderId }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
