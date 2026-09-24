import { creationTenant } from "@/lib/rbac-access";
// Verbs — the product's four actions over sites: create (upload), edit (new version),
// list, delete. Thin orchestration over db (metadata) + store (files) + upload (parsing).
import {
  addVersionAsCurrent,
  addVersionAsCurrentIfCurrentIs,
  claimSiteAudited as dbClaimSiteAudited,
  createEditToken,
  createId,
  createSlug,
  getSite,
  getSiteBySlug,
  getVersion,
  insertSiteWithVersion,
  listSiteSummaries,
  listVersions as listVersionRows,
  SlugConflictError,
  softDeleteSite,
  updateSiteTitle,
  type InsertAuditInput,
  type InsertSiteInput,
  type InsertVersionInput,
  type ListViewer,
} from "@/lib/db";
import { zipSync } from "fflate";
import type { AdminLogEntry, SiteKind, DocumentFormat } from "@/lib/types";
import { ensureAnonId } from "@/lib/anon";
import { anonIdFromRequest } from "@/lib/anon";
import { resolveSession } from "@/lib/session";
import { applyDocumentConversion } from "@/lib/convert";
import { getStorage } from "@/lib/storage";
import { copyVersionTree, measureVersion, removeVersion, writeFileToVersion, writeVersionFiles } from "@/lib/store";
import { normalizeUpload } from "@/lib/upload";
import { buildDocumentWrapperFiles, documentTitleOf } from "@/lib/document-site";
import { limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import { anonymousExpiresAt, assertQuotaRoom, quotaOwnerFor, quotaOwnerOf } from "@/lib/quota";
import { policy } from "@/lib/settings";
import type { EditInput, Site, SiteSummary, UploadInput, Version, VersionInfo, Visibility } from "@/lib/types";
import { auditRow, type AuditContext } from "@/lib/audit";
import { scheduleTextIndex, scheduleTextRetitle } from "@/lib/site-text";

/** Authorized assignment commits ownership and audit records together. */
export async function claimSiteRecorded(siteId: string, ownerId: string, ctx: AuditContext, adminLog?: AdminLogEntry): Promise<boolean> {
  return dbClaimSiteAudited(siteId, ownerId, auditRow(ctx, siteId, null, "claim"), adminLog);
}

/** Title metadata cap — a display name, not a document. */
export const MAX_TITLE_LENGTH = 120;

export function siteUrl(slug: string): string {
  return `/s/${slug}`;
}

/** A Site as anyone may see it: every per-site secret removed. Named so callers can hold the
 *  projection by type, and so widening it is a deliberate edit rather than a silent slip. */
/** `takenDownReason` stays out too: it is written for the owner and administrators, never for a reader. */
export type PublicSite = Omit<Site, "editToken" | "anonOwnerId" | "takenDownReason"> & { expiresAt: number | null };

/**
 * Public projection — strips both per-site secrets. Each one is, on its own, sufficient
 * authorization for some site:
 *
 *   editToken    anonymous management credential, never accepted on owned sites
 *   anonOwnerId  the creating browser's cookie value. lib/authz grants `owner` on an unclaimed
 *                site to whoever presents it (`safeEqual(viewer.anonId, site.anonOwnerId)`), and
 *                lib/anon reads that cookie verbatim — there is no signature to forge. So echoing
 *                it into a public GET handed any reader full control (delete included) of the site,
 *                and since the anonymous drop is the product's entry point, that is most sites.
 *
 * Neither may ever appear in a response that is not the creator's own.
 *
 * Written as an ALLOWLIST — naming what goes out — rather than as `delete`s off a clone, because
 * the deny-list version is what failed: it was written when there were two secrets, `anonOwnerId`
 * was added to Site later, and nothing made anyone come back here. A field added to Site from now
 * on is invisible to the public read until someone types it below, and the compiler makes that a
 * conscious step: no cast is involved, so an omission is a type error and an extra is one too.
 */
export function publicSite(site: Site): PublicSite {
  return {
    tenantId: site.tenantId,
    id: site.id,
    slug: site.slug,
    title: site.title,
    kind: site.kind,
    currentVersionId: site.currentVersionId,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    deletedAt: site.deletedAt,
    purgedAt: site.purgedAt,
    takenDownAt: site.takenDownAt,
    // Computed, not stored: when this anonymous site will be removed unless someone claims it.
    expiresAt: anonymousExpiresAt(site),
    ownerId: site.ownerId,
    visibility: site.visibility,
  };
}

/** Size of an upload before it is written — the quota check runs on this, ahead of any disk write. */
function bytesOf(files: readonly { bytes: Uint8Array }[]): number {
  return files.reduce((sum, f) => sum + f.bytes.byteLength, 0);
}

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** Insert a site + its first version atomically, regenerating the slug on the (astronomically rare)
 *  UNIQUE conflict. Files were already written under siteId/versionId, so a retry just re-inserts.
 *  An `audit` row, when given, is written in the same transaction as the site+version. */
async function insertSiteRetryingSlug(base: Omit<InsertSiteInput, "slug">, version: InsertVersionInput, audit?: InsertAuditInput): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = createSlug();
    try {
      await insertSiteWithVersion({ ...base, slug }, version, audit);
      return slug;
    } catch (error) {
      if (error instanceof SlugConflictError) continue;
      throw error;
    }
  }
  throw new Error("Could not assign a unique slug to the site");
}

