import "server-only";
import sharp from "sharp";
import { CommentImageError } from "@/lib/errors";
import { createId, rbacQuery, rbacTransaction, getSiteBySlug, toSite, type Row } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import { getStorage } from "@/lib/storage";
import { resolveSession, csrfSafe } from "@/lib/session";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";
import { auditCommentAccess, resolveCommentAccess } from "./access";
import { describeCommentPermissions } from "./permissions";
import { commentScopeSchema, type CommentAttachment, type CommentMessage, type CommentScope } from "./contracts";
import { fail } from "./store";

export const COMMENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const COMMENT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const scopeOf = (r: Row): CommentScope => ({siteId:String(r.site_id), versionId:String(r.version_id), entry:r.share_id == null ? {kind:"main"} : {kind:"share",shareId:String(r.share_id)}});
export const attachmentDTO = (r: Row): CommentAttachment => ({id:String(r.id),name:String(r.name),mimeType:r.mime_type as CommentAttachment["mimeType"],byteSize:Number(r.byte_size),width:Number(r.width),height:Number(r.height)});

/** Decode the pixels and encode a fresh raster: never serve caller-provided bytes/metadata. */
export async function normalizeCommentImage(bytes: Uint8Array, name: string) {
  if (!bytes.length || bytes.length > COMMENT_ATTACHMENT_MAX_BYTES) imageFail(413, "image_too_large", "Images must be at most 5 MB");
  const image = sharp(bytes, {limitInputPixels:16_000_000, failOn:"error", animated:false});
  try {
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) imageFail(400,"image_invalid","Only static PNG, JPEG and WebP images are supported");
    if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) imageFail(400,"image_invalid","Image dimensions are too large");
    const jpeg = metadata.format === "jpeg";
    const encode = (width?: number, height?: number) => {
      const encoder = image.clone().rotate();
      if (width && height) encoder.resize({width,height,fit:"inside",withoutEnlargement:true});
      return (jpeg ? encoder.jpeg({quality:85}) : encoder.png()).toBuffer({resolveWithObject:true});
    };
    let {data,info} = await encode();
    let resized = false;
    // Bound work and preserve aspect ratio. Source/decode limits above are unchanged.
    for (let attempt=0; data.length > COMMENT_ATTACHMENT_MAX_BYTES && attempt<3; attempt++) {
      const ratio = Math.min(0.8, Math.sqrt(COMMENT_ATTACHMENT_MAX_BYTES / data.length) * 0.9);
      const result = await encode(Math.max(1,Math.floor(info.width*ratio)),Math.max(1,Math.floor(info.height*ratio)));
      data=result.data;info=result.info;resized=true;
    }
    if (data.length > COMMENT_ATTACHMENT_MAX_BYTES) imageFail(413,"image_too_large","Decoded image is too large");
    const extension = jpeg ? ".jpg" : ".png";
    const safeName = name.replace(/[\u0000-\u001f\u007f/\\]/g,"_").replace(/\.[^.]*$/, "").slice(0,180) || "image";
    return {resized, bytes:data, name:safeName + extension, mimeType:jpeg ? "image/jpeg" as const : "image/png" as const, width:info.width,height:info.height};
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    return imageFail(400,"image_invalid","Invalid or oversized image");
  }
}

