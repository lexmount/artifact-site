import { createHash } from "node:crypto";
import { rbacQuery } from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { json, errorResponse } from "../../_util";

/** Count deliberate sharing, including expired/revoked links, but not automatic publish links. */
export async function GET(request: Request) {
  try {
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    const anonymous = session ? null : anonIdFromRequest(request);
    const owner = session?.userId ?? anonymous;
    const rows = owner ? await rbacQuery(
      `SELECT id FROM site_shares WHERE ${session ? "created_by" : "created_anon"}=$1 AND (source IS NULL OR source <> 'publish') LIMIT 3`, [owner],
    ) : [];
    // The anonymous cookie is an ownership credential; never expose it to browser JavaScript.
    const scope = session ? `user:${session.userId}` : anonymous ? `anon:${createHash("sha256").update(anonymous).digest("hex")}` : "anonymous";
    const response = json({ scope, linksCreated: rows.length });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) { return errorResponse(error); }
}
