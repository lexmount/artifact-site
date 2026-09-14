// One share link — retune it, or take it away. Owner-only, like the collection route.
import type { NextResponse } from "next/server";
import { revokeShare, setShareAllowAi, updateSharePolicy } from "@/lib/db";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { csrfSafe } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { createPasscode, hashPasscode } from "@/lib/share";
import { errorResponse, json } from "../../../../_util";
import { loadGrants, parseExpiry, parsePasscode, parsePolicy, resolveOwnedShare, summarize } from "../_shared";

/**
 * Change policy / expiry / passcode.
 *
 * updateSharePolicy writes all three in one statement, so every field the caller left out has to be
 * carried over from the stored row here — a PATCH that only touches the label must not blank the
 * passcode on its way past.
 *
 * Note that changing the passcode invalidates every entry cookie already handed out, for free: the
 * cookie's signature is derived from the passcode hash (see lib/share), so there is no second table
 * to sweep and no window where an old code still opens the door.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string; shareId: string }> },
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;

    // A revoked link cannot be brought back — nothing un-sets revoked_at, and it should stay that
    // way: "revoke" has to be final or it is not a revocation. Say so instead of accepting the edit
    // and leaving the owner to discover the link is still dead.
    if (share.revokedAt != null) return json({ error: "This share has been revoked and can no longer be changed; create a new link" }, 409);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const policy = parsePolicy(body.policy, share.policy);
    const expiry = parseExpiry(body.expiresInDays);
    const expiresAt = expiry === undefined ? share.expiresAt : expiry;
    const supplied = parsePasscode(body.passcode);
    if (supplied && policy !== "passcode") {
      return json({ error: "A passcode only applies to links with policy=passcode" }, 400);
    }

    // Switching AWAY from `passcode` drops the stored hash. Keeping it would leave a dead secret in
    // the row that quietly springs back to life if the policy is ever switched back — an owner who
    // set a code, moved the link to "Signed-in users", then returned to "Passcode" would be handing out a code
    // they no longer remember choosing.
    let passcode: string | undefined;
    let passcodeHash: string | null = null;
    if (policy === "passcode") {
      if (supplied) passcode = supplied;
      // A share that arrives at `passcode` with no code stored is unopenable by anyone
      // (resolveShareAccess answers `needsPasscode` forever), so mint one rather than save a link
      // that silently locks everybody out.
      else if (!share.passcodeHash) passcode = createPasscode();
      passcodeHash = passcode ? hashPasscode(passcode) : share.passcodeHash;
    }

    await updateSharePolicy(share.id, policy, passcodeHash, expiresAt);
    // The Q&A-mode toggle rides the same PATCH but its own setter — absent means "leave it alone".
    const allowAi = typeof body.allowAi === "boolean" ? body.allowAi : share.allowAi;
    if (allowAi !== share.allowAi) await setShareAllowAi(share.id, allowAi);
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic

    const updated = { ...share, policy, expiresAt, hasPasscode: Boolean(passcodeHash), allowAi };
    return json({
      share: summarize(updated, await loadGrants(share.id)),
      // Only a freshly GENERATED code is echoed; one the owner typed is already theirs.
      passcode: supplied ? undefined : passcode,
    }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Revoke — write revoked_at, keep the row. The view log points at it, and "who revoked this link" has to
 *  stay answerable after the fact; deleting the row would erase the history along with the link. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string; shareId: string }> },
): Promise<NextResponse> {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;

    const revokedAt = Date.now();
    await revokeShare(share.id, revokedAt); // idempotent: the UPDATE is guarded on revoked_at IS NULL
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic
    return json({ ok: true, id: share.id, revokedAt: share.revokedAt ?? revokedAt }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
