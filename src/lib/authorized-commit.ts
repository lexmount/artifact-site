import "server-only";
import { rbacTransaction, toSite, type InsertSiteInput, type InsertAuditInput, type InsertVersionInput, type VersionCommit } from "@/lib/db";
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
export async function withPermissionCommit<T>(request: Request, siteId: string, permission: Permission, work: (q: RbacQuery, site: Site) => Promise<T>): Promise<T> {
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
        return work(q, site);
    });
}
/** Version pointer, audit row and final permission check commit together after storage I/O. */
export async function commitAuthorizedVersion(siteId: string, version: InsertVersionInput, audit: InsertAuditInput, expected?: string): Promise<VersionCommit> {
    return withPermissionCommit(audit.authorizationRequest!, siteId, audit.action === "rollback" ? "site.version.rollback" : "site.content.edit", async (q, site) => {
        if (expected && site.currentVersionId !== expected)
            return "stale";
        const now = Date.now();
        await q("INSERT INTO versions(id,site_id,entry,file_count,byte_size,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [version.id, siteId, version.entry, version.fileCount, version.byteSize, version.source, now]);
        await q("UPDATE sites SET current_version_id=$1,updated_at=$2 WHERE id=$3", [version.id, now, siteId]);
        await writeCommitAudit(q, { ...audit, siteId, versionId: version.id }, now);
        return "applied";
    });
}
export async function commitAuthorizedCreation(site: InsertSiteInput, version: InsertVersionInput, audit: InsertAuditInput): Promise<void> {
    const request = audit.authorizationRequest!;
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
