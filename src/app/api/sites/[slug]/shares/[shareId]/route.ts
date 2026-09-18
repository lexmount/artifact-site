import { toShareRow } from "@/lib/db";
import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// One share link — retune it, or take it away. Owner-only, like the collection route.
import type { NextResponse } from "next/server";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { createPasscode, hashPasscode } from "@/lib/share";
import { errorResponse, json } from "../../../../_util";
import { ShareInputError, parseLabel, parseEmail, parseShareAuthorization, loadGrants, parseExpiry, parsePasscode, parsePolicy, resolveOwnedShare, summarize } from "../_shared";

class ShareConflictError extends Error {
  constructor(readonly code: "share_revoked" | "share_revision_conflict", readonly revision?: number) {
    super(code === "share_revoked" ? "This share has been revoked; create a new link" : "Share changed; reload it before saving");
  }
}

/**
 * Change policy / expiry / passcode.
 *
 * The update writes all fields in one statement, so every field the caller left out has to be
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
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;
    await assertMutationOrigin(request, site);

    // A revoked link cannot be brought back — nothing un-sets revoked_at, and it should stay that
    // way: "revoke" has to be final or it is not a revocation. Say so instead of accepting the edit
    // and leaving the owner to discover the link is still dead.
    if (share.revokedAt != null) throw new ShareConflictError("share_revoked");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const changed = await withPermissionCommit(request, site.id, "site.sharing.manage", async (q, _site, session) => {
      const [row] = await q("SELECT * FROM site_shares WHERE id=$1 AND site_id=$2 AND revoked_at IS NULL", [share.id, site.id]);
      if (!row) throw new ShareConflictError("share_revoked");
      const current = toShareRow(row);
      if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) throw new ShareInputError("expectedRevision must be a nonnegative integer");
      if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) throw new ShareConflictError("share_revision_conflict", current.revision);
      const label = body.label === undefined ? current.label : parseLabel(body.label);
      const policy = parsePolicy(body.policy, current.policy);
      const expiry = parseExpiry(body.expiresInDays);
      const expiresAt = expiry === undefined ? current.expiresAt : expiry;
      const supplied = parsePasscode(body.passcode);
      if (supplied && policy !== "passcode") {
        throw new ShareInputError("A passcode only applies to links with policy=passcode");
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
        else if (!current.passcodeHash) passcode = createPasscode();
        passcodeHash = passcode ? hashPasscode(passcode) : current.passcodeHash;
      }

      const authorization = await parseShareAuthorization(body,site.id,current);
      const allowAi = typeof body.allowAi === "boolean" ? body.allowAi : current.allowAi;
      // Resolve identities only after credentials and permissions are revalidated under the lock.
      const existing = body.grants === undefined ? [] : await q("SELECT user_id,email FROM share_grants WHERE share_id=$1", [share.id]);
      let grants: { userId: string | null; email: string | null }[] | undefined;
      if (body.grants !== undefined) {
        if (policy !== "people") throw new ShareInputError("A guest list only applies to policy=people");
        if (!Array.isArray(body.grants) || body.grants.length > 500) throw new ShareInputError("grants must be an array of at most 500 people");
        grants = [];
        for (const target of body.grants) {
          if (!target || typeof target !== "object") throw new ShareInputError("Each grant requires a userId or email");
          const byId = typeof target.userId === "string" && target.userId.trim();
          const email = byId ? null : parseEmail(target.email);
          const [user] = byId
            ? await q("SELECT id,email,email_verified FROM users WHERE id=$1", [byId])
            : await q("SELECT id,email,email_verified FROM users WHERE lower(email)=lower($1) AND email_verified=true", [email]);
          if (byId && !user) throw new ShareInputError("User not found");
          const verifiedEmail = user?.email_verified ? String(user.email).toLowerCase() : email;
          // Keep email grants after sign-in to preserve granted_at/granted_by, even for userId input.
          // Access matches the verified email. loadGrants still labels these rows "pending"
          // ("Not registered" in the UI); that label does not prove the recipient is unregistered.
          // Any future conversion to user_id must carry the original audit metadata forward.
          const oldEmail = existing.find(old => typeof old.email === "string" && old.email.toLowerCase() === verifiedEmail);
          grants.push(oldEmail ? {userId: null, email: String(oldEmail.email)} : user ? {userId: String(user.id), email: null} : {userId: null, email});
        }
      }
      const grantedBy = session?.userId ?? null;
      const rows = await q("UPDATE site_shares SET mode=$1,version_id=$2,policy=$3,passcode_hash=$4,expires_at=$5,allow_ai=CASE WHEN $6=1 THEN true ELSE false END,label=$8,revision=revision+1 WHERE id=$7 AND revoked_at IS NULL RETURNING id,revision", [authorization.mode,authorization.versionId,policy,passcodeHash,expiresAt,allowAi ? 1 : 0,share.id,label]);
      if (rows.length && grants) {
        for (const old of existing) {
          if (grants.some(g => g.userId === old.user_id && g.email === old.email)) continue;
          if (typeof old.user_id === "string") await q("DELETE FROM share_grants WHERE share_id=$1 AND user_id=$2", [share.id, old.user_id]);
          else if (typeof old.email === "string") await q("DELETE FROM share_grants WHERE share_id=$1 AND email=$2", [share.id, old.email]);
        }
        for (const grant of grants) await q(
          "INSERT INTO share_grants(share_id,user_id,email,granted_by,granted_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [share.id, grant.userId, grant.email, grantedBy, Date.now()],
        );
      }
      return rows.length ? { grants: await loadGrants(share.id), updated: { ...current, ...authorization, label, policy, expiresAt, hasPasscode: Boolean(passcodeHash), allowAi, revision: Number(rows[0].revision) }, passcode: supplied ? undefined : passcode } : null;
    });
    if (!changed) throw new ShareConflictError("share_revoked");
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic

    return json({
      share: summarize(changed.updated, changed.grants),
      // Only a freshly GENERATED code is echoed; one the owner typed is already theirs.
      passcode: changed.passcode,
    }, 200);
  } catch (error) {
    if (error instanceof ShareConflictError) return json({ error: error.message, code: error.code, ...(error.revision === undefined ? {} : { revision: error.revision }) }, 409);
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
    const { slug, shareId } = await context.params;
    const resolved = await resolveOwnedShare(request, slug, shareId);
    if (!resolved.ok) return resolved.response;
    const { site, share, actor } = resolved;
    await assertMutationOrigin(request, site);

    const revokedAt = Date.now();
    await withPermissionCommit(request,site.id,"site.sharing.manage", q => q("UPDATE site_shares SET revoked_at=$1,revision=revision+1 WHERE id=$2 AND revoked_at IS NULL",[revokedAt,share.id])); // idempotent: the UPDATE is guarded on revoked_at IS NULL
    await recordSiteAudit(site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic
    return json({ ok: true, id: share.id, revokedAt: share.revokedAt ?? revokedAt }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
