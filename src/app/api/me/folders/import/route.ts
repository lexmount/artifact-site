// POST /api/me/folders/import — merge the browser-local shelf into the account, once, right after
// sign-in (the same moment /api/me/adopt settles site ownership). Body is the local FolderState
// as the browser stored it; the response is the merged account shelf plus what happened to each
// part, so the client can clear its local copy with confidence.
import type { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { parseFolders } from "@/lib/folders";
import { checkRateLimit } from "@/lib/ratelimit";
import { csrfSafe, resolveSession } from "@/lib/session";
import { importFolderState } from "@/lib/user-folders";
import { errorResponse, json } from "../../../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    // parseFolders is the same tolerant validator the browser uses on its own storage: unknown
    // fields dropped, dangling assignments dropped, the folder cap applied.
    const local = parseFolders(await request.text());
    const { state, report } = await importFolderState(session.userId, local);
    return json({ ...state, report }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
