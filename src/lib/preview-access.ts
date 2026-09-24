import { receiptShare, sessionReceiptShare } from "@/lib/notifications/receipts";
import { databaseRoleAllows, everyoneRole } from "@/lib/role-bindings";
import { readerVersionAllowed } from "@/lib/version-access";
import { managementReason } from "@/lib/management-reason";
import "server-only";
import { createHash } from "node:crypto";
import {
  rbacQuery,
  getShare,
  getUser,
  getVersion,
  shareAdmits,
} from "@/lib/db";
import {
  accountSiteRole,
  tenantActive,
  managementRole,
  memberRole,
  recordRbacAudit,
} from "@/lib/rbac-access";
import { readAccess, readableVersionFilter, shareTokenFromRequest, requestShareAccess, isLive } from "@/lib/share";
import { resolveAuthority, resolveViewer } from "@/lib/authz";
import { config } from "@/lib/config";
import { isAdmin } from "@/lib/auth";
import { isAdminUser, resolveAdmin } from "@/lib/admin";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import {
  mintScopedPreviewKey,
  readScopedPreviewKey,
  type PreviewGrant,
} from "@/lib/preview-key";
import type { ShareRow, Site } from "@/lib/types";
function anonymousFingerprint(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
function operatorFingerprint(): string {
  return createHash("sha256").update(config.publishApiToken).digest("hex");
}
function fingerprint(share: ShareRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        share.policy,
        share.passcodeHash,
        share.versionId,
        share.expiresAt,
      ]),
    )
    .digest("hex");
}
export async function authorizePreview(
  request: Request,
  site: Site,
  key: string | null,
): Promise<{ versionId: string; key: string | null } | null> {
  if (site.deletedAt || !(await tenantActive(site.tenantId))) return null;
  if (key) {
    const grant = await readScopedPreviewKey(key, site);
    if (!grant) return null;
    // The preview route strips artifact-owned queries from keyed requests before calling us.
    // Retain this guard for direct callers: a platform version override cannot widen a grant.
    const override = new URL(request.url).searchParams.get("v");
    if (override && override !== grant.versionId) return null;
    const version = await getVersion(grant.versionId);
    if (!version || version.siteId !== site.id) return null;
    if (grant.userId) {
      if (!grant.sessionId) return null;
      try { await (await import("@/lib/authorized-commit")).assertSessionCurrent(rbacQuery,{id:grant.sessionId,userId:grant.userId}); }
      catch { return null; }
      const user = await getUser(grant.userId);
      if (!user || user.disabledAt) return null;
    }
    if (grant.receiptShareId && (!grant.userId || !await receiptShare(site,grant.versionId,grant.userId,grant.receiptShareId))) return null;
    if (grant.shareId) {
      if (site.takenDownAt) return null;
      const share = await getShare(grant.shareId);
      if (
        !share ||
        share.siteId !== site.id ||
        !isLive(share) ||
        fingerprint(share) !== grant.fingerprint
      )
        return null;
      if (!readerVersionAllowed(site, grant.versionId, share.versionId)) return null;
      if (share.policy === "login" && !grant.userId) return null;
      if (share.policy === "people") {
        const user = grant.userId ? await getUser(grant.userId) : null;
        if (
          !user ||
          !(await shareAdmits(
            share.id,
            user.id,
            user.emailVerified ? user.email : null,
          ))
        )
          return null;
      }
    } else if (
      site.visibility === "private" ||
      site.takenDownAt ||
      !readerVersionAllowed(site, grant.versionId)
    ) {
      const member = grant.userId
        ? await accountSiteRole(site, { userId: grant.userId })
        : null;
      const user = grant.userId ? await getUser(grant.userId) : null;
      const manager =
        grant.management === "platform-admin"
          ? user && isAdminUser(user)
          : grant.management === "tenant-admin" &&
            user &&
            (await memberRole(site.tenantId, user.id)) === "admin";
      const legacy = Boolean(site.editToken) && !site.ownerId && site.tenantId === "anonymous" && grant.editTokenHash === anonymousFingerprint(site.editToken);
      if (
        !(member && (readerVersionAllowed(site,grant.versionId) || await databaseRoleAllows(member,"site.history.read"))) &&
        !(await everyoneRole(site.id) && !site.takenDownAt && readerVersionAllowed(site,grant.versionId)) &&
        !manager &&
        !(
          grant.operator &&
          config.publishApiToken &&
          grant.operator === operatorFingerprint()
        ) &&
        !legacy &&
        !(
          grant.anonOwnerHash &&
          site.tenantId === "anonymous" &&
          !site.ownerId &&
          site.anonOwnerId &&
          anonymousFingerprint(site.anonOwnerId) === grant.anonOwnerHash
        )
      )
        return null;
    }
    return { versionId: grant.versionId, key };
  }
  const session = await resolveSession(request);
  const share = await requestShareAccess(request, site, session);
  const versionId =
    new URL(request.url).searchParams.get("v") ||
    share?.versionId ||
    site.currentVersionId;
  const version=await getVersion(versionId);
  if(!version || version.siteId !== site.id)return null;
  const independentlyReadable=(await readableVersionFilter(request,site,session))(versionId);
  const receipt=!independentlyReadable && !shareTokenFromRequest(request) ? await sessionReceiptShare(site,versionId,session):null;
  if(!independentlyReadable && !receipt)return null;
  if (site.visibility !== "private" && !site.takenDownAt && versionId === site.currentVersionId && !share)
    return { versionId, key: null };
  // Version filtering is side-effect free; this entry point owns the administrative read audit.
  const access = await readAccess(request, site, session);
  // Preserve the existing audited platform-admin read fallback; grants remain read-only.
  const manager =
    (await managementRole(request, site, session)) ??
    ((await resolveAdmin(request, session)) ? "platform-admin" : null);
  // Operator credentials (and admins who own the site) can pass the ordinary capability
  // gate without a read audit. Preserve their audit, but never duplicate the admin gate's row.
  if (manager && access !== "admin")
    await recordRbacAudit(rbacQuery, site.tenantId, session?.userId ?? null,
      "site.read", site.id, managementReason(request) ?? "Administrative preview");
  const authority = await resolveAuthority(resolveViewer(request, session), site);
  // Attribute a key only to a share that actually admits this version. A direct
  // viewer grant can independently admit current/official alongside a pinned link.
  const previewShare = share && readerVersionAllowed(site,versionId,share.versionId) ? share : receipt;
  const grant: PreviewGrant = {
    versionId,
    ...(receipt ? {receiptShareId:receipt.id} : {}),
    shareId: previewShare?.id ?? null,
    userId: session?.userId ?? null,
    ...(session ? {sessionId:session.id} : {}),
    anonOwnerHash: anonIdFromRequest(request)
      ? anonymousFingerprint(anonIdFromRequest(request)!)
      : null,
    fingerprint: previewShare ? fingerprint(previewShare) : "",
    ...(manager === "platform-admin" || manager === "tenant-admin"
      ? { management: manager }
      : {}),
    ...(authority.source === "anonymous-token" ? { editTokenHash: anonymousFingerprint(site.editToken) } : {}),
    ...(isAdmin(request) ? { operator: operatorFingerprint() } : {}),
  };
  return { versionId, key: await mintScopedPreviewKey(site, grant) };
}
