// Effective sharing reads and source precedence. Queries supplied by mutations stay in their transaction.
import "server-only";
import { rbacQuery, toSite } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site, Visibility } from "@/lib/types";
import type { SharingPolicy, SharingSource, SharingState } from "@/lib/sharing-policy";
import { policy as deploymentPolicy } from "@/lib/settings";
import { resolveSession } from "@/lib/session";
import { mainSharingActiveSql } from "@/lib/sharing-sql";
import { fail, rowPolicy, sharingSession } from "@/lib/sharing-common";
export async function effectiveSharingDefault(
  q: RbacQuery,
  userId: string,
  tenantId: string,
) {
  const rows = await q(
    "SELECT * FROM sharing_defaults WHERE tenant_id=$1 AND (user_id=$2 OR user_id='') ORDER BY user_id DESC",
    [tenantId, userId],
  );
  const user = rows.find((r) => r.user_id === userId),
    tenant = rows.find((r) => r.user_id === "");
  const fallback: SharingPolicy = {
    audience:
      deploymentPolicy.defaultVisibility === "unlisted"
        ? "anyone"
        : deploymentPolicy.defaultVisibility,
    comments: true,
  };
  return {
    policy: user ? rowPolicy(user) : tenant ? rowPolicy(tenant) : fallback,
    tenantPolicy: tenant ? rowPolicy(tenant) : fallback,
    inherited: !user,
    configured: Boolean(user || tenant),
  };
}
export async function getSiteSharing(
  site: Site,
  q: RbacQuery = rbacQuery,
): Promise<SharingState> {
  const [r] = await q(
    "SELECT st.*,f.name FROM site_sharing_state st LEFT JOIN sharing_scopes sc ON sc.id=st.source_id LEFT JOIN folders f ON f.id=sc.folder_id WHERE st.site_id=$1",
    [site.id],
  );
  // A revoked scope cannot regain access when its document or tenant is restored.
  // Expose a closed, custom state until an authorized manager explicitly follows again.
  if (r && (r.source === "folder" || r.source === "all") && !(await mainSharingActive(site, q)))
    return { policy: { audience: "private", comments: false }, source: "manual", sourceId: null, sourceName: null, revision: Number(r.revision), pending: false };
  const [comments] = await q(
    "SELECT main_policy FROM site_comment_settings WHERE site_id=$1",
    [site.id],
  );
  const pending = false;
  return {
    policy: r
      ? rowPolicy(r)
      : {
          audience: site.visibility === "unlisted" ? "anyone" : site.visibility,
          comments: comments?.main_policy !== "off",
        },
    source: (r?.source as SharingSource) ?? "default",
    sourceId: (r?.source_id as string) ?? null,
    sourceName: (r?.name as string) ?? null,
    revision: Number(r?.revision ?? 0),
    pending,
  };
}
export async function activeSource(
  q: RbacQuery,
  site: Site,
  folderId?: string | null,
  omitScope?: string,
) {
  const [folder] =
    folderId === undefined
      ? await q(
          "SELECT folder_id FROM folder_assignments WHERE user_id=$1 AND site_id=$2",
          [site.ownerId!, site.id],
        )
      : [{ folder_id: folderId }];
  const scopes = await q(
    "SELECT sc.*,f.name FROM sharing_scopes sc LEFT JOIN folders f ON f.id=sc.folder_id WHERE sc.owner_id=$1 AND sc.enabled=1 AND (sc.folder_id IS NULL OR sc.folder_id=$2) ORDER BY CASE WHEN sc.folder_id IS NULL THEN 1 ELSE 0 END",
    [site.ownerId!, (folder?.folder_id as string) ?? null],
  );
  const scope = scopes.find((r) => r.id !== omitScope);
  if (scope)
    return {
      policy: rowPolicy(scope),
      source: (scope.folder_id ? "folder" : "all") as SharingSource,
      sourceId: scope.id as string,
      sourceName: (scope.name as string) ?? null,
    };
  return {
    policy: (await effectiveSharingDefault(q, site.ownerId!, site.tenantId))
      .policy,
    source: "default" as SharingSource,
    sourceId: null,
    sourceName: null,
  };
}
/** Invalidated scope grants stay inert even after a scope is re-enabled. */
export async function mainSharingActive(site: Site, q: RbacQuery = rbacQuery): Promise<boolean> {
  return Boolean((await q(`SELECT s.id FROM sites s WHERE s.id=$1 AND ${mainSharingActiveSql}`, [site.id])).length);
}
/** Copies never inherit broader access than the source's effective main address. */
export async function forkVisibilityCeiling(site: Site, requested: Visibility, q: RbacQuery = rbacQuery): Promise<Visibility> {
  if (requested === "private" || site.visibility === "private" || !(await mainSharingActive(site, q))) return "private";
  return site.visibility === "unlisted" ? "unlisted" : requested;
}
/** Main-address access is separate from permanent membership. */
export async function mainSharingRole(
  site: Site,
  userId: string | null,
  q: RbacQuery = rbacQuery,
): Promise<"viewer" | "commenter" | null> {
  if (!userId || site.takenDownAt || site.deletedAt || !(await mainSharingActive(site, q))) return null;
  const [r] = await q(
    "SELECT st.* FROM site_sharing_state st JOIN users u ON u.id=$2 AND u.disabled_at IS NULL JOIN sites s ON s.id=st.site_id JOIN tenants t ON t.id=s.tenant_id AND t.disabled_at IS NULL WHERE st.site_id=$1 AND (st.audience='login' OR (st.audience='tenant' AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=s.tenant_id AND m.user_id=$2)))",
    [site.id, userId],
  );
  return r ? (Number(r.comments) ? "commenter" : "viewer") : null;
}
export async function ownedRows(
  q: RbacQuery,
  userId: string,
  folderId: string | null,
) {
  return q(
    `SELECT s.*,t.name AS tenant_name,st.source AS sharing_source,st.source_id AS sharing_source_id,st.revision AS sharing_revision,st.owner_id AS sharing_owner FROM sites s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN site_sharing_state st ON st.site_id=s.id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND s.taken_down_at IS NULL AND t.disabled_at IS NULL AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=s.tenant_id AND m.user_id=$1) ${folderId ? "AND EXISTS(SELECT 1 FROM folder_assignments a WHERE a.site_id=s.id AND a.user_id=$1 AND a.folder_id=$2)" : ""} ORDER BY s.id`,
    folderId ? [userId, folderId] : [userId],
  );
}
export async function scopeRow(q: RbacQuery, userId: string, folderId: string | null) {
  if (
    folderId &&
    !(
      await q("SELECT id FROM folders WHERE id=$1 AND user_id=$2", [
        folderId,
        userId,
      ])
    ).length
  )
    fail("Folder not found", 404);
  return (
    await q(
      "SELECT * FROM sharing_scopes WHERE owner_id=$1 AND COALESCE(folder_id,'')=$2",
      [userId, folderId ?? ""],
    )
  )[0];
}
export async function getScope(request: Request, folderId: string | null) {
  const session = await sharingSession(request);
  const scope = await scopeRow(rbacQuery, session.userId, folderId),
    rows = await ownedRows(rbacQuery, session.userId, folderId);
  const [folder] = folderId
    ? await rbacQuery("SELECT name FROM folders WHERE id=$1", [folderId])
    : [];
  const [total] = folderId
    ? await rbacQuery(
        "SELECT COUNT(*) AS n FROM folder_assignments WHERE user_id=$1 AND folder_id=$2",
        [session.userId, folderId],
      )
    : [{ n: rows.length }];
  return {
    enabled: Number(scope?.enabled) === 1,
    policy: scope ? rowPolicy(scope) : { audience: "tenant", comments: true },
    url: Number(scope?.enabled) === 1 ? `/c/${scope.token}` : null,
    name: (folder?.name as string) ?? "My entire collection",
    folderId,
    eligible: rows.length,
    following: scope
      ? rows.filter((r) => r.sharing_source_id === scope.id).length
      : 0,
    custom: rows.filter((r) => r.sharing_source === "manual").length,
    folders: rows.filter((r) => r.sharing_source === "folder").length,
    excluded: Number(total.n) - rows.length,
  };
}
export async function sharingCollection(request: Request, token: string) {
  const [scope] = await rbacQuery(
    "SELECT sc.*,f.name,u.display_name FROM sharing_scopes sc JOIN users u ON u.id=sc.owner_id AND u.disabled_at IS NULL LEFT JOIN folders f ON f.id=sc.folder_id WHERE sc.token=$1 AND sc.enabled=1",
    [token],
  );
  if (!scope) return { state: "unavailable", items: [] };
  const session = await resolveSession(request),
    items = [];
  const { canReadVersion } = await import("@/lib/share");
  const { publicationPolicy } = await import("@/lib/publication-policy");
  for (const row of await ownedRows(
    rbacQuery,
    scope.owner_id as string,
    scope.folder_id as string | null,
  )) {
    const site = toSite(row),
      visible = await publicationPolicy.readerSite(request, site);
    if (
      !visible.currentVersionId ||
      !(await canReadVersion(request, site, visible.currentVersionId, session))
    )
      continue;
    const sharing = await getSiteSharing(site);
    items.push({
      slug: site.slug,
      title: visible.title,
      tenantName: row.tenant_name as string,
      updatedAt: site.updatedAt,
      comments: sharing.policy.comments,
    });
  }
  if (!items.length) return { state: session ? "empty" : "login", items: [] };
  return {
    state: "ready",
    name: scope.name ?? "My entire collection",
    owner: scope.display_name,
    items,
  };
}
/** Legacy folder APIs cannot silently mutate permissions; the confirmed endpoint owns that transition. */
export async function assertUnsharedFolderMutation(
  q: RbacQuery,
  userId: string,
  siteId?: string,
  folderId?: string | null,
) {
  const scopes = await q(
    "SELECT id FROM sharing_scopes WHERE owner_id=$1 AND enabled=1 AND (folder_id=$2 OR folder_id IN (SELECT folder_id FROM folder_assignments WHERE user_id=$1 AND site_id=$3))",
    [userId, folderId ?? null, siteId ?? null],
  );
  if (scopes.length)
    fail("Review sharing changes before moving or deleting this folder", 409);
}
