// GET /api/users/search?q= — the people picker behind "Add people" on a `people` share.
//
// Scope is the point: it searches ACCOUNTS THAT HAVE SIGNED IN HERE and nothing else. The users
// table is written only by upsertUser at login, so there is no directory of strangers to expose —
// the owner is picking from people the deployment already knows, and anyone else is invited by
// e-mail through the grants route instead.
import type { NextResponse } from "next/server";
import { searchUsers } from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../../_util";

/**
 * Two characters minimum. A single letter would return a slice of the whole staff list to anyone
 * signed in, which is a directory dump in twenty-six requests rather than a search.
 */
const MIN_QUERY_LENGTH = 2;
/** A picker, not a report. Ten is what a dropdown can show without becoming a browsing surface. */
const MAX_RESULTS = 10;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    // Sign-in required — an unauthenticated caller has no business enumerating colleagues, and this
    // is a read that no share link should be able to reach.
    //
    // Deliberately NOT rate-limited: this is meant to back a type-ahead, and the shared per-IP
    // bucket (burst 20) would start answering 429 in the middle of someone typing a name. What
    // bounds it instead is the shape of the query — signed in, prefix-only, two characters minimum,
    // ten rows out.
    if (!(await resolveSession(request))) throw new AuthError("Please sign in first");

    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (q.length < MIN_QUERY_LENGTH) return json({ error: `The search term must be at least ${MIN_QUERY_LENGTH} characters`, users: [] }, 400);

    const rows = await searchUsers(q, MAX_RESULTS);
    // Three fields, and no more. The row also carries the provider subject, the avatar, timestamps
    // and the verified flag — none of which a picker needs, and the join key to the IdP is not
    // something to hand to every signed-in user for the sake of a dropdown.
    return json({
      users: rows.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        // Only a verified address identifies anyone (see searchUsers): showing an unverified one
        // would let an account wear a colleague's address in the very list used to grant access.
        email: user.emailVerified ? user.email : null,
      })),
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