/** Degree of openness: public is the loosest, private the strictest. Of two sources, take the stricter. */
const OPENNESS: Record<Visibility, number> = { public: 0, unlisted: 1, private: 2 };
function stricter(a: Visibility, b: Visibility): Visibility {
  return OPENNESS[a] >= OPENNESS[b] ? a : b;
}

/**
 * Turn a chunked-upload session into a version — the same bookkeeping as createSite, but **without
 * handling any content**.
 *
 * The bytes streamed into storage during the individual PUTs; only what filenames and sizes allow
 * happens here. So committing a 300MB project and committing a 3KB project cost the server exactly
 * the same: that is what makes projects with video hostable, rather than merely raising the ceiling.
 *
 * `measureVersion` asks for the **real** file count and byte size in storage and does not trust the
 * session's own ledger: a client can under-report or swap files midway, and the numbers written to
 * the database must come from what is actually sitting there.
 */
export async function commitUploadedVersion(
  request: Request,
  input: {
    session: { tenantId?: string; siteId: string; versionId: string; targetSlug?: string | null };
    entry: string;
    title?: string;
    official?: boolean;
    expectedVersionId?: string;
    ctx?: AuditContext;
    /** Given for a single-PDF chunked upload: at commit, the index.html wrapper is generated from it (the original has already streamed to disk and is never read back into memory). */
    document?: { format: DocumentFormat; name: string; relpath: string };
  },
): Promise<{ slug: string; url: string; title: string; kind: SiteKind; versionId: string; editToken?: string; expiresAt?: number | null; officialVersionId?: string | null; officialRevision?: number }> {
  const { session, entry } = input;
  const storage = getStorage();
  // Single PDF: the original has already streamed to its relpath under session.versionId; only the
  // generated index.html wrapper (a few KB) is written here, and the original is never read or
  // copied — a 250MB PDF is published exactly this way.
  if (input.document) {
    const meta = { format: input.document.format, originalName: input.document.name, originalRelpath: input.document.relpath };
    const size = await storage.sizeOf(session.siteId, session.versionId, input.document.relpath);
    // The original must really be in storage. A null here means the session's ledger and storage
    // disagree (expired and cleaned, or the write never landed); carrying on would only build a
    // wrapper pointing at an empty document site — better to fail here and let the route reclaim the session.
    if (size === null) throw new BadRequestError("The uploaded document is not in storage (the session may have expired or been cleaned up); please start the upload again");
    for (const f of buildDocumentWrapperFiles(meta, size, null)) {
      await storage.writeFileToVersion(session.siteId, session.versionId, f.relpath, f.bytes);
    }
  }
  const { fileCount, byteSize } = await storage.measureVersion(session.siteId, session.versionId);
  if (!fileCount) throw new Error("No files were written");
  // The total gets its final verdict **here**. The gate at PUT time only sees its own snapshot of the
  // ledger: two concurrent requests can both see "room left", both pass, and both end up in storage —
  // only what measureVersion counts at commit is the bytes actually sitting there. Once thrown, the
  // route's catch reclaims the session together with its bytes, leaving no oversized half-product.
  if (byteSize > limits.maxBytes) {
    throw new BadRequestError(`The project is ${Math.round(byteSize / 1048576)}MB, over the limit (${Math.round(limits.maxBytes / 1048576)}MB)`);
  }

  // Add a version to an existing site
  if (session.targetSlug) {
    const view = await getSiteView(session.targetSlug);
    if (!view) throw new BadRequestError("site not found");
    // The owner's caps get the same final verdict as the size limit: on a throw the route reclaims the bytes.
    await assertQuotaRoom(quotaOwnerOf(view.site), { bytes: byteSize });
    // siteId was already the target site's id when the session was opened (see /api/uploads), so the
    // files were written under the correct prefix from the start; nothing needs moving here — and
    // nothing **may** be moved: a move would copy 300MB within storage, exactly what this path avoids.
    if (view.site.id !== session.siteId) throw new BadRequestError("upload session does not belong to this site");
    const version: InsertVersionInput = { id: session.versionId, siteId: view.site.id, entry, fileCount, byteSize, source: "upload", official: input.official };
    if (input.ctx) {
      // Same path as editSite: version, current pointer and audit row land in one transaction. Written
      // separately, a failed audit insert would leave the version already live — the "who changed it"
      // column stays empty forever, and that is the very reason the audit exists.
      if (input.expectedVersionId) {
        const result = await addVersionAsCurrentIfCurrentIs(view.site.id, input.expectedVersionId, version, auditRow(input.ctx, view.site.id, session.versionId, "edit"));
        if (result !== "applied") {
          const latest = result === "gone" ? null : await getSite(view.site.id);
          throw Object.assign(new Error(latest ? "Version conflict" : "site not found"), { statusCode: latest ? 409 : 404, currentVersionId: latest?.currentVersionId });
        }
      } else {
        const ok = await addVersionAsCurrent(view.site.id, version, auditRow(input.ctx, view.site.id, session.versionId, "edit"));
        if (!ok) throw new BadRequestError("site not found");
      }
    } else {
      if (!(await addVersionAsCurrent(view.site.id, version))) throw new BadRequestError("site not found");
    }
    scheduleTextIndex(view.site.id, session.versionId);
    const updated = await getSite(view.site.id);
    return { slug: view.site.slug, url: siteUrl(view.site.slug), title: view.site.title, kind: view.site.kind, versionId: session.versionId, officialVersionId: updated?.officialVersionId, officialRevision: updated?.officialRevision };
  }

  // Create a new site
  const editToken = createEditToken();

  const { anonId } = ensureAnonId(request);
  const session_ = await resolveSession(request);
  await assertQuotaRoom(session_ ? { userId: session_.userId } : anonId ? { anonId } : null, { sites: 1, bytes: byteSize });
  const title = (input.title ?? "").trim()
    || (input.document ? documentTitleOf(input.document.name) : entry.replace(/\.html?$/i, ""))
    || "Untitled site";
  const version: InsertVersionInput = { id: session.versionId, siteId: session.siteId, entry, fileCount, byteSize, source: "upload", official: input.official };
  // Same audit path as createSite: a site built by chunked upload looks identical in the audit table to one from a one-shot upload.
  const audit = input.ctx ? auditRow(input.ctx, session.siteId, session.versionId, "create") : undefined;
  await insertSiteRetryingSlug(
    { tenantId: await creationTenant(session_?.userId ?? null,session.tenantId), id: session.siteId, title, kind: input.document ? "document" : "folder", editToken: session_ ? "" : editToken, anonOwnerId: session_ ? null : anonId, ownerId: session_?.userId ?? null, visibility: policy.defaultVisibility },
    version, audit,
  );
  scheduleTextIndex(session.siteId, session.versionId);
  const site = (await getSite(session.siteId))!;
  return { slug: site.slug, url: siteUrl(site.slug), title: site.title, kind: site.kind, versionId: session.versionId, officialVersionId: site.officialVersionId, officialRevision: site.officialRevision, ...(!site.ownerId ? {editToken} : {}), expiresAt: anonymousExpiresAt(site) };
}

