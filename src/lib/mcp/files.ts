import { createHash } from "node:crypto";
import { packageLease, type PackageProgress } from "@/lib/package-processing";
import { recordUploadedFile } from "@/lib/upload-session";
import { packageJobStatus, readablePackageJob } from "@/lib/package-jobs";
import { PACKAGE_ORIGINAL } from "@/lib/package-contract";
import { requirePermission } from "@/lib/authz";
import { assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { creationTenant } from "@/lib/rbac-access";
import { getSiteView } from "@/lib/sites";
import { randomUUID } from "node:crypto";
import { compareUploadSessionFiles, createId, insertUploadSession, listUploadSessionsForTarget } from "@/lib/db";
import { discardUploadSession, getUploadSession, ownerKeyFor, type UploadSession } from "@/lib/upload-session";
import { getStorage, safeRelativePath } from "@/lib/storage";
import { BadRequestError } from "@/lib/errors";
import { limits } from "@/lib/config";
import { callApi } from "./api";
import { sha256hex } from "@/lib/crypto";

// Metadata-only sentinels distinguish sealed chunks from successful assembly; neither is a storage object.
const COMPLETE = "mcp-complete";
const ASSEMBLED = "mcp-assembled";
export const CHUNK_BYTES = 256 * 1024;
export const ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const missing = () => Object.assign(new Error("Upload does not exist or has expired"), { statusCode: 404 });
const conflict = () => Object.assign(new Error("Concurrent upload; retry the same chunk sequentially"), { statusCode: 409 });
function invalidChunk(code: string, error: string, nextIndex: number) {
  return Object.assign(new Error(error), { statusCode: 409, data: { error, status: 409, code, nextIndex, retryable: false } });
}
export function decodeChunk(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new BadRequestError("Invalid base64");
  const data = Buffer.from(value, "base64");
  if (data.length > CHUNK_BYTES) throw new BadRequestError(`Chunk exceeds ${CHUNK_BYTES} bytes`);
  return data;
}
async function owner(request: Request) {
  const key = await ownerKeyFor(request);
  if (!key) throw missing();
  return key;
}
async function startFile(key: string, versionId: string, file: string): Promise<UploadSession> {
  const parent = await getUploadSession(versionId, key);
  if (!parent) throw missing();
  const relative = safeRelativePath(file, parent.packageOptions ? "package" : "website");
  // Parts are private staging rows: targetSlug holds the parent upload id; title holds its file path.
  const fileUploadId = `mcp_${sha256hex(`${versionId}:${relative}`)}`;
  const existing = await getUploadSession(fileUploadId, `mcp-parts:${key}`);
  if (existing) return existing;
  const session: UploadSession = { versionId: fileUploadId, siteId: createId("site"), ownerKey: `mcp-parts:${key}`, targetSlug: versionId, title: relative, files: [], createdAt: Date.now() };
  try { await insertUploadSession(session); return session; }
  catch (error) {
    // Two replicas may receive the first chunk together. Reuse only the matching owned row.
    const raced = await getUploadSession(fileUploadId, `mcp-parts:${key}`);
    if (!raced) throw error;
    return raced;
  }
}
async function putChunk(session: UploadSession, index: number, data: Buffer) {
  const id = session.versionId;
  const storage = getStorage();
  const count = session.files.filter(f => f.relpath !== COMPLETE && f.relpath !== ASSEMBLED).length;
  if (index < count) {
    const existing = await storage.read(session.siteId, id, session.files[index].relpath);
    if (Buffer.from(existing).equals(data)) return { nextIndex: count, bytes: session.files.reduce((n, f) => n + f.bytes, 0) };
    throw invalidChunk("chunk_mismatch", "This chunk index already contains different bytes; cancel the upload and start over to change it", count);
  }
  if (session.files.some(f => f.relpath === COMPLETE)) throw invalidChunk("file_finalized", "File already finalized in this upload; cancel the upload and start over to change it", count);
  if (index !== count) throw invalidChunk("chunk_index", "Wrong chunk index; send the next chunk at nextIndex", count);
  // Keep staging metadata bounded independently of the deployment's project-file limit.
  const maxChunks = Math.max(2000, Math.ceil(Math.min(limits.maxFileBytes, limits.maxBytes) / CHUNK_BYTES));
  if (count >= maxChunks) throw new BadRequestError(`Too many chunks for one file (limit ${maxChunks}); cancel and restart using ${CHUNK_BYTES}-byte chunks`);
  const total = session.files.reduce((n, f) => n + f.bytes, 0) + data.length;
  if (total > limits.maxBytes) throw new BadRequestError("The whole project exceeds the deployment limit");
  // Chunk parts are not project files; maxFiles is enforced when assembling into the parent.
  if (total > limits.maxFileBytes) throw new BadRequestError("File exceeds the deployment limit");
  const relpath = `${randomUUID()}.part`;
  await storage.writeFileToVersion(session.siteId, id, relpath, data);
  const updated = [...session.files, { relpath, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }];
  if (!await compareUploadSessionFiles(id, session.files, updated)) throw conflict();
  session.files = updated; // Reuse the successful CAS snapshot for finalization; no new owner/session lookup.
  return { nextIndex: index + 1, bytes: total };
}
async function finishFile(request: Request, session: UploadSession, chunkCount: number) {
  const id = session.versionId;
  const chunks = session.files.filter(f => f.relpath !== COMPLETE && f.relpath !== ASSEMBLED);
  if (chunks.length !== chunkCount || chunkCount < 1) throw new BadRequestError("Chunk count mismatch");
  if (session.files.some(f => f.relpath === ASSEMBLED)) return { relpath: session.title!, bytes: chunks.reduce((sum, f) => sum + f.bytes, 0) };
  // Seal before assembly: a lost final response can be retried, but no more bytes may append.
  if (!session.files.some(f => f.relpath === COMPLETE) && !await compareUploadSessionFiles(id, session.files, [...session.files, { relpath: COMPLETE, bytes: 0 }])) throw conflict();
  // Snapshot the exact parts. Concurrent append cannot modify these uniquely named objects.
  const storage = getStorage(); let index = 0;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    try { request.signal.throwIfAborted(); if (index === chunks.length) { controller.close(); return; }
      controller.enqueue(await storage.read(session.siteId, id, chunks[index++].relpath));
    } catch (error) { controller.error(error); }
  } });
  const result = await callApi(request, "upload_file", { versionId: session.targetSlug!, file: session.title!, raw: stream });
  const sealed = [...chunks, { relpath: COMPLETE, bytes: 0 }];
  if (!await compareUploadSessionFiles(id, sealed, [...sealed, { relpath: ASSEMBLED, bytes: 0 }])) {
    const latest = await getUploadSession(id, session.ownerKey);
    if (!latest?.files.some(f => f.relpath === ASSEMBLED)) throw conflict();
  }
  // Retain sealed parts for final-chunk retries; commit/cancel or the existing six-hour sweep reclaims them.
  return result;
}
export async function cancelUpload(request: Request, id: string) {
  const key = await owner(request);
  const job = await packageJobStatus(id, key);
  if (job && job.status !== "failed") throw Object.assign(new Error("Submitted package processing cannot be cancelled; inspect upload_status"), { statusCode: 409 });
  if (!await getUploadSession(id, key)) throw missing();
  await discardUploadSession(id);
  for (const child of await listUploadSessionsForTarget(`mcp-parts:${key}`, id)) await discardUploadSession(child.versionId);
  return { cancelled: true };
}

