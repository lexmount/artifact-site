// DELETE /api/me/connections/:id — disconnect one application: every token of the grant is revoked,
// and the next request the application makes is refused (resolveSession refuses revoked tokens).
// Owner-scoped in the query itself, so a grant id is not a handle on somebody else's connection.
import type { NextResponse } from "next/server";
import { revokeOauthGrant } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { isTokenSession } from "@/lib/publish-token";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../../_util";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (isTokenSession(session)) throw new AuthError("A token cannot disconnect applications");
    const { id } = await context.params;
    const revoked = await revokeOauthGrant(id, Date.now(), session.userId);
    if (revoked === 0) return json({ error: "The connection does not exist or is already disconnected" }, 404);
    return json({ ok: true, revoked }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