/** Drop → link. Parse the input, write the first version to disk, then record the site. */
export async function createSite(
  input: UploadInput,
  owner: { tenantId?: string; anonOwnerId?: string | null; ownerId?: string | null } = {},
  ctx?: AuditContext,
): Promise<{ site: Site; version: Version }> {
  // Synchronous office→pdf preview (no-op for everything but office documents): runs BEFORE any
  // write, so the version is created once, complete — see lib/convert for the degrade contract.
  const normalized = await applyDocumentConversion(normalizeUpload(input));
  const siteId = createId("site");
  const versionId = createId("ver");
  const editToken = createEditToken();
  // Caps before any byte lands: the input already knows its size.
  await assertQuotaRoom(quotaOwnerFor(owner), { sites: 1, bytes: bytesOf(normalized.files) });
  // Files land first (with all path + limit guards); then site + version are recorded atomically.
  const { fileCount, byteSize } = await writeVersionFiles(siteId, versionId, normalized.files);
  const version: InsertVersionInput = { id: versionId, siteId, entry: normalized.entry, fileCount, byteSize, source: "upload", official: input.official };
  const audit = ctx ? auditRow(ctx, siteId, versionId, "create") : undefined;
  // Visibility is decided HERE, not by the column default, because it depends on which deployment
  // this is: the intranet opens up, the public internet stays shut until the owner says otherwise. See config.defaultVisibility.
  await insertSiteRetryingSlug({ tenantId: await creationTenant(owner.ownerId ?? null,owner.tenantId), id: siteId, title: normalized.title, kind: normalized.kind, editToken: owner.ownerId ? "" : editToken, anonOwnerId: owner.anonOwnerId ?? null, ownerId: owner.ownerId ?? null, visibility: policy.defaultVisibility }, version, audit);
  scheduleTextIndex(siteId, versionId); // searchable text follows the version; the response does not wait for it
  return { site: (await getSite(siteId))!, version: (await getVersion(versionId))! };
}