const preflightSessions = new WeakMap<Request, Awaited<ReturnType<typeof resolveSession>>>();
const imageFail = (status: number, code: CommentImageError["code"], message: string): never => { throw new CommentImageError(status, code, message); };
export async function preflightCommentImage(request: Request) {
  const cached = preflightSessions.get(request);
  if (cached) return cached;
  if (!csrfSafe(request)) fail(401,"Cross-site request rejected");
  const session = await resolveSession(request);
  await assertPresentedBearerAlive(request,session);
  if (!session) return fail(401,"Sign in to attach an image");
  preflightSessions.set(request, session);
  return session;
}
export async function uploadCommentAttachment(request: Request, slug: string, rawScope: unknown, file: File, onNormalized?: (resized: boolean) => void): Promise<CommentAttachment> {
  const session = await preflightCommentImage(request);
  checkRateLimit(request,Date.now(),`comment-image:${session.userId}`,60,20);
  const scope = commentScopeSchema.parse(rawScope);
  const site = await getSiteBySlug(slug);
  if (!site || site.id !== scope.siteId) return fail(404,"Discussion not found");
  const access = await resolveCommentAccess(request,site,scope,session);
  if (!describeCommentPermissions(access).canCreate) fail(403,"Image attachments are not allowed");
  await auditCommentAccess(request,site,access);
  if (file.size > COMMENT_ATTACHMENT_MAX_BYTES) imageFail(413,"image_too_large","Images must be at most 5 MB");
  const normalized = await normalizeCommentImage(new Uint8Array(await file.arrayBuffer()), file.name);
  const id = createId("cat"), now = Date.now();
  // rbacTransaction serializes this count + insert across replicas with a PG advisory lock.
  // Reserve a durable cleanup record before bytes are written, including interrupted uploads.
  await rbacTransaction(async q => {
    await assertSessionCurrent(q,session);
    if (!describeCommentPermissions(await resolveCommentAccess(request,site,scope,session)).canCreate) fail(403,"Image attachments are not allowed");
    const [count] = await q("SELECT COUNT(*) AS count FROM comment_attachments WHERE owner_id=$1 AND message_id IS NULL AND deleted_at IS NULL AND created_at>$2",[session.userId,now-COMMENT_ATTACHMENT_TTL_MS]);
    if (Number(count.count) >= 40) fail(429,"Too many pending image attachments");
    await q("INSERT INTO comment_attachments(id,site_id,version_id,share_id,owner_id,name,mime_type,byte_size,width,height,created_at) VALUES($1,$2,$3,$4,$5,$6,$11,$7,$8,$9,$10)",[id,site.id,scope.versionId,scope.entry.kind === "share" ? scope.entry.shareId : null,session.userId,normalized.name,normalized.bytes.length,normalized.width,normalized.height,now,normalized.mimeType]);
  });
  try {
    await getStorage().writeCommentAttachment(id,normalized.bytes,normalized.mimeType);
    const [row] = await rbacTransaction(async q => {
      await assertSessionCurrent(q,session);
      if (!describeCommentPermissions(await resolveCommentAccess(request,site,scope,session)).canCreate) fail(403,"Image attachments are not allowed");
      return q("UPDATE comment_attachments SET ready=1 WHERE id=$1 AND deleted_at IS NULL RETURNING *",[id]);
    });
    if (!row) return fail(409,"Image upload expired");
    onNormalized?.(normalized.resized);
    return attachmentDTO(row);
  } catch (error) {
    await rbacQuery("UPDATE comment_attachments SET deleted_at=$2 WHERE id=$1",[id,Date.now()]).catch(()=>{});
    throw error;
  }
}

export async function readCommentAttachment(request: Request, slug: string, id: string) {
  const site = await getSiteBySlug(slug), session = await resolveSession(request);
  await assertPresentedBearerAlive(request,session);
  // Independent read budget: a normal page can fetch many thumbnails at once.
  checkRateLimit(request, Date.now(), `comment-image-read:${session ? `user:${session.userId}` : `ip:${clientKey(request)}`}`, 240, 120);
  const [row] = await rbacQuery("SELECT * FROM comment_attachments WHERE id=$1 AND deleted_at IS NULL AND ready=1",[id]);
  if (!site || !row || row.site_id !== site.id) return fail(404,"Image not found");
  const access = await resolveCommentAccess(request,site,scopeOf(row),session);
  if (!describeCommentPermissions(access).canRead) fail(404,"Image not found");
  if (row.message_id == null) {
    if (row.owner_id !== session?.userId || Number(row.created_at) <= Date.now()-COMMENT_ATTACHMENT_TTL_MS) fail(404,"Image not found");
  } else {
    const [message] = await rbacQuery("SELECT id FROM comment_messages WHERE id=$1 AND deleted_at IS NULL",[String(row.message_id)]);
    if (!message) fail(404,"Image not found");
  }
  await auditCommentAccess(request,site,access);
  return {attachment:attachmentDTO(row), bytes:await getStorage().readCommentAttachment(id)};
}
export async function discardCommentAttachment(request: Request, slug: string, id: string) {
  if (!csrfSafe(request)) fail(401,"Cross-site request rejected");
  const session = await resolveSession(request);
  await assertPresentedBearerAlive(request,session);
  if (!session) return fail(401,"Sign in to remove an image");
  await rbacTransaction(async q => {
    await assertSessionCurrent(q,session);
    const [siteRow] = await q("SELECT * FROM sites WHERE slug=$1 AND deleted_at IS NULL",[slug]);
    const [row] = await q("SELECT * FROM comment_attachments WHERE id=$1 AND deleted_at IS NULL AND message_id IS NULL",[id]);
    if (!siteRow || !row || row.site_id !== siteRow.id || row.owner_id !== session.userId) fail(404,"Image not found");
    if (!describeCommentPermissions(await resolveCommentAccess(request,toSite(siteRow),scopeOf(row),session)).canRead) fail(404,"Image not found");
    await q("UPDATE comment_attachments SET deleted_at=$2 WHERE id=$1",[id,Date.now()]);
  });
  return {deleted:true};
}

