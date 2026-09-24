import "server-only";
import { rbacQuery, toShareRow } from "@/lib/db";
import { readerVersionAllowed } from "@/lib/version-access";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import type { RbacQuery } from "@/lib/rbac-store";
import type { CommentScope } from "@/lib/comments/contracts";
import type { Session, Site } from "@/lib/types";
import { ensureSpace } from "@/lib/comments/store";
import {
  hashToken,
  shareTokenFromRequest,
  sharePolicyAccess,
} from "@/lib/share";
import { safeEqual } from "@/lib/crypto";

/** Mint only from a freshly verified original link, never from another receipt or a follow. */
export async function rememberShareAccess(
  q: RbacQuery,
  request: Request,
  site: Site,
  scope: CommentScope,
  session: Session,
) {
  if (scope.entry.kind !== "share") return;
  const token = shareTokenFromRequest(request);
  if (!token) return;
  const [row] = await q(
    "SELECT * FROM site_shares WHERE id=$1 AND site_id=$2",
    [scope.entry.shareId, site.id],
  );
  if (!row) return;
  const share = toShareRow(row),
    now = Date.now();
  if (
    !safeEqual(hashToken(token), share.tokenHash) ||
    share.revokedAt ||
    (share.expiresAt !== null && share.expiresAt <= now) ||
    !readerVersionAllowed(site, scope.versionId, share.versionId) ||
    site.takenDownAt ||
    !["comment", "edit"].includes(share.mode)
  )
    return;
  if (!(await sharePolicyAccess(request, share, { session })).ok) return;
  const spaceId = await ensureSpace(q, scope);
  await q(
    `INSERT INTO share_access_receipts(user_id,space_id,tenant_id,access_revision,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,space_id) DO UPDATE SET tenant_id=excluded.tenant_id,access_revision=excluded.access_revision,verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=NULL`,
    [
      session.userId,
      spaceId,
      site.tenantId,
      Number(row.access_revision),
      now,
      Math.min(now + 30 * 86_400_000, share.expiresAt ?? Infinity),
    ],
  );
}

/** Canonical live policy is always checked; receipts never widen a link's version scope. */
export async function receiptShare(
  site: Site,
  versionId: string,
  userId: string,
  shareId?: string,
) {
  if (site.deletedAt || site.takenDownAt) return null;
  const rows = await rbacQuery(
    `SELECT sh.* FROM share_access_receipts r
    JOIN comment_spaces sp ON sp.id=r.space_id JOIN site_shares sh ON sh.id=sp.share_id AND sh.site_id=sp.site_id
    JOIN sites s ON s.id=sp.site_id JOIN tenants t ON t.id=s.tenant_id JOIN users u ON u.id=r.user_id
    WHERE r.user_id=$1 AND sp.site_id=$2 AND sp.version_id=$3 AND r.tenant_id=s.tenant_id
    AND r.revoked_at IS NULL AND r.expires_at>$4 AND r.access_revision=sh.access_revision
    AND sh.revoked_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>$4)
    AND sh.mode IN ('comment','edit') AND s.deleted_at IS NULL AND s.taken_down_at IS NULL AND t.disabled_at IS NULL AND u.disabled_at IS NULL
    ${shareId ? "AND sh.id=$5" : ""}`,
    [userId, site.id, versionId, Date.now(), ...(shareId ? [shareId] : [])],
  );
  for (const row of rows) {
    const share = toShareRow(row);
    if (!readerVersionAllowed(site, versionId, share.versionId)) continue;
    if (share.policy === "people") {
      const grant = await rbacQuery(
        `SELECT g.share_id FROM share_grants g JOIN users u ON u.id=$2 WHERE g.share_id=$1 AND (g.user_id=$2 OR (u.email_verified=TRUE AND u.email IS NOT NULL AND u.email<>'' AND LOWER(g.email)=LOWER(u.email))) LIMIT 1`,
        [share.id, userId],
      );
      if (!grant.length) continue;
    }
    return share;
  }
  return null;
}
export async function sessionReceiptShare(
  site: Site,
  versionId: string,
  session: Session | null,
  shareId?: string,
) {
  if (!session) return null;
  await assertSessionCurrent(rbacQuery, session);
  return receiptShare(site, versionId, session.userId, shareId);
}
