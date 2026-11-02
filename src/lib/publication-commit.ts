import "server-only";
import { createId, SlugConflictError, toSite, type InsertSiteInput, type InsertVersionInput, type InsertAuditInput } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type { Site } from "@/lib/types";
import { publicationPolicy } from "@/lib/publication-policy";
import { recordPublishedVersion } from "@/lib/publish-operation";

/** Production callers must authorize before entering this transaction-scoped writer. */
type PublicationContext =
  | { kind: "authorized"; request: Request; audit: InsertAuditInput }
  | { kind: "fixture"; audit?: InsertAuditInput };

export function assertPublicationFixture(): void {
  if (!process.env.VITEST) throw new Error("Publication requires an authorizationRequest; fixture writes are test-only");
}

function assertContext(context: PublicationContext): void {
  if (context.kind === "fixture") assertPublicationFixture();
}

export function translateSlugConflict(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if ((e?.code === "23505" && e.constraint === "sites_slug_key") || String(error).includes("UNIQUE constraint failed: sites.slug")) {
    throw new SlugConflictError();
  }
  throw error;
}

export async function writeCommitAudit(q: RbacQuery, audit: InsertAuditInput, now = Date.now()): Promise<void> {
  await q("INSERT INTO audit_log(id,site_id,version_id,action,editor_kind,actor_user_id,actor_anon_id,method,ip,user_agent,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [audit.id, audit.siteId, audit.versionId, audit.action, audit.editorKind, audit.actorUserId, audit.actorAnonId, audit.method, audit.ip, audit.userAgent, now]);
}

async function insertVersion(q: RbacQuery, siteId: string, version: InsertVersionInput, now: number): Promise<void> {
  if (version.packageMeta) await (await import("@/lib/package-processing")).assertPackageLease(q);
  await q("INSERT INTO versions(id,site_id,entry,file_count,byte_size,source,created_at,package_meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [version.id, siteId, version.entry, version.fileCount, version.byteSize, version.source, now, version.packageMeta ? JSON.stringify(version.packageMeta) : null]);
}

async function finishPublication(q: RbacQuery, site: Site, version: InsertVersionInput, context: PublicationContext, now: number, creating: boolean): Promise<void> {
  const audit = context.audit;
  if (audit) await writeCommitAudit(q, { ...audit, siteId: site.id, versionId: version.id }, now);
  const publishOfficial = async () => {
    await q("UPDATE sites SET official_version_id=$1,official_set_at=$2,official_set_by=$3,official_revision=official_revision+1 WHERE id=$4", [version.id, now, audit?.actorUserId ?? audit?.actorAnonId ?? null, site.id]);
    if (audit) await writeCommitAudit(q, { ...audit, id: createId("aud"), siteId: site.id, versionId: version.id, action: "official.set" }, now);
  };
  if (context.kind === "authorized") {
    await publicationPolicy.commitVersion({ q, site, versionId: version.id, request: context.request, creating, official: Boolean(version.official), publishOfficial });
  } else if (version.official) {
    // Fixtures describe already-published state without triggering request policy or recovery.
    await publishOfficial();
  }
}

/** The caller owns the transaction and has resolved identity, tenant and fork visibility. */
export async function writePublicationCreation(q: RbacQuery, input: InsertSiteInput, version: InsertVersionInput, context: PublicationContext): Promise<void> {
  assertContext(context);
  const now = Date.now();
  await q("INSERT INTO sites(id,slug,title,kind,current_version_id,created_at,updated_at,edit_token,anon_owner_id,owner_id,visibility,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)", [input.id, input.slug, input.title, input.kind, version.id, now, input.editToken, input.anonOwnerId ?? null, input.ownerId ?? null, input.visibility, input.tenantId ?? (input.ownerId ? "init" : "anonymous")]);
  await insertVersion(q, input.id, version, now);
  await q("INSERT INTO site_comment_settings(site_id,main_policy,reader_access,updated_at) VALUES($1,'login',1,$2)", [input.id, now]);
  const { initializeSharing } = await import("@/lib/sharing-defaults");
  const [created] = await q("SELECT * FROM sites WHERE id=$1", [input.id]);
  // Historical fixtures initialize sharing before designation; production initializes it
  // after the publication policy so the committed reader state governs the sharing scope.
  if (context.kind === "fixture") await initializeSharing(q, toSite(created), undefined, version.source === "fork" ? input.visibility : undefined);
  await finishPublication(q, toSite(created), version, context, now, true);
  if (context.kind === "authorized") {
    const [initialized] = await q("SELECT * FROM sites WHERE id=$1", [input.id]);
    await initializeSharing(q, toSite(initialized), context.request, version.source === "fork" ? input.visibility : undefined);
    await recordPublishedVersion(q, input.id, version.id, true);
  }
}

/** The caller has checked permission and the expected pointer under its transaction lock. */
export async function writePublicationVersion(q: RbacQuery, site: Site, version: InsertVersionInput, context: PublicationContext): Promise<void> {
  assertContext(context);
  const now = Date.now();
  await insertVersion(q, site.id, version, now);
  await q("UPDATE sites SET current_version_id=$1,updated_at=$2 WHERE id=$3", [version.id, now, site.id]);
  await finishPublication(q, site, version, context, now, false);
  if (context.kind === "authorized") await recordPublishedVersion(q, site.id, version.id);
}
