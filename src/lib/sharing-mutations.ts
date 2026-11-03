import { syncMainPasscode } from "@/lib/main-passcode";
// Per-site transitions preserve authorization transactions before applying main access.
import "server-only";
import { toSite } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site, Visibility } from "@/lib/types";
import { sharingPolicySchema, type SharingPolicy, type SharingSource } from "@/lib/sharing-policy";
import { resolveSession } from "@/lib/session";
import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
import { recordRbacAudit } from "@/lib/rbac-access";
import { fail, visibility } from "@/lib/sharing-common";
import { activeSource, effectiveSharingDefault, getSiteSharing, mainSharingActive } from "@/lib/sharing-read";
/** Apply the effective main-address grant. Independent grants and links are intentionally untouched. */
export async function applyMainSharing(
  q: RbacQuery,
  site: Site,
  p: SharingPolicy,
) {
  await syncMainPasscode(q, site.id, p.audience === "passcode");
  // Sharing has its own timestamp and revision; keep the artifact's update time unchanged.
  await q("UPDATE sites SET visibility=$1 WHERE id=$2", [
    visibility(p),
    site.id,
  ]);
  await q(
    "UPDATE site_sharing_state SET audience=$1,comments=$2,pending=0 WHERE site_id=$3",
    [p.audience, +p.comments, site.id],
  );
  // Link changes must not opt legacy discussions into reader access or expand members-only comments.
  // New publications explicitly initialize reader_access=1; missing historical rows retain 0.
  await q(
    "INSERT INTO site_comment_settings(site_id,main_policy,reader_access,updated_at) VALUES($1,$2,0,$3) ON CONFLICT(site_id) DO UPDATE SET main_policy=CASE WHEN (site_comment_settings.main_policy='off')=(excluded.main_policy='off') THEN site_comment_settings.main_policy ELSE excluded.main_policy END,updated_at=excluded.updated_at",
    [site.id, p.comments ? "login" : "off", Date.now()],
  );
}
export async function putState(
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
  await syncMainPasscode(q, site.id, merged.audience === "passcode");
  return site;
}
export async function siteSharingChange(
  request: Request,
  siteId: string,
  input: { action: "custom" | "follow" | "stop" | "reset-passcode"; policy?: SharingPolicy; expectedRevision?: number },
) {
  return withPermissionCommit(
    request,
    siteId,
    input.action === "stop" ? "site.admins.manage" : "site.sharing.manage",
    async (q, site) => {
      await assertMutationOrigin(request, site);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (await getSiteSharing(site, q)).revision)
        fail("Sharing settings changed; refresh before trying again.", 409);
      if (input.action === "reset-passcode") {
        if ((await getSiteSharing(site, q)).policy.audience !== "passcode") fail("This link does not need a passcode", 409);
        await syncMainPasscode(q, site.id, true, true);
        await q("UPDATE site_sharing_state SET revision=revision+1,updated_at=$1 WHERE site_id=$2", [Date.now(), site.id]);
        await recordRbacAudit(q, site.tenantId, (await resolveSession(request))?.userId ?? null, "sharing.passcode.reset", site.id, "Reset main link passcode");
      } else if (input.action === "stop") {
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
