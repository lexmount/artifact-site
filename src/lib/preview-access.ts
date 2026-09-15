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
import { readAccess, canReadVersion, requestShareAccess, isLive } from "@/lib/share";
import { resolveCapability, resolveViewer } from "@/lib/authz";
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
    const override = new URL(request.url).searchParams.get("v");
    if (override && override !== grant.versionId) return null;
    const version = await getVersion(grant.versionId);
    if (!version || version.siteId !== site.id) return null;
    if (grant.userId) {
      const user = await getUser(grant.userId);
      if (!user || user.disabledAt) return null;
    }
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
      if (share.versionId && share.versionId !== grant.versionId) return null;
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
      grant.versionId !== site.currentVersionId
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
      const legacy = grant.legacy && !site.ownerId;
      if (
        !member &&
        !manager &&
        !(
          grant.operator &&
          config.publishApiToken &&
          grant.operator === operatorFingerprint()
        ) &&
        !legacy &&
        !(
          grant.anonOwnerHash &&
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
  if (!(await canReadVersion(request, site, versionId, session))) return null;
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
      "site.read", site.id, request.headers.get("x-management-reason") || "Administrative preview");
  const legacy =
    !site.ownerId &&
    (await resolveCapability(resolveViewer(request, session), site)) ===
      "owner";
  const grant: PreviewGrant = {
    versionId,
    shareId: share?.id ?? null,
    userId: session?.userId ?? null,
    anonOwnerHash: anonIdFromRequest(request)
      ? anonymousFingerprint(anonIdFromRequest(request)!)
      : null,
    fingerprint: share ? fingerprint(share) : "",
    ...(manager === "platform-admin" || manager === "tenant-admin"
      ? { management: manager }
      : {}),
    legacy,
    ...(isAdmin(request) ? { operator: operatorFingerprint() } : {}),
  };
  return { versionId, key: await mintScopedPreviewKey(site, grant) };
}
