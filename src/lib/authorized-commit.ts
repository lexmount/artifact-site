import { writePublicationCreation, writePublicationVersion, translateSlugConflict } from "@/lib/publication-commit";
export { writeCommitAudit } from "@/lib/publication-commit";
import "server-only";
import { config } from "@/lib/config";
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
export async function withPermissionCommit<T>(request: Request, siteId: string, permission: Permission, work: (q: RbacQuery, site: Site, session: Session | null) => Promise<T>, options: { lockSite?: boolean } = {}): Promise<T> {
    const session = await resolveSession(request);
    await assertPresentedBearerAlive(request, session);
    return rbacTransaction(async (q) => {
        await assertSessionCurrent(q, session);
        // Only publication callbacks opt in: they use q for every write. Generic callbacks
        // may use another connection whose FK check would block on its own outer row lock.
        const [row] = await q(`SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL${options.lockSite && config.dbDriver === "postgres" ? " FOR UPDATE" : ""}`, [siteId]);
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
        await writePublicationVersion(q, site, version, { kind: "authorized", audit, request: audit.authorizationRequest! });
        return "applied";
    }, { lockSite: true });
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
            // Source sharing may change while the copied files are being prepared.
            site = { ...site, visibility: await (await import("@/lib/sharing-defaults")).forkVisibilityCeiling(toSite(source), site.visibility, q) };
        }
        await writePublicationCreation(q, { ...site, tenantId, editToken: site.ownerId ? "" : site.editToken }, version, { kind: "authorized", audit, request });
    }).catch(translateSlugConflict);
}
