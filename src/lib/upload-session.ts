// Chunked upload: a project comes up one file at a time and is committed into a version at the end.
//
// Why it is needed: the old path packed the whole project into one request, and the server had to
// **read all of it into memory** first (one copy for formData parsing, another for arrayBuffer, and
// yet another to unzip). A single 50MB upload could eat one or two hundred MB — production crashed
// exactly this way: after a few large uploads in a row the app died and restarted, and **everyone**
// got 503s meanwhile. Projects with video easily exceed 200MB; that path simply could not carry them.
//
// The approach here is different: files stream one by one into object storage, and the server holds
// no more than one buffer's worth at any moment; once everything is up, commit writes only database
// metadata (which entry, how many files, how big) and never touches content. Memory usage is thus
// completely decoupled from project size.
//
// Sessions **live in the database, not in process memory**. Production runs multiple replicas: the
// request that opens a session lands on replica A, the next PUT is balanced to replica B, and B's
// memory has never heard of it — "upload session does not exist" would show up intermittently
// depending on where a request lands, the hardest class of failure to diagnose.
// Draft files are written straight under the target versionId's prefix; anything uncommitted is an
// orphan, collected by expiry cleanup. The version row is written only at the moment of commit, so
// the database never holds half a version: a version either exists in full or never existed.
import {
  createId, deleteUploadSession, getUploadSessionRow, insertUploadSession, listUploadSessionsBefore,
  setUploadSessionFiles, type UploadSessionRow,
} from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import { anonIdFromRequest } from "@/lib/anon";
import { isAdmin } from "@/lib/auth";
import { sha256hex } from "@/lib/crypto";
import { resolveSession } from "@/lib/session";

/** How long an uncommitted session may live at most. Past this it counts as abandoned and its bytes are collected by cleanup. */
export const UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export type UploadSession = UploadSessionRow;

/**
 * "Who is uploading" — userId for a signed-in user, anonId for an anonymous one. Every PUT / commit
 * has to match what was recorded when the session was opened: versionId is random and unguessable,
 * but once it leaks (logs, screenshots), without this binding it would hand over someone else's upload.
 */
export async function ownerKeyFor(request: Request, anonId?: string | null): Promise<string | null> {
  // Server-internal ownership only: never put this derived key in cookies or site metadata.
  if (isAdmin(request)) return `operator:${sha256hex(request.headers.get("authorization")!.trim())}`;
  const session = await resolveSession(request);
  if (session?.userId) return `u:${session.userId}`;
  const anon = anonId ?? anonIdFromRequest(request);
  return anon ? `a:${anon}` : null;
}

export async function createUploadSession(input: { siteId?: string; targetSlug?: string; title?: string; ownerKey: string }): Promise<UploadSession> {
  const session: UploadSession = {
    versionId: createId("ver"),
    siteId: input.siteId ?? createId("site"),
    files: [],
    createdAt: Date.now(),
    targetSlug: input.targetSlug ?? null,
    title: input.title ?? null,
    ownerKey: input.ownerKey,
  };
  await insertUploadSession(session);
  return session;
}

/** Fetch a session; an expired one is discarded on the spot (bytes included) and treated as absent. A wrong `ownerKey` is treated as absent too — do not reveal that it exists. */
export async function getUploadSession(versionId: string, ownerKey?: string | null): Promise<UploadSession | null> {
  const session = await getUploadSessionRow(versionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > UPLOAD_SESSION_TTL_MS) {
    await discardUploadSession(versionId);
    return null;
  }
  if (ownerKey !== undefined && session.ownerKey !== ownerKey) return null;
  return session;
}

/** Total-size gate. The per-file cap is enforced by the storage layer as the bytes stream through (only there is the real byte count known). */
export function assertSessionRoom(session: UploadSession, incoming: number): void {
  const used = session.files.reduce((sum, f) => sum + f.bytes, 0);
  if (used + incoming > limits.maxBytes) {
    throw new BadRequestError(`The whole project exceeds the limit (${Math.round(limits.maxBytes / 1048576)}MB)`);
  }
  if (session.files.length + 1 > limits.maxFiles) {
    throw new BadRequestError(`Too many files (limit ${limits.maxFiles})`);
  }
}

/** Re-uploading a file with the same name overwrites rather than accumulates — otherwise a few retries would falsely exceed the limit. Mutates the passed-in object in place, then persists. */
export async function recordUploadedFile(session: UploadSession, relpath: string, bytes: number): Promise<void> {
  const existing = session.files.findIndex((f) => f.relpath === relpath);
  if (existing >= 0) session.files[existing] = { relpath, bytes };
  else session.files.push({ relpath, bytes });
  await setUploadSessionFiles(session.versionId, session.files);
}

/** Discard the session and reclaim the bytes already written — an interrupted upload must not leave permanent garbage in storage. */
export async function discardUploadSession(versionId: string): Promise<void> {
  const session = await getUploadSessionRow(versionId);
  await deleteUploadSession(versionId);
  if (session) await getStorage().removeVersion(session.siteId, session.versionId).catch(() => {});
}

export async function completeUploadSession(versionId: string): Promise<void> {
  await deleteUploadSession(versionId);
}

/**
 * Sweep every expired session (bytes reclaimed too). No timer: sweeping on every new session is
 * enough — orphans only arise while someone is uploading, and only then does anyone need to collect them.
 */
export async function sweepExpiredSessions(now: number = Date.now()): Promise<number> {
  const expired = await listUploadSessionsBefore(now - UPLOAD_SESSION_TTL_MS);
  for (const s of expired) await discardUploadSession(s.versionId);
  return expired.length;
}

/** Tests only: clear the session table (bytes included). */
export async function resetUploadSessionsForTests(): Promise<void> {
  for (const s of await listUploadSessionsBefore(Number.MAX_SAFE_INTEGER)) await discardUploadSession(s.versionId);
}
