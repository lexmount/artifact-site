import { recordPublishedVersion } from "@/lib/publish-operation";
import "server-only";
import { createId, rbacTransaction, toSite, type InsertSiteInput, type InsertAuditInput, type InsertVersionInput, type VersionCommit } from "@/lib/db";
import { AuthError, EditForbiddenError, assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { requirePermission } from "@/lib/authz";
import { resolveSession } from "@/lib/session";
import type { Permission } from "@/lib/rbac";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Session, Site } from "@/lib/types";
/** Revalidate local credentials under the same lock as membership/ownership changes. */
export async function assertSessionCurrent(q: RbacQuery, session: Pick<Session, "id" | "userId"> | null): Promise<void> {
    if (!session)
        return;
    const [user] = await q("SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL", [session.userId]);
    const oauth = session.id.startsWith("oat:");
    const personal = session.id.startsWith("pt:");
    const table = oauth ? "oauth_tokens" : personal ? "publish_tokens" : "sessions";
    const id = oauth ? session.id.slice(4) : personal ? session.id.slice(3) : session.id;
    const [credential] = await q(`SELECT id FROM ${table} WHERE id=$1 AND revoked_at IS NULL${personal ? "" : " AND expires_at>$2 AND absolute_expires_at>$2"}`, personal ? [id] : [id, Date.now()]);
    if (!user || !credential)
        throw new AuthError("The credential has expired or been revoked");
}
/** Only database work belongs in work; prepare request bodies and file bytes before calling. */
export async function withPermissionCommit<T>(request: Request, siteId: string, permission: Permission, work: (q: RbacQuery, site: Site, session: Session | null) => Promise<T>): Promise<T> {
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    return rbacTransaction(async (q) => {
        await assertSessionCurrent(q, session);
        const [row] = await q("SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL", [siteId]);
        if (!row)
            throw new EditForbiddenError("Site no longer exists");
        const site = toSite(row);
        // The route already audited entry into management mode; this is a pure recheck.
        await requirePermission(request, site, permission, session, false);
        return work(q, site, session);
    });
}
/** Version pointer, audit row and final permission check commit together after storage I/O. */
export async function commitAuthorizedVersion(siteId: string, version: InsertVersionInput, audit: InsertAuditInput, expected?: string): Promise<VersionCommit> {
    if (!audit.authorizationRequest) throw new Error("authorizationRequest is required for an authorized version commit");
    return withPermissionCommit(audit.authorizationRequest, siteId, version.official ? "site.version.official.manage" : audit.action === "rollback" ? "site.version.rollback" : "site.content.edit", async (q, site) => {
        if (expected && site.currentVersionId !== expected)
            return "stale";
        const now = Date.now();
        await q("INSERT INTO versions(id,site_id,entry,file_count,byte_size,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [version.id, siteId, version.entry, version.fileCount, version.byteSize, version.source, now]);
        await q("UPDATE sites SET current_version_id=$1,updated_at=$2 WHERE id=$3", [version.id, now, siteId]);
        await writeCommitAudit(q, { ...audit, siteId, versionId: version.id }, now);
        if (version.official) await designateOfficial(q, siteId, version.id, audit, now);
        await recordPublishedVersion(q, siteId, version.id);
        return "applied";
    });
}
export async function commitAuthorizedCreation(site: InsertSiteInput, version: InsertVersionInput, audit: InsertAuditInput): Promise<void> {
    if (!audit.authorizationRequest) throw new Error("authorizationRequest is required for an authorized creation commit");
    const request = audit.authorizationRequest;
    const session = await resolveSession(request);
    await assertCanCreate(request);
    const { creationTenant } = await import("@/lib/rbac-access");
    const { canForkSite } = await import("@/lib/share");
    await rbacTransaction(async (q) => {
        await assertSessionCurrent(q, session);
        const tenantId = await creationTenant(session?.userId ?? null, site.tenantId);
        if ((session?.userId ?? null) !== (site.ownerId ?? null))
            throw new EditForbiddenError("Creation identity changed");
        if (audit.sourceSiteId) {
            const [source] = await q("SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL", [audit.sourceSiteId]);
            if (!source || !(await canForkSite(request, toSite(source), session)))
                throw new EditForbiddenError("Source access was revoked");
        }
        const now = Date.now();
        await q("INSERT INTO sites(id,slug,title,kind,current_version_id,created_at,updated_at,edit_token,claim_token,anon_owner_id,owner_id,visibility,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$6,$7,NULL,$8,$9,$10,$11)", [site.id, site.slug, site.title, site.kind, version.id, now, site.ownerId ? "" : site.editToken, site.anonOwnerId ?? null, site.ownerId ?? null, site.visibility, tenantId]);
        await q("INSERT INTO versions(id,site_id,entry,file_count,byte_size,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [version.id, site.id, version.entry, version.fileCount, version.byteSize, version.source, now]);
        await writeCommitAudit(q, audit, now);
        if (version.official) await designateOfficial(q, site.id, version.id, audit, now);
        await recordPublishedVersion(q, site.id, version.id, true);
    }).catch(async (error) => {
        if ((error as {
            code?: string;
            constraint?: string;
        }).code === "23505" && (error as {
            constraint?: string;
        }).constraint?.includes("slug") || String(error).includes("UNIQUE constraint failed: sites.slug"))
            throw new (await import("@/lib/db")).SlugConflictError();
        throw error;
    });
}
export async function writeCommitAudit(q: RbacQuery, audit: InsertAuditInput, now = Date.now()): Promise<void> {
    await q("INSERT INTO audit_log(id,site_id,version_id,action,editor_kind,actor_user_id,actor_anon_id,method,ip,user_agent,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [audit.id, audit.siteId, audit.versionId, audit.action, audit.editorKind, audit.actorUserId, audit.actorAnonId, audit.method, audit.ip, audit.userAgent, now]);
}

/** Publication and its designation share the final authorization check and transaction. */
async function designateOfficial(q: RbacQuery, siteId: string, versionId: string, audit: InsertAuditInput, now: number): Promise<void> {
    await q("UPDATE sites SET official_version_id=$1,official_set_at=$2,official_set_by=$3,official_revision=official_revision+1 WHERE id=$4", [versionId, now, audit.actorUserId ?? audit.actorAnonId, siteId]);
    await writeCommitAudit(q, { ...audit, id: createId("aud"), siteId, versionId, action: "official.set" }, now);
}