/**
 * Whole-file re-upload for a DOCUMENT site → a new immutable version that becomes current. This
 * is the document counterpart of editSite: documents have no text-edit shape (the wrapper is
 * generated, the original is binary), so "update" means dropping the file again — same slug, same
 * share links, version history and rollback working exactly like any other site.
 *
 * The new upload must itself be a document (pdf/office single file). The format may change
 * (a pdf replacing a pptx is fine — the wrapper is rebuilt per version); the site's TITLE is
 * deliberately left alone: it is the share-card identity, renames go through the rename route.
 */
export function replaceDocument(slug: string, input: UploadInput, ctx: AuditContext): Promise<{ site: Site; version: Version } | null>;
export function replaceDocument(slug: string, input: UploadInput, ctx: AuditContext, expectedVersionId: string | undefined): Promise<{ site: Site; version: Version } | VersionConflict | null>;
export async function replaceDocument(slug: string, input: UploadInput, ctx: AuditContext, expectedVersionId?: string): Promise<{ site: Site; version: Version } | VersionConflict | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  if (site.kind !== "document") throw new BadRequestError("Only document sites support whole-file re-upload; use the edit endpoint for site content");
  const normalized = await applyDocumentConversion(normalizeUpload(input));
  if (normalized.kind !== "document") throw new BadRequestError("A new version of a document site must still be a single pdf / pptx / ppt / docx / doc file");
  await assertQuotaRoom(quotaOwnerOf(site), { bytes: bytesOf(normalized.files) });
  const versionId = createId("ver");
  const { fileCount, byteSize } = await writeVersionFiles(site.id, versionId, normalized.files);
  const version: InsertVersionInput = { id: versionId, siteId: site.id, entry: normalized.entry, fileCount, byteSize, source: "upload", official: input.official };
  // Same atomicity contract as editSite: version + current-pointer + audit commit together; false
  // means the site was deleted mid-flight and the just-written files are the reconciler's to sweep.
  if (expectedVersionId) {
    const committed = await addVersionAsCurrentIfCurrentIs(site.id, expectedVersionId, version, auditRow(ctx, site.id, versionId, "edit"));
    if (committed !== "applied") {
      await removeVersion(site.id, versionId).catch(() => {});
      if (committed === "gone") return null;
      const latest = await getSite(site.id);
      return latest ? { conflict: true, currentVersionId: latest.currentVersionId } : null;
    }
    scheduleTextIndex(site.id, versionId);
    return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
  }
  const ok = await addVersionAsCurrent(site.id, version, auditRow(ctx, site.id, versionId, "edit"));
  if (!ok) return null;
  scheduleTextIndex(site.id, versionId);
  return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
}

/** replaceSiteContent's third outcome: somebody moved the site while the caller was editing. */
export interface VersionConflict {
  conflict: true;
  currentVersionId: string;
}