export async function writeFileChunk(request: Request, uploadId: string, path: string, index: number, base64: string, final: boolean) {
  return writeBinaryChunk(request, uploadId, path, index, decodeChunk(base64), final);
}

export async function writeBinaryChunk(request: Request, uploadId: string, path: string, index: number, data: Buffer, final: boolean) {
  if (!Number.isSafeInteger(index) || index < 0 || data.length > ARCHIVE_CHUNK_BYTES) throw new BadRequestError("Invalid chunk index or size");
  const key = await owner(request);
  const parent = await getUploadSession(uploadId, key);
  if (!parent) throw missing();
  const authRequest = request;
  const identity = await resolveSession(authRequest);
  await assertPresentedBearerAlive(authRequest, identity);
  if (parent.targetSlug) {
    const view = await getSiteView(parent.targetSlug);
    if (!view) throw missing();
    await requirePermission(authRequest, view.site, "site.content.edit", identity, false);
  } else {
    await assertCanCreate(authRequest);
    await creationTenant(identity?.userId ?? null, parent.tenantId);
  }
  if (parent.packageOptions?.source === "archive" && path !== "original") throw new BadRequestError("Archive chunks must use path original");
  const receive = async () => {
    if (parent.packageOptions?.source === "archive" && parent.files.length) throw new BadRequestError("The uploaded archive is immutable; start a new session to change it");
    const session = await startFile(key, uploadId, path);
    if (parent.packageOptions?.source === "archive" && index >= session.files.filter(f => f.relpath !== COMPLETE && f.relpath !== ASSEMBLED).length && session.files.reduce((n, f) => n + f.bytes, 0) + data.length > limits.archiveMaxBytes) throw new BadRequestError("Archive exceeds the compressed upload limit");
    const result = await putChunk(session, index, data);
    if (final) {
      if (parent.packageOptions?.source === "archive") {
        const chunks = session.files.filter(f => f.relpath !== COMPLETE && f.relpath !== ASSEMBLED);
        if (chunks.length !== index + 1) throw new BadRequestError("Chunk count mismatch");
        if (!session.files.some(f => f.relpath === COMPLETE) && !await compareUploadSessionFiles(session.versionId, session.files, [...session.files, { relpath: COMPLETE, bytes: 0 }])) throw conflict();
      } else await finishFile(request, session, index + 1);
      return { path, nextIndex: index + 1, bytes: result.bytes, complete: true };
    }
    return { path, ...result, complete: false };
  };
  return parent.packageOptions?.source === "archive" ? packageLease(parent, receive) : receive();
}

