import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// The guest list of a `people` share. Owner-only, like everything else under /shares.
import type { NextResponse } from "next/server";
import { addShareGrant, getUser, getUserByVerifiedEmail, removeShareGrant } from "@/lib/db";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { resolveSession } from "@/lib/session";
import { errorResponse, json } from "../../../../../_util";
import { loadGrants, parseEmail, resolveOwnedShare, ShareInputError } from "../../_shared";

// Grant writes and revision changes use the RBAC transaction; audit is best-effort afterwards.
/**
 * Add someone. `{ userId }` names an account outright; `{ email }` is looked up first and stored as
 * an account when it resolves.
 *
 * AN UNMATCHED ADDRESS IS A SUCCESS, NOT A 404. That is the whole difference from
 * /collaborators, which refuses an address nobody has signed in with — a rule that quietly makes
 * "share this with Alice" impossible until Alice has independently discovered the platform and logged
 * in. Here the address is stored as-is and starts admitting them the moment they sign in with it
 * VERIFIED (see shareAdmits). The response says which of the two happened so the panel can tell the
 * owner "takes effect once they sign in" instead of leaving them wondering whether it took.
 *
 * The lookup is on VERIFIED addresses only, and so is the later match: an unverified address is
 * attacker-controllable, so accepting one would let anybody claim their way onto any guest list.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string; shareId: string }> },
): Promise<NextResponse> {
  try {
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;
    await assertMutationOrigin(request, site);

    const body = (await request.json().catch(() => ({}))) as { email?: unknown; userId?: unknown };
    const grantedBy = (await resolveSession(request))?.userId ?? null;

    if (typeof body.userId === "string" && body.userId.trim()) {
      const userId = body.userId.trim();
      // Verify the account exists rather than trusting an id off the wire: a typo would otherwise
      // become a permanent row on the guest list that can never admit anyone and can never be
      // recognised as junk.
      const user = await getUser(userId);
      if (!user) return json({ error: "User not found", code: "user_not_found" }, 404);
      await withPermissionCommit(request,site.id,"site.sharing.manage", async () => addShareGrant(share.id, { userId }, grantedBy));
      await recordSiteAudit(site.id, "share", apiAuditContext(request, actor));
      return json({
        status: "linked",
        grant: {
          userId,
          email: user.emailVerified ? user.email : null,
          displayName: user.displayName,
          pending: false,
        },
      }, 200);
    }

    if (body.email === undefined || body.email === null) throw new ShareInputError("email or userId is required");
    const email = parseEmail(body.email);
    const user = await getUserByVerifiedEmail(email);
    if (user) {
      // Store the ACCOUNT, not the address, once we know who it is: an account id survives the
      // person changing their e-mail, and it is what shareAdmits can match without a second lookup.
      await withPermissionCommit(request,site.id,"site.sharing.manage", async () => addShareGrant(share.id, { userId: user.id }, grantedBy));
      await recordSiteAudit(site.id, "share", apiAuditContext(request, actor));
      return json({
        status: "linked",
        grant: { userId: user.id, email: user.email, displayName: user.displayName, pending: false },
      }, 200);
    }

    await withPermissionCommit(request,site.id,"site.sharing.manage", async () => addShareGrant(share.id, { email }, grantedBy));
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor));
    return json({
      status: "pending",
      code: "pending_email",
      message: "No user with this email has signed in here yet; the grant takes effect once they sign in with it",
      grant: { userId: null, email, displayName: null, pending: true },
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Remove one entry: `?userId=` for an account, `?email=` for an address still waiting on a login. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string; shareId: string }> },
): Promise<NextResponse> {
  try {
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;
    await assertMutationOrigin(request, site);

    const params = new URL(request.url).searchParams;
    const userId = params.get("userId")?.trim() || "";
    const rawEmail = params.get("email")?.trim() || "";
    if (!userId && !rawEmail) return json({ error: "userId or email is required" }, 400);

    // Same canonicalisation as on the way in, so an address added as "A@B.com" can be removed by
    // typing it back in any case.
    const grants = await withPermissionCommit(request,site.id,"site.sharing.manage", async () => {
      await removeShareGrant(share.id, userId ? { userId } : { email: parseEmail(rawEmail) });
      return loadGrants(share.id);
    });
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor));
    return json({ ok: true, grants }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
