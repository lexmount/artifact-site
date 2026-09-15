// GET /api/me/tokens — the signed-in user's publish tokens, for the personal centre.
// Browser-only like /device/approve: a token must not enumerate its siblings.
import { checkRateLimit } from "@/lib/ratelimit";
import { createPublishTokenSecret, hashTokenSecret, isTokenSession } from "@/lib/publish-token";
import type { NextResponse } from "next/server";
import { insertPublishToken, listPublishTokens } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { readBodyWithinUploadLimit, errorResponse, json } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (isTokenSession(session)) throw new AuthError("A publish token cannot manage tokens");
    const tokens = await listPublishTokens(session.userId);
    return json({ tokens: tokens.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })) }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Mint a personal credential once, only from the owner's same-origin browser session. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session || isTokenSession(session)) throw new AuthError("Sign in in the browser to create a token");
    const body = await (await readBodyWithinUploadLimit(request, 4096)).json();
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return json({ error: "Name must be 1–80 characters" }, 400);
    if ((await listPublishTokens(session.userId)).length >= 100) return json({ error: "Revoke an unused token before creating another" }, 400);
    const token = createPublishTokenSecret(); const id = hashTokenSecret(token);
    await insertPublishToken({ id, userId: session.userId, name: body.name.trim(), createdAt: Date.now() });
    const response = json({ id, token }, 201);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) { return errorResponse(error); }
}