/** A sealed archive is assembled only by the durable package worker, never in the final PUT. */
export async function archiveParts(parent: UploadSession) {
  if (parent.packageOptions?.source !== "archive") return null;
  const children = await listUploadSessionsForTarget(`mcp-parts:${parent.ownerKey}`, parent.versionId);
  const part = children.find(child => child.title === "original");
  if (part && !part.files.some(f => f.relpath === COMPLETE)) throw new BadRequestError("The archive upload is incomplete; resume uploading before submitting");
  return part ?? null;
}
export async function assembleArchive(parent: UploadSession, progress?: PackageProgress) {
  const part = await archiveParts(parent);
  if (!part || parent.files.some(f => f.relpath === PACKAGE_ORIGINAL)) return;
  const chunks = part.files.filter(f => f.relpath !== COMPLETE && f.relpath !== ASSEMBLED);
  const hash = createHash("sha256"); let index = 0, total = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      await progress?.({ stage: "assembling", processed: index, total: chunks.length });
      if (index === chunks.length) { controller.close(); return; }
      const chunk = chunks[index++];
      const bytes = await getStorage().read(part.siteId, part.versionId, chunk.relpath);
      if (bytes.length !== chunk.bytes || (chunk.sha256 && createHash("sha256").update(bytes).digest("hex") !== chunk.sha256)) throw new BadRequestError("Stored upload chunk failed integrity verification; upload again");
      total += bytes.length;
      if (total > limits.archiveMaxBytes) throw new BadRequestError("Archive exceeds the compressed upload limit");
      hash.update(bytes); controller.enqueue(bytes);
    } catch (error) { controller.error(error); }
  } });
  const size = await getStorage("package").writeStreamToVersion(parent.siteId, parent.versionId, PACKAGE_ORIGINAL, body);
  await recordUploadedFile(parent, PACKAGE_ORIGINAL, size, hash.digest("hex"));
}

