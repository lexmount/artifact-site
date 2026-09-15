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
import { apiRequest, callApi } from "./api";
import { sha256hex } from "@/lib/crypto";

// Metadata-only sentinels distinguish sealed chunks from successful assembly; neither is a storage object.
const COMPLETE = "mcp-complete";
const ASSEMBLED = "mcp-assembled";
export const CHUNK_BYTES = 256 * 1024;
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
  const key = await ownerKeyFor(apiRequest(request, "/api/uploads"));
  if (!key) throw missing();
  return key;
}
async function startFile(key: string, versionId: string, file: string): Promise<UploadSession> {
  if (!await getUploadSession(versionId, key)) throw missing();
  const relative = safeRelativePath(file);
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
  await storage.writeVersionFiles(session.siteId, id, [{ relpath, bytes: data }]);
  const updated = [...session.files, { relpath, bytes: data.length }];
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
  if (!await getUploadSession(id, key)) throw missing();
  await discardUploadSession(id);
  for (const child of await listUploadSessionsForTarget(`mcp-parts:${key}`, id)) await discardUploadSession(child.versionId);
  return { cancelled: true };
}

export async function writeFileChunk(request: Request, uploadId: string, path: string, index: number, base64: string, final: boolean) {
  const data = decodeChunk(base64); // Reject malformed bytes before allocating a draft.
  const key = await owner(request);
  const parent = await getUploadSession(uploadId, key);
  if (!parent) throw missing();
  const authRequest = apiRequest(request, "/api/uploads", "POST");
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
  const session = await startFile(key, uploadId, path);
  const result = await putChunk(session, index, data);
  if (final) {
    await finishFile(request, session, index + 1);
    return { path, nextIndex: index + 1, bytes: result.bytes, complete: true };
  }
  return { path, ...result, complete: false };
}

/** Check the intended operation before committing: a publish must never update another site. */
export async function assertUploadTarget(request: Request, uploadId: string, slug?: string) {
  const session = await getUploadSession(uploadId, await owner(request));
  if (!session) throw missing();
  if ((session.targetSlug ?? undefined) !== slug) throw new BadRequestError("Upload target does not match this operation");
}

/** Office/ZIP uploads retain the existing single-request processing ceiling even though
 * the client transfers bytes through small MCP messages. PDF/tree commits stay streaming. */
export async function commitUpload(request: Request, versionId: string, title?: string, expectedVersion?: string, official?: boolean) {
  const session = await getUploadSession(versionId, await owner(request));
  if (!session) throw missing();
  const children = await listUploadSessionsForTarget(`mcp-parts:${session.ownerKey}`, versionId);
  for (const child of children) {
    if (!child.files.some(f => f.relpath === ASSEMBLED) || !session.files.some(f => f.relpath === child.title)) throw new BadRequestError("Every uploaded file must finish with final:true before publishing");
  }
  const cleanup = async () => {
    for (const child of children) await discardUploadSession(child.versionId).catch(error => console.error("[mcp] upload cleanup", error));
  };
  try {
    const only = session.files.length === 1 ? session.files[0] : undefined;
    if (only && /\.(docx?|pptx?|zip)$/i.test(only.relpath)) {
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
    const result = await callApi(request, "upload_commit", { versionId, body: { title, official }, query: expectedVersion ? { expected_version: expectedVersion } : undefined });
    await cleanup(); return result;
  } catch (error) {
    // Conflicts keep both the complete draft and its sealed parts for deliberate recovery.
    if ((error as { statusCode?: number }).statusCode !== 409) {
      await discardUploadSession(versionId).catch(cleanupError => console.error("[mcp] failed upload cleanup", cleanupError));
      await cleanup();
    }
    throw error;
  }
}
