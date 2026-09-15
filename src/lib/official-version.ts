import "server-only";
import { toSite, createId } from "@/lib/db";
import { withPermissionCommit } from "@/lib/authorized-commit";
import { config } from "@/lib/config";
import type { AuditContext } from "@/lib/audit";

/** A designation is metadata, never a content edit or a move of the latest pointer. */
export async function setOfficialVersion(siteId: string, versionId: string | null, ctx: AuditContext & { authorizationRequest: Request }, expectedRevision?: number) {
  if (!ctx.authorizationRequest) throw new Error("authorizationRequest is required to designate an official version");
  const result = await withPermissionCommit(ctx.authorizationRequest, siteId, "site.version.official.manage", async q => {
    const [row] = await q(`SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL${config.dbDriver === "postgres" ? " FOR UPDATE" : ""}`, [siteId]);
    if (!row) throw Object.assign(new Error("site not found"), { statusCode: 404 });
    const site = toSite(row);
    if (expectedRevision !== undefined && expectedRevision !== site.officialRevision)
      throw Object.assign(new Error("Official version changed; refresh before trying again"), { statusCode: 409 });
    if (versionId && !(await q("SELECT id FROM versions WHERE id=$1 AND site_id=$2", [versionId, siteId])).length)
      throw Object.assign(new Error("version not found"), { statusCode: 404 });
    const previousOfficialVersionId = site.officialVersionId ?? null;
    if (previousOfficialVersionId === versionId) return { ...site, previousOfficialVersionId };
    const now = Date.now();
    const actor = ctx.actor.userId ?? ctx.actor.anonId;
    const [updated] = await q("UPDATE sites SET official_version_id=$1, official_set_at=$2, official_set_by=$3, official_revision=official_revision+1 WHERE id=$4 RETURNING *", [versionId, versionId ? now : null, versionId ? actor : null, siteId]);
    await q("INSERT INTO audit_log (id,site_id,version_id,action,editor_kind,actor_user_id,actor_anon_id,method,ip,user_agent,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [createId("aud"), siteId, versionId ?? previousOfficialVersionId, versionId ? "official.set" : "official.clear", ctx.actor.kind, ctx.actor.userId, ctx.actor.anonId, ctx.method, ctx.ip, ctx.userAgent, now]);
    return { ...toSite(updated), previousOfficialVersionId };
  });
  return result;
}
