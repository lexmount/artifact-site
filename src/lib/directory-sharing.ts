import "server-only";
import { mainSharingActiveSql } from "@/lib/sharing-sql";

/** Display/filter predicates only, never an authorization grant. Correlated against sites s. */
export function directorySharingSql(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid sharing timestamp");
  const available = "s.taken_down_at IS NULL";
  const versionAllowed = (target: string) => `EXISTS (SELECT 1 FROM versions v WHERE v.site_id=s.id AND v.id=${target})`;
  const current = "s.current_version_id";
  const main = `(${available} AND ${mainSharingActiveSql} AND ${versionAllowed(current)})`;
  const audience = `CASE WHEN ${main} THEN COALESCE((SELECT st.audience FROM site_sharing_state st WHERE st.site_id=s.id),CASE s.visibility WHEN 'unlisted' THEN 'anyone' ELSE s.visibility END) ELSE 'private' END`;
  // Takedown blocks public entrances, but direct user/tenant grants retain account access.
  const members = `(EXISTS (
    SELECT 1 FROM role_bindings b JOIN role_permissions rp ON rp.role_id=b.role_id AND rp.permission_code='site.read'
    WHERE b.resource_site_id=s.id AND (
      (b.subject_type='everyone' AND s.taken_down_at IS NULL) OR
      (b.subject_type='tenant' AND b.subject_tenant_id=s.tenant_id) OR
      (b.subject_type='user' AND b.subject_user_id<>s.owner_id AND EXISTS (
        SELECT 1 FROM users u JOIN tenant_members m ON m.user_id=u.id AND m.tenant_id=s.tenant_id
        WHERE u.id=b.subject_user_id AND u.disabled_at IS NULL)))))`;
  const links = `(${available} AND EXISTS (SELECT 1 FROM site_shares sh WHERE sh.site_id=s.id
    AND sh.revoked_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>${now})
    AND ${versionAllowed(`COALESCE(sh.version_id,${current})`)}
    AND (sh.policy IN ('public','login') OR (sh.policy='passcode' AND sh.passcode_hash IS NOT NULL)
      OR (sh.policy='people' AND EXISTS (SELECT 1 FROM share_grants g WHERE g.share_id=sh.id
        AND ((g.email IS NOT NULL AND g.email<>'' AND NOT EXISTS (SELECT 1 FROM users owner WHERE owner.id=s.owner_id AND owner.email_verified=TRUE AND LOWER(owner.email)=LOWER(g.email))) OR (g.user_id<>s.owner_id AND EXISTS (SELECT 1 FROM users u WHERE u.id=g.user_id AND u.disabled_at IS NULL))))))))`;
  return { audience, members, links, shared: `((${audience})<>'private' OR ${members} OR ${links})` };
}
