// Named collaborators — the "specific people may edit" tier. Owner-only for the same reason as
// sharing settings, and more sharply: if an edit-tier caller could add themselves here, revoking
// the open tier afterwards would not remove them. A coarse, revocable share would have become a
// permanent ACL entry, and their capability would rise from content to manage in the process.
import type { NextResponse } from "next/server";
import { addCollaborator, getUser, getUserByVerifiedEmail, listCollaborators, removeCollaborator } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { requireCapability } from "@/lib/authz";
import { csrfSafe, resolveSession } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { errorResponse, json } from "../../../_util";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requireCapability(request, view.site, "owner");

    const rows = await listCollaborators(view.site.id);
    const people = await Promise.all(rows.map(async (row) => {
      const user = await getUser(row.userId);
      return { userId: row.userId, email: user?.email ?? null, displayName: user?.displayName ?? null, grantedAt: row.grantedAt };
    }));
    return json({ collaborators: people }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requireCapability(request, view.site, "owner");

    const body = (await request.json()) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) return json({ error: "email is required" }, 400);

    // Verified addresses only: matching an unverified one would let someone register a victim's
    // mailbox and collect grants meant for them. `role` is never read from the request.
    const user = await getUserByVerifiedEmail(email);
    if (!user) return json({ error: "No user with this email has signed in here, or the email is unverified", code: "user_not_found" }, 404);

    const session = await resolveSession(request);
    await addCollaborator(view.site.id, user.id, session?.userId ?? null);
    return json({ userId: user.id, email: user.email, displayName: user.displayName }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requireCapability(request, view.site, "owner");

    const userId = new URL(request.url).searchParams.get("userId") ?? "";
    if (!userId) return json({ error: "userId is required" }, 400);
    await removeCollaborator(view.site.id, userId);
    return json({ ok: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