/** Called after message creation/update under the same serialized RBAC transaction. */
export async function bindCommentAttachments(q: RbacQuery, scope: CommentScope, actorId: string, messageId: string, ids: string[]) {
  if (ids.length > 4 || new Set(ids).size !== ids.length) fail(400,"Choose up to four distinct images");
  for (const id of ids) {
    const [row] = await q("SELECT * FROM comment_attachments WHERE id=$1",[id]);
    if (!row || row.deleted_at != null || !Number(row.ready) || row.owner_id !== actorId || row.site_id !== scope.siteId || row.version_id !== scope.versionId || (row.share_id ?? null) !== (scope.entry.kind === "share" ? scope.entry.shareId : null) || (row.message_id != null && row.message_id !== messageId) || (row.message_id == null && Number(row.created_at) <= Date.now()-COMMENT_ATTACHMENT_TTL_MS)) imageFail(409,"image_unavailable","An image is unavailable in this discussion; upload it again");
    await q("UPDATE comment_attachments SET message_id=$2 WHERE id=$1",[id,messageId]);
  }
  const existing = await q("SELECT id FROM comment_attachments WHERE message_id=$1 AND deleted_at IS NULL",[messageId]);
  for (const row of existing) if (!ids.includes(String(row.id))) await q("UPDATE comment_attachments SET deleted_at=$2 WHERE id=$1",[String(row.id),Date.now()]);
}
export async function attachCommentImages(items: CommentMessage[], q: RbacQuery = rbacQuery) {
  if (!items.length) return;
  const rows = await q(`SELECT * FROM comment_attachments WHERE message_id IN (${items.map((_,i)=>`$${i+1}`).join(",")}) AND deleted_at IS NULL AND ready=1 ORDER BY created_at,id`,items.map(m=>m.id));
  for (const message of items) message.attachments = message.content.state === "deleted" ? [] : rows.filter(r=>r.message_id===message.id).map(attachmentDTO);
}
/** Tombstones persist after failed deletes, so a later sweep retries both local and S3 failures. */
export async function sweepCommentAttachments(dryRun = false) {
  const rows = await rbacTransaction(async q => {
    const candidates = await q(`SELECT a.id FROM comment_attachments a WHERE a.deleted_at IS NOT NULL OR (a.message_id IS NULL AND a.created_at<$1) OR (a.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comment_messages m WHERE m.id=a.message_id AND m.deleted_at IS NULL)) OR NOT EXISTS (SELECT 1 FROM sites s JOIN versions v ON v.site_id=s.id WHERE s.id=a.site_id AND v.id=a.version_id) LIMIT 100`,[Date.now()-COMMENT_ATTACHMENT_TTL_MS]);
    // Claim under the same lock as message binding; no attachment can be bound after this.
    if (!dryRun) for (const row of candidates) await q("UPDATE comment_attachments SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL",[String(row.id),Date.now()]);
    return candidates;
  });
  let deleted=0, errors=0;
  // Remote object deletion must not hold the global authorization transaction open.
  if (!dryRun) for (const row of rows) {
    try {
      await getStorage().removeCommentAttachment(String(row.id));
      await rbacQuery("DELETE FROM comment_attachments WHERE id=$1 AND deleted_at IS NOT NULL",[String(row.id)]);
      deleted++;
    } catch {errors++;}
  }
  return {candidates:rows.length,deleted,errors};
}