/**
 * Whole-tree replacement for HTML sites — the write-back half of the re-edit loop: an agent
 * exports the tree, edits in its own sandbox, and posts the whole thing back as ONE new immutable
 * version (many-file edits via /edit would mint a version per file and interleave with anyone
 * else's saves). `expectedVersionId` is the optimistic lock: pass the version the edit was based
 * on, and a concurrent save (web editor, another agent) surfaces as a conflict instead of being
 * silently buried. Omitting it keeps last-writer-wins for callers that genuinely want that.
 *
 * The site's KIND is deliberately immutable here: /edit's request shape and the wrapper logic key
 * off it, so a folder drop onto a single site is a caller mistake, answered loudly.
 */
export async function replaceSiteContent(
  slug: string,
  input: UploadInput,
  ctx: AuditContext,
  expectedVersionId?: string,
): Promise<{ site: Site; version: Version } | VersionConflict | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  if (site.kind === "document") throw new BadRequestError("Whole-file re-upload for document sites does not go through this path; re-upload in file mode instead");
  const normalized = normalizeUpload(input);
  if (normalized.kind === "document") throw new BadRequestError("A new version of an HTML site cannot be a single document file");
  if (normalized.kind !== site.kind) {
    throw new BadRequestError(`A site's shape cannot change: this is a ${site.kind === "single" ? "single-file" : "multi-file"} site, so the new version must also be ${site.kind === "single" ? "a single HTML file" : "a multi-file tree"}`);
  }
  await assertQuotaRoom(quotaOwnerOf(site), { bytes: bytesOf(normalized.files) });
  const versionId = createId("ver");
  const { fileCount, byteSize } = await writeVersionFiles(site.id, versionId, normalized.files);
  const version: InsertVersionInput = { id: versionId, siteId: site.id, entry: normalized.entry, fileCount, byteSize, source: "edit", official: input.official };
  const audit = auditRow(ctx, site.id, versionId, "edit");

  if (expectedVersionId) {
    const commit = await addVersionAsCurrentIfCurrentIs(site.id, expectedVersionId, version, audit);
    if (commit === "applied") {
      scheduleTextIndex(site.id, versionId);
      return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
    }
    // Either way the just-written tree is dead weight; sweep it now rather than leaving it to the
    // reconciler, but never let the cleanup mask the real answer.
    await removeVersion(site.id, versionId).catch(() => {});
    if (commit === "gone") return null;
    // The winner's id is what makes a 409 actionable — the caller re-bases on it. If the site
    // vanished between the failed CAS and this read, there is nothing to re-base onto, so answer
    // "gone" like the branch above rather than a conflict carrying an id nobody can use.
    const latest = await getSite(site.id);
    if (!latest) return null;
    return { conflict: true, currentVersionId: latest.currentVersionId };
  }

  const ok = await addVersionAsCurrent(site.id, version, audit);
  if (!ok) return null;
  scheduleTextIndex(site.id, versionId);
  return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
}

/**
 * The read half of the re-edit loop: the CURRENT version's whole tree as one zip, plus the
 * version id the caller must echo back as `expected_version` when posting the edit — export and
 * lock base come from the same snapshot, so the agent can never base an edit on one version and
 * lock against another.
 */
export async function exportSiteZip(slug: string, versionId?: string): Promise<{ site: Site; versionId: string; filename: string; bytes: Uint8Array } | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  const version = await getVersion(versionId ?? site.currentVersionId);
  if (!version || version.siteId !== site.id) return null;
  const storage = getStorage();
  const entries: Record<string, Uint8Array> = {};
  for (const relpath of await storage.list(site.id, version.id)) {
    entries[relpath] = await storage.read(site.id, version.id, relpath);
  }
  // level 6: the default speed/size balance; these trees are ≤50MB by upload limits.
  const bytes = zipSync(entries, { level: 6 });
  return { site, versionId: version.id, filename: `${site.slug}-${version.id}.zip`, bytes };
}

/**
 * In-place edit → a new immutable version that becomes current. Single sites replace the
 * whole entry document ({content}); folder sites copy the prior tree and overwrite one file
 * ({path, content}), leaving every earlier version's files untouched on disk.
 */