/** Check the intended operation before committing: a publish must never update another site. */
export async function assertUploadTarget(request: Request, uploadId: string, slug?: string) {
  const key = await owner(request);
  const job = await packageJobStatus(uploadId, key);
  if (job) {
    if ((job.targetSlug ?? undefined) !== slug) throw new BadRequestError("Upload target does not match this operation");
    await readablePackageJob(request, job);
    return;
  }
  const session = await getUploadSession(uploadId, key);
  if (!session) throw missing();
  if ((session.targetSlug ?? undefined) !== slug) throw new BadRequestError("Upload target does not match this operation");
}

/** Office/ZIP uploads retain the existing single-request processing ceiling even though
 * the client transfers bytes through small MCP messages. PDF/tree commits stay streaming. */
export async function commitUpload(request: Request, versionId: string, title?: string, expectedVersion?: string, official?: boolean) {
  const job = await packageJobStatus(versionId, await owner(request));
  if (job) return readablePackageJob(request, job);
  const session = await getUploadSession(versionId, await owner(request));
  if (!session) throw missing();
  const children = await listUploadSessionsForTarget(`mcp-parts:${session.ownerKey}`, versionId);
  for (const child of children) {
    if (session.packageOptions?.source === "archive") { await archiveParts(session); continue; }
    if (!child.files.some(f => f.relpath === ASSEMBLED) || !session.files.some(f => f.relpath === child.title || (session.packageOptions?.source === "archive" && child.title === "original" && f.relpath === PACKAGE_ORIGINAL))) throw new BadRequestError("Every uploaded file must finish with final:true before publishing");
  }
  const cleanup = async () => {
    for (const child of children) await discardUploadSession(child.versionId).catch(error => console.error("[mcp] upload cleanup", error));
  };
  try {
    const only = session.files.length === 1 ? session.files[0] : undefined;
    if (!session.packageOptions && only && /\.(docx?|pptx?|zip)$/i.test(only.relpath)) {
      if (only.bytes > limits.inlineUploadMaxBytes - 4096) throw new BadRequestError("Office/ZIP processing exceeds the single-request limit; the upload has been discarded. Convert Office to PDF or start a new upload with an unpacked web tree");
      const bytes = await getStorage().read(session.siteId, session.versionId, only.relpath);
      const form = new FormData(); if (official !== undefined) form.set("official", String(official)); form.set("mode", /\.zip$/i.test(only.relpath) ? "zip" : "file");
      form.set("file", new Blob([Buffer.from(bytes)]), only.relpath.split("/").pop()!);
      if (title ?? session.title) form.set("title", (title ?? session.title)!);
      const commitHeaders = new Headers(request.headers);
      if (session.tenantId) commitHeaders.set("x-artifact-tenant", session.tenantId);
      const commitRequest = new Request(request.url, { headers: commitHeaders });
      const result = await callApi(commitRequest, session.targetSlug ? "update" : "publish", { slug: session.targetSlug ?? undefined, body: form, query: expectedVersion ? { expected_version: expectedVersion } : undefined });
      await discardUploadSession(versionId); await cleanup(); return result;
    }
    const result = await callApi(request, "upload_commit", { versionId, body: { title, official }, query: { ...(expectedVersion ? { expected_version: expectedVersion } : {}), ...(session.packageOptions ? { async: "1" } : {}) } });
    if (!session.packageOptions) await cleanup(); return result;
  } catch (error) {
    // Conflicts keep both the complete draft and its sealed parts for deliberate recovery.
    if (!session.packageOptions && (error as { statusCode?: number }).statusCode !== 409 && !request.headers.has("idempotency-key")) {
      await discardUploadSession(versionId).catch(cleanupError => console.error("[mcp] failed upload cleanup", cleanupError));
      await cleanup();
    }
    throw error;
  }
}
