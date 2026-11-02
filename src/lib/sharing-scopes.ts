// Collection and folder moves require an unchanged impact digest before applying any sharing writes.
import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createId, rbacTransaction, toSite, type Row } from "@/lib/db";
import type { Site } from "@/lib/types";
import { sharingPolicySchema, type SharingPolicy, type SharingSource, type SharingPreview, type SharingImpact } from "@/lib/sharing-policy";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { requirePermission } from "@/lib/authz";
import { fail, fingerprint, rowPolicy, sharingSession } from "@/lib/sharing-common";
import { activeSource, getSiteSharing, ownedRows, scopeRow } from "@/lib/sharing-read";
import { putState } from "@/lib/sharing-mutations";
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