export async function editSite(
  slug: string,
  edit: EditInput,
  ctx: AuditContext,
  expectedVersionId?: string,
  baseVersionId?: string,
): Promise<{ site: Site; version: Version } | VersionConflict | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  // Server-side boundary, not just hidden UI: the wrapper page is generated and the original is
  // binary — a text edit of either only corrupts the site. Updating a document = re-uploading
  // the whole file to POST /api/sites/:slug/versions (replaceDocument below).
  if (site.kind === "document") throw new BadRequestError("Document sites cannot be edited online; re-upload the whole file with POST /api/sites/<slug>/versions to publish a new version");
  const current = await getVersion(baseVersionId ?? site.currentVersionId);
  if (!current || current.siteId !== site.id) return null;
  const versionId = createId("ver");
  let version: InsertVersionInput;

  if (site.kind === "single") {
    const content = (edit as { content?: unknown }).content;
    if (typeof content !== "string") throw new BadRequestError("Editing a single-file site requires a content field");
    const bytes = encode(content);
    await assertQuotaRoom(quotaOwnerOf(site), { bytes: bytes.byteLength });
    const { fileCount, byteSize } = await writeVersionFiles(site.id, versionId, [{ relpath: current.entry, bytes }]);
    version = { id: versionId, siteId: site.id, entry: current.entry, fileCount, byteSize, source: "edit" };
  } else {
    const { path, content } = edit as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || typeof content !== "string") throw new BadRequestError("Editing a folder site requires path and content fields");
    await copyVersionTree(site.id, current.id, versionId);
    await writeFileToVersion(site.id, versionId, path, encode(content)); // resolveInside guards the path; per-file cap enforced inside
    const { fileCount, byteSize } = await measureVersion(site.id, versionId);
    // Post-write total cap: the copied tree + the new file must still fit the aggregate limits.
    // On violation, roll back the just-written version dir (currentVersion still points at the old one).
    if (byteSize > limits.maxBytes || fileCount > limits.maxFiles) {
      // Roll back the new version dir, but never let a delete failure mask the real (size) error.
      await removeVersion(site.id, versionId).catch((err) => {
        console.error(`[editSite] rollback of oversized version ${versionId} failed:`, err);
      });
      throw new BadRequestError(`The site is too large after this edit: ${fileCount} files, ${Math.round(byteSize / 1048576)}MB in total, over the per-site limit (${Math.round(limits.maxBytes / 1048576)}MB / ${limits.maxFiles} files)`);
    }
    // The owner's cap, against the measured size (the copied tree plus the changed file). Same rollback.
    try {
      await assertQuotaRoom(quotaOwnerOf(site), { bytes: byteSize });
    } catch (error) {
      await removeVersion(site.id, versionId).catch(() => {});
      throw error;
    }
    version = { id: versionId, siteId: site.id, entry: current.entry, fileCount, byteSize, source: "edit" };
  }

  // Atomically add the version + advance current + record who did it; false = the site was deleted
  // mid-edit (its just-written files are now the reconciler's to sweep). The audit row shares the
  // version's transaction, so a committed edit always has a trail and vice versa.
  const audit = auditRow(ctx, site.id, versionId, "edit");

  // Optimistic lock, same contract as replaceSiteContent. This path carries it because it is the
  // one a SINGLE-file site takes: an agent told to "base the edit on versionId X" would otherwise
  // have its guard silently ignored here and quietly bury whatever landed in between — the caller
  // believing it was protected is worse than having no lock at all.
  if (expectedVersionId) {
    const commit = await addVersionAsCurrentIfCurrentIs(site.id, expectedVersionId, version, audit);
    if (commit === "applied") {
      scheduleTextIndex(site.id, versionId);
      return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
    }
    await removeVersion(site.id, versionId).catch(() => {}); // the loser's tree is dead weight
    if (commit === "gone") return null;
    // The winner's id is what makes a 409 actionable — the caller re-bases on it. If the site
    // vanished between the failed CAS and this read, there is nothing to re-base onto, so answer
    // "gone" like the branch above rather than a conflict carrying an id nobody can use.
    const latest = await getSite(site.id);
    if (!latest) return null;
    return { conflict: true, currentVersionId: latest.currentVersionId };
  }

  const ok = await addVersionAsCurrent(site.id, version, audit);
  if (!ok) return null;
  scheduleTextIndex(site.id, versionId);
  return { site: (await getSite(site.id))!, version: (await getVersion(versionId))! };
}

