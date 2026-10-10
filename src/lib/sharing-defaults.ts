import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createId,
  rbacQuery,
  rbacTransaction,
  toSite,
  type Row,
} from "@/lib/db";
import { mainSharingActiveSql } from "@/lib/sharing-sql";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site, Visibility } from "@/lib/types";
import {
  sharingPolicySchema,
  type SharingPolicy,
  type SharingSource,
  type SharingState,
  type SharingPreview,
  type SharingImpact,
} from "@/lib/sharing-policy";
import { policy as deploymentPolicy } from "@/lib/settings";
import { resolveSession, csrfSafe } from "@/lib/session";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import {
  assertSessionCurrent,
  withPermissionCommit,
} from "@/lib/authorized-commit";
import { requirePermission } from "@/lib/authz";
import { assertMutationOrigin } from "@/lib/request-auth";
import {
  memberRole,
  requireTenantManager,
  recordRbacAudit,
} from "@/lib/rbac-access";
import { SCOPE_WRITE } from "@/lib/oauth-shared";
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
const visibility = (p: SharingPolicy) =>
  p.audience === "public"
    ? "public"
    : p.audience === "anyone"
      ? "unlisted"
      : "private";
const rowPolicy = (r: Row): SharingPolicy => ({
  audience: r.audience as SharingPolicy["audience"],
  comments: Number(r.comments) === 1,
});
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function sharingSession(request: Request, write = false) {
  const session = await resolveSession(request);
  if (!session) throw new AuthError("Please sign in first");
  if (
    write &&
    (!csrfSafe(request) ||
      (session.scopes && !session.scopes.includes(SCOPE_WRITE)))
  )
    throw new EditForbiddenError(
      "Sharing changes require a same-origin write credential",
    );
  return session;
}
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
export async function getSharingPreference(
  request: Request,
  tenantId: string,
  tenant = false,
) {
  const session = await sharingSession(request);
  if (tenant) await requireTenantManager(request, tenantId);
  else if (!(await memberRole(tenantId, session.userId)))
    fail("Tenant not found", 404);
  return effectiveSharingDefault(
    rbacQuery,
    tenant ? "" : session.userId,
    tenantId,
  );
}
export async function setSharingPreference(
  request: Request,
  tenantId: string,
  input: SharingPolicy | null,
  tenant = false,
) {
  const session = await sharingSession(request, true);
  const parsed = input === null ? null : sharingPolicySchema.parse(input);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    if (tenant) await requireTenantManager(request, tenantId);
    else if (!(await memberRole(tenantId, session.userId)))
      fail("Tenant not found", 404);
    const userId = tenant ? "" : session.userId;
    if (!parsed)
      await q(
        "DELETE FROM sharing_defaults WHERE tenant_id=$1 AND user_id=$2",
        [tenantId, userId],
      );
    else
      await q(
        "INSERT INTO sharing_defaults(tenant_id,user_id,audience,comments,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,user_id) DO UPDATE SET audience=excluded.audience,comments=excluded.comments,updated_at=excluded.updated_at",
        [tenantId, userId, parsed.audience, +parsed.comments, Date.now()],
      );
    await recordRbacAudit(
      q,
      tenantId,
      session.userId,
      "sharing.defaults",
      userId || tenantId,
      JSON.stringify(parsed),
    );
    return effectiveSharingDefault(q, userId, tenantId);
  });
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
/** Apply the effective main-address grant. Independent grants and links are intentionally untouched. */
export async function applyMainSharing(
  q: RbacQuery,
  site: Site,
  p: SharingPolicy,
) {
  await q("UPDATE sites SET visibility=$1,updated_at=$2 WHERE id=$3", [
    visibility(p),
    Date.now(),
    site.id,
  ]);
  await q(
    "UPDATE site_sharing_state SET audience=$1,comments=$2,pending=0 WHERE site_id=$3",
    [p.audience, +p.comments, site.id],
  );
  await q(
    "INSERT INTO site_comment_settings(site_id,main_policy,reader_access,updated_at) VALUES($1,$2,1,$3) ON CONFLICT(site_id) DO UPDATE SET main_policy=excluded.main_policy,reader_access=1,updated_at=excluded.updated_at",
    [site.id, p.comments ? "login" : "off", Date.now()],
  );
}
async function putState(
  q: RbacQuery,
  site: Site,
  p: SharingPolicy,
  source: SharingSource,
  sourceId: string | null,
  request?: Request,
) {
  const old = await getSiteSharing(site, q);
  const nextRevision = old.revision + 1;
  if (!(await mainSharingActive(site, q))) {
    // The caller has now passed document authorization. Materialize the closed
    // effective state before attaching a new source.
    await applyMainSharing(q, site, old.policy);
    site = { ...site, visibility: visibility(old.policy) };
  }
  await q(
    "INSERT INTO site_sharing_state(site_id,owner_id,audience,comments,source,source_id,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(site_id) DO UPDATE SET owner_id=excluded.owner_id,source=excluded.source,source_id=excluded.source_id,revision=excluded.revision,updated_at=excluded.updated_at",
    [
      site.id,
      site.ownerId,
      old.policy.audience,
      +old.policy.comments,
      source,
      sourceId,
      nextRevision,
      Date.now(),
    ],
  );
  const pending = false;
  await applyMainSharing(q, site, p);
  await recordRbacAudit(
    q,
    site.tenantId,
    request ? ((await resolveSession(request))?.userId ?? null) : site.ownerId,
    "sharing.main",
    site.id,
    JSON.stringify({
      before: old.policy,
      requested: p,
      source,
      sourceId,
      pending,
    }),
  );
  return pending;
}
/** Called inside creation's transaction, after the version and publication state exist. */
export async function initializeSharing(
  q: RbacQuery,
  site: Site,
  request?: Request,
  forkVisibility?: Visibility,
) {
  if (!site.ownerId) return;
  const source = await activeSource(q, site);
  const defaults = await effectiveSharingDefault(
    q,
    site.ownerId,
    site.tenantId,
  );
  if (source.source === "default" && !defaults.configured) return;
  // Fork privacy is a ceiling, not a default: do not silently widen a copied document.
  const capped = forkVisibility === "private" && source.policy.audience !== "private"
    ? { ...source.policy, audience: "private" as const }
    : forkVisibility === "unlisted" && source.policy.audience === "public"
      ? { ...source.policy, audience: "anyone" as const } : source.policy;
  const constrained = capped !== source.policy;
  await putState(
    q,
    site,
    capped,
    constrained ? "manual" : source.source,
    constrained ? null : source.sourceId,
    request,
  );
}
/** Old visibility/comment routes must also stop automatic following. */
export async function markSharingManual(
  q: RbacQuery,
  site: Site,
  p?: Partial<SharingPolicy>,
) {
  const old = await getSiteSharing(site, q),
    merged = { ...old.policy, ...p };
  if (!(await mainSharingActive(site, q))) {
    // Detaching an invalid scope must not revive the raw visibility it left behind.
    // Preserve the effective closed state before installing a manual override.
    await applyMainSharing(q, site, old.policy);
    site = { ...site, visibility: visibility(old.policy) };
  }
  await q(
    "INSERT INTO site_sharing_state(site_id,owner_id,audience,comments,source,revision,updated_at) VALUES($1,$2,$3,$4,'manual',1,$5) ON CONFLICT(site_id) DO UPDATE SET owner_id=excluded.owner_id,audience=excluded.audience,comments=excluded.comments,source='manual',source_id=NULL,revision=site_sharing_state.revision+1,pending=0,updated_at=excluded.updated_at",
    [site.id, site.ownerId, merged.audience, +merged.comments, Date.now()],
  );
  return site;
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
export async function siteSharingChange(
  request: Request,
  siteId: string,
  input: { action: "custom" | "follow" | "stop"; policy?: SharingPolicy },
) {
  return withPermissionCommit(
    request,
    siteId,
    input.action === "stop" ? "site.admins.manage" : "site.sharing.manage",
    async (q, site) => {
      await assertMutationOrigin(request, site);
      if (input.action === "stop") {
        await q("DELETE FROM role_bindings WHERE resource_site_id=$1", [
          site.id,
        ]);
        await q(
          "UPDATE site_shares SET revoked_at=$1,access_revision=access_revision+1 WHERE site_id=$2 AND revoked_at IS NULL",
          [Date.now(), site.id],
        );
        await putState(
          q,
          site,
          { audience: "private", comments: false },
          "manual",
          null,
          request,
        );
      } else if (input.action === "follow") {
        if (!site.ownerId) fail("Account-owned documents are required");
        const target = await activeSource(q, site);
        await putState(
          q,
          site,
          target.policy,
          target.source,
          target.sourceId,
          request,
        );
      } else
        await putState(
          q,
          site,
          sharingPolicySchema.parse(input.policy),
          "manual",
          null,
          request,
        );
      const [fresh] = await q("SELECT * FROM sites WHERE id=$1", [site.id]);
      return getSiteSharing(toSite(fresh), q);
    },
  );
}
async function ownedRows(
  q: RbacQuery,
  userId: string,
  folderId: string | null,
) {
  return q(
    `SELECT s.*,t.name AS tenant_name,st.source AS sharing_source,st.source_id AS sharing_source_id,st.revision AS sharing_revision,st.owner_id AS sharing_owner FROM sites s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN site_sharing_state st ON st.site_id=s.id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND s.taken_down_at IS NULL AND t.disabled_at IS NULL AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=s.tenant_id AND m.user_id=$1) ${folderId ? "AND EXISTS(SELECT 1 FROM folder_assignments a WHERE a.site_id=s.id AND a.user_id=$1 AND a.folder_id=$2)" : ""} ORDER BY s.id`,
    folderId ? [userId, folderId] : [userId],
  );
}
async function scopeRow(q: RbacQuery, userId: string, folderId: string | null) {
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
const scopeInput = z
  .object({
    enabled: z.boolean(),
    policy: sharingPolicySchema.optional(),
    confirmation: z.string().optional(),
    deleteFolder: z.boolean().optional(),
  })
  .strict();
export async function scopeChange(
  request: Request,
  folderId: string | null,
  raw: unknown,
): Promise<SharingPreview> {
  const input = scopeInput.parse(raw),
    session = await sharingSession(request, true);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    const old = await scopeRow(q, session.userId, folderId);
    const scopeId = String(old?.id ?? "new");
    const policy =
      input.policy ??
      (old ? rowPolicy(old) : { audience: "tenant" as const, comments: true });
    const rows = await ownedRows(q, session.userId, folderId);
    const items: SharingImpact[] = [],
      targets: {
        site: Site;
        policy: SharingPolicy;
        source: SharingSource;
        sourceId: string | null;
      }[] = [];
    const starting = input.enabled && Number(old?.enabled) !== 1;
    for (const row of rows) {
      const site = toSite(row),
        before = await getSiteSharing(site, q);
      // A new folder rule wins; a new all-sites rule never replaces an active folder.
      if (
        input.enabled &&
        !folderId &&
        (await activeSource(q, site)).source === "folder"
      )
        continue;
      if (!starting && before.sourceId !== scopeId) continue;
      const target = input.enabled
        ? {
            policy,
            source: (folderId ? "folder" : "all") as SharingSource,
            sourceId: scopeId,
            sourceName: folderId
              ? String(
                  (
                    await q("SELECT name FROM folders WHERE id=$1", [folderId])
                  )[0].name,
                )
              : null,
          }
        : await activeSource(q, site, undefined, scopeId);
      items.push({
        slug: site.slug,
        title: site.title,
        tenantName: row.tenant_name as string,
        before: before.policy,
        after: target.policy,
        source: target.source,
        sourceName: target.sourceName,
        changed:
          JSON.stringify(before.policy) !== JSON.stringify(target.policy),
      });
      targets.push({ site, ...target });
    }
    const confirmation = fingerprint({
      user: session.userId,
      folderId,
      enabled: input.enabled,
      policy,
      deleteFolder: input.deleteFolder,
      revision: old?.revision,
      rows: rows.map((r) => [
        r.id,
        r.updated_at,
        r.sharing_revision,
        r.owner_id,
      ]),
      items,
    });
    const [total] = folderId
      ? await q(
          "SELECT COUNT(*) AS n FROM folder_assignments WHERE user_id=$1 AND folder_id=$2",
          [session.userId, folderId],
        )
      : [{ n: rows.length }];
    const preview = {
      confirmation,
      items,
      excluded: Number(total.n) - rows.length,
      unchanged: rows.length - items.length,
    };
    if (!input.confirmation) return preview;
    if (input.confirmation !== confirmation)
      fail("Sharing changed; review the updated impact before confirming", 409);
    if (input.deleteFolder && (!folderId || input.enabled))
      fail("Disable the folder before deleting it");
    const id = old ? String(old.id) : createId("scope");
    await q(
      "INSERT INTO sharing_scopes(id,owner_id,folder_id,token,enabled,audience,comments,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,COALESCE(folder_id,'')) DO UPDATE SET token=excluded.token,enabled=excluded.enabled,audience=excluded.audience,comments=excluded.comments,revision=sharing_scopes.revision+1,updated_at=excluded.updated_at",
      [
        id,
        session.userId,
        folderId,
        Number(old?.enabled) === 1
          ? String(old.token)
          : randomBytes(24).toString("base64url"),
        +input.enabled,
        policy.audience,
        +policy.comments,
        Date.now(),
      ],
    );
    let pending = 0;
    for (const target of targets) {
      await requirePermission(
        request,
        target.site,
        "site.sharing.manage",
        session,
        false,
      );
      if (
        await putState(
          q,
          target.site,
          target.policy,
          target.source,
          target.sourceId === "new" ? id : target.sourceId,
          request,
        )
      )
        pending++;
    }
    if (!input.enabled && old) {
      // The caller controls this scope, not necessarily every former follower. Invalidate
      // remaining derived grants without changing inaccessible documents or their policies.
      // Detaching also prevents a later re-enable from reviving these grants.
      await q("UPDATE site_sharing_state SET source_id=NULL,revision=revision+1,pending=0,updated_at=$1 WHERE source_id=$2 AND owner_id=$3 AND source IN ('folder','all')", [Date.now(), id, session.userId]);
    }
    if (input.deleteFolder) {
      await q(
        "DELETE FROM folder_assignments WHERE folder_id=$1 AND user_id=$2",
        [folderId, session.userId],
      );
      await q("DELETE FROM folders WHERE id=$1 AND user_id=$2", [
        folderId,
        session.userId,
      ]);
    }
    return { ...preview, applied: true, pending };
  });
}
export async function moveSharing(
  request: Request,
  slugs: string[],
  folderId: string | null,
  confirmation?: string,
): Promise<SharingPreview> {
  z.array(z.string().min(1)).min(1).max(100).parse(slugs);
  if (new Set(slugs).size !== slugs.length) fail("Duplicate documents");
  const session = await sharingSession(request, true);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    if (folderId) await scopeRow(q, session.userId, folderId);
    const items: SharingImpact[] = [],
      rows: Row[] = [],
      targets = [];
    for (const slug of slugs) {
      const [row] = await q(
        "SELECT s.*,t.name AS tenant_name FROM sites s JOIN tenants t ON t.id=s.tenant_id WHERE s.slug=$1 AND s.deleted_at IS NULL AND t.disabled_at IS NULL",
        [slug],
      );
      if (!row) fail("Document not found", 404);
      const site = toSite(row);
      const [fileable] = await q(
        "SELECT id FROM sites WHERE id=$1 AND (owner_id=$2 OR EXISTS(SELECT 1 FROM authorization_site_members m WHERE m.site_id=$1 AND m.user_id=$2))",
        [site.id, session.userId],
      );
      if (!fileable) fail("Document not found", 404);
      const [assignment] = await q(
        "SELECT folder_id FROM folder_assignments WHERE user_id=$1 AND site_id=$2",
        [session.userId, site.id],
      );
      const before = await getSiteSharing(site, q);
      rows.push({
        id: site.id,
        owner: site.ownerId,
        revision: before.revision,
        oldFolder: assignment?.folder_id ?? null,
        updated: site.updatedAt,
      });
      if (site.ownerId !== session.userId || assignment?.folder_id === folderId)
        continue;
      await requirePermission(
        request,
        site,
        "site.sharing.manage",
        session,
        false,
      );
      const target = await activeSource(q, site, folderId);
      if (target.source !== "folder" && before.source !== "folder") continue;
      if (target.source !== "folder" && before.source === "manual") continue;
      items.push({
        slug,
        title: site.title,
        tenantName: row.tenant_name as string,
        before: before.policy,
        after: target.policy,
        source: target.source,
        sourceName: target.sourceName,
        changed:
          JSON.stringify(before.policy) !== JSON.stringify(target.policy),
      });
      targets.push({ site, ...target });
    }
    const digest = fingerprint({
      user: session.userId,
      folderId,
      rows,
      items,
      targets: targets.map((t) => [t.sourceId, t.policy]),
    });
    const excluded = rows.filter((r) => r.owner !== session.userId).length;
    const preview = {
      confirmation: digest,
      items,
      excluded,
      unchanged: rows.length - targets.length - excluded,
    };
    if (!confirmation) return preview;
    if (confirmation !== digest)
      fail("Sharing changed; review the updated impact before confirming", 409);
    for (const row of rows) {
      if (folderId)
        await q(
          "INSERT INTO folder_assignments(user_id,site_id,folder_id,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,site_id) DO UPDATE SET folder_id=excluded.folder_id,updated_at=excluded.updated_at",
          [session.userId, row.id as string, folderId, Date.now()],
        );
      else
        await q(
          "DELETE FROM folder_assignments WHERE user_id=$1 AND site_id=$2",
          [session.userId, row.id as string],
        );
    }
    let pending = 0;
    for (const target of targets)
      if (
        await putState(
          q,
          target.site,
          target.policy,
          target.source,
          target.sourceId,
          request,
        )
      )
        pending++;
    return { ...preview, applied: true, pending };
  });
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
