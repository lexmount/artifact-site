// GET /api/me/connections — the applications connected to this account through OAuth (lib/oauth):
// one row per live grant, for the account page. Browser-session-only, like the token list: a
// token must not be able to enumerate its siblings.
import type { NextResponse } from "next/server";
import { listOauthConnections } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { isTokenSession } from "@/lib/publish-token";
import { resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../_util";

/** The host a metadata-document client lives at — the one fact about a client that cannot be made up. */
function clientHost(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    if (isTokenSession(session)) throw new AuthError("A token cannot list connections");
    const connections = await listOauthConnections(session.userId);
    return json({
      connections: connections.map((c) => ({
        id: c.id, clientId: c.clientId, clientName: c.clientName, clientHost: clientHost(c.clientId),
        scope: c.scope, connectedAt: c.connectedAt, lastUsedAt: c.lastUsedAt,
      })),
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