/**
 * The site directory. Public rows only unless `viewer` proves the row is theirs — see
 * listSiteSummaries. Called with no argument it is the stranger's view, which is what any
 * unauthenticated surface must use.
 */
export async function listSites(viewer?: ListViewer, options?: { withViews?: boolean; ownedOnly?: boolean; limit?: number }): Promise<SiteSummary[]> {
  return listSiteSummaries(viewer, options);
}

/**
 * The list viewer behind a request: the signed-in account and/or this browser's anonymous id, the
 * same two credentials lib/authz.ts recognises as ownership. Resolved here rather than at each call
 * site so "who may see their own unlisted sites" has exactly one definition.
 */
export async function listViewerFromRequest(request: Request): Promise<ListViewer> {
  const session = await resolveSession(request);
  return { userId: session?.userId ?? null, anonId: anonIdFromRequest(request) };
}

/** Live site + its currently-served version, or null if missing/deleted. */
export async function getSiteView(slug: string, requestedVersionId?: string): Promise<{ site: Site; version: Version } | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  const version = await getVersion(requestedVersionId ?? site.currentVersionId);
  return version && version.siteId === site.id ? { site, version } : null;
}

/**
 * Soft-delete only. The files stay for `config.deletedRetentionMs` so an administrator can undo a
 * mistaken delete; `purgeDeletedSites` (lib/maintenance, run lazily from the create routes and
 * from the admin console) removes them once the window has passed. Returns false if already gone.
 */
export async function deleteSite(slug: string, ctx?: AuditContext): Promise<boolean> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return false;
  if (ctx?.authorizationRequest) {
    const { withPermissionCommit, writeCommitAudit } = await import("@/lib/authorized-commit");
    await withPermissionCommit(ctx.authorizationRequest,site.id,"site.delete",async q => {
      await q("UPDATE sites SET deleted_at=$1,updated_at=$1 WHERE id=$2",[Date.now(),site.id]);
      await writeCommitAudit(q,auditRow(ctx,site.id,null,"delete"));
    });
  } else await softDeleteSite(site.id);
  return true;
}

/**
 * Save as new site — duplicate a site into an independent one. The fork is a brand-new site (new id +
 * new slug) whose first version is a copy of the SOURCE's CURRENT version tree; history is NOT
 * copied (the fork starts at v1). Editing either side afterwards never touches the other, since
 * each site owns its own on-disk directory. Returns null if the source is missing/deleted.
 */
export async function forkSite(
  slug: string,
  // Required, with no default: `{}` is a legitimate answer (the lib-level tests want a fork owned by
  // nobody) but it has to be TYPED OUT. A default here reads as "ownership is optional" and would
  // let a future caller mint an unowned site by forgetting an argument — the exact shape of the bug
  // this function is being fixed for. Unowned copies require authorized ownership transfer.
  owner: { tenantId?: string; anonOwnerId?: string | null; ownerId?: string | null },
  ctx?: AuditContext,
): Promise<{ site: Site; version: Version } | null> {
  const source = await getSiteBySlug(slug);
  if (!source || source.deletedAt) return null;
  const current = await getVersion(source.currentVersionId);
  if (!current) return null;

  const siteId = createId("site");
  const versionId = createId("ver");
  // The fork is independently owned: it gets its OWN fresh edit token, returned to the forker, and
  // its OWN ownership markers — never the source's, which is why `owner` is a parameter and not
  // copied from `source`. Same two exclusive markers createSite takes (see there).
  const editToken = createEditToken();

  // A fork is a new site holding a copy of the current version: both caps, before the copy (so an
  // obviously oversized one costs no I/O) and again on the measured copy, which is the number the
  // version is recorded with — the pre-check used the source's stored size.
  await assertQuotaRoom(quotaOwnerFor(owner), { sites: 1, bytes: current.byteSize });
  // Copy the source's current snapshot into the fork's own site dir (cross-site copy).
  await copyVersionTree(source.id, current.id, versionId, siteId);
  const { fileCount, byteSize } = await measureVersion(siteId, versionId);
  try {
    await assertQuotaRoom(quotaOwnerFor(owner), { sites: 1, bytes: byteSize });
  } catch (error) {
    await removeVersion(siteId, versionId).catch(() => {});
    throw error;
  }
  const version: InsertVersionInput = { id: versionId, siteId, entry: current.entry, fileCount, byteSize, source: "fork" };
  const audit = ctx ? { ...auditRow(ctx, siteId, versionId, "fork"), sourceSiteId: source.id } : undefined;
  // Take the stricter of "the source site" and "this deployment's default for new sites", and fix it
  // at INSERT time. Two reasons:
  //   · The fork is a new site, and on the public internet a new site should be private — otherwise
  //     forking becomes a back door around the deployment's posture, the copy would also land in the
  //     home directory, and the person who pressed "Save as new site" never chose "public".
  //   · Inserting first and calling updateSiteSharing afterwards leaves a window in which the copy of a
  //     private source is public. A single write leaves no window.
  const visibility = stricter(source.visibility, policy.defaultVisibility);
  await insertSiteRetryingSlug({ tenantId: await creationTenant(owner.ownerId ?? null,owner.tenantId), id: siteId, title: `${source.title} (copy)`, kind: source.kind, editToken: owner.ownerId ? "" : editToken, anonOwnerId: owner.anonOwnerId ?? null, ownerId: owner.ownerId ?? null, visibility }, version, audit);
  scheduleTextIndex(siteId, versionId);
  return { site: (await getSite(siteId))!, version: (await getVersion(versionId))! };
}

