// DELETE /api/me/tokens/:id — revoke one publish token. Takes effect on the next request that
// presents it (resolveSession refuses revoked tokens). Owner-scoped in the query itself.
import type { NextResponse } from "next/server";
import { revokePublishToken } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { isSameOrigin, resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../../_util";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    if (!isSameOrigin(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (session.id.startsWith("pt:")) throw new AuthError("A publish token cannot manage tokens");
    const { id } = await context.params;
    const ok = await revokePublishToken(id, session.userId);
    if (!ok) return json({ error: "The token does not exist or has been revoked" }, 404);
    return json({ ok: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