/** Rename — set a site's display title (trimmed, non-empty, ≤120 chars). Slug is untouched. */
export async function renameSite(slug: string, rawTitle: string, ctx?: AuditContext): Promise<Site | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  const title = rawTitle.trim();
  if (!title) throw new BadRequestError("The title cannot be empty");
  if (title.length > MAX_TITLE_LENGTH) throw new BadRequestError(`The title is too long (at most ${MAX_TITLE_LENGTH} characters)`);
  if (ctx?.authorizationRequest) {
    const { withPermissionCommit, writeCommitAudit } = await import("@/lib/authorized-commit");
    await withPermissionCommit(ctx.authorizationRequest,site.id,"site.rename",async q => {
      await q("UPDATE sites SET title=$1,updated_at=$2 WHERE id=$3",[title,Date.now(),site.id]);
      await writeCommitAudit(q,auditRow(ctx,site.id,null,"rename"));
    });
  } else await updateSiteTitle(site.id, title);
  scheduleTextRetitle(site.id, title); // the title is indexed too; the body need not be read again
  return getSite(site.id);
}

/** Version history — every version of a site, newest first, each flagged with whether it is current. */
export async function listVersions(slug: string): Promise<VersionInfo[] | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  const rows = await listVersionRows(site.id);
  return rows.map((version, index) => ({ ...version, number: rows.length - index, current: version.id === site.currentVersionId, official: version.id === site.officialVersionId }));
}

/**
 * Roll back — forward-only restore. Creates a NEW immutable version whose tree is a copy of the chosen
 * earlier version, then points current at it. History is never mutated: the old version dirs stay
 * on disk and remain listable. Returns null if the site or the target version is unknown, or if the
 * version id belongs to a different site.
 */
export async function rollbackTo(slug: string, versionId: string, ctx?: AuditContext): Promise<{ site: Site; version: Version } | null> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return null;
  const target = await getVersion(versionId);
  if (!target || target.siteId !== site.id) return null;
  // A rollback is a new version (a copy of the old one), so it draws on the storage cap too:
  // pre-checked on the stored size, settled on the measured copy.
  await assertQuotaRoom(quotaOwnerOf(site), { bytes: target.byteSize });
  const newVersionId = createId("ver");
  await copyVersionTree(site.id, target.id, newVersionId);
  const { fileCount, byteSize } = await measureVersion(site.id, newVersionId);
  try {
    await assertQuotaRoom(quotaOwnerOf(site), { bytes: byteSize });
  } catch (error) {
    await removeVersion(site.id, newVersionId).catch(() => {});
    throw error;
  }
  const audit = ctx ? auditRow(ctx, site.id, newVersionId, "rollback") : undefined;
  const ok = await addVersionAsCurrent(site.id, { id: newVersionId, siteId: site.id, entry: target.entry, fileCount, byteSize, source: "rollback" }, audit);
  if (!ok) return null;
  scheduleTextIndex(site.id, newVersionId);
  return { site: (await getSite(site.id))!, version: (await getVersion(newVersionId))! };
}
