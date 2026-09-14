// Storage abstraction — the one place that knows HOW bytes are persisted. Everything else
// (sites, preview, editor, routes) speaks to the Storage interface, so a Local backend today
// and an S3/COS backend (Phase 2) are interchangeable. The path guards live here because they
// are the security core and both backends must apply them identically.
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { config, dataPath, limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import type { UploadFile } from "@/lib/types";
import { S3Storage } from "@/lib/storage-s3";

// --- path guards (verbatim from the legacy platform audit; do NOT weaken) ------

export function safeRelativePath(input: string): string {
  const normalized = input.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BadRequestError(`invalid relative path: ${input}`);
  }
  if (Buffer.byteLength(normalized, "utf8") > 1024) throw new BadRequestError(`relative path is too long: ${input}`);
  const parts = normalized.split("/");
  if (parts.some((part) => {
    const lower = part.toLowerCase();
    return !part || part === "." || part === ".." || lower === ".git" || lower === "node_modules" || Buffer.byteLength(part, "utf8") > 255;
  })) {
    throw new BadRequestError(`unsafe relative path: ${input}`);
  }
  return parts.join("/");
}

export function resolveInside(root: string, relative: string): string {
  const safe = safeRelativePath(relative);
  const resolved = path.resolve(root, safe);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new BadRequestError(`path escapes root: ${relative}`);
  }
  return resolved;
}

// --- key / layout -------------------------------------------------------------

/** Local on-disk layout. */
export function siteDir(siteId: string): string {
  return dataPath("sites", siteId);
}
export function versionDir(siteId: string, versionId: string): string {
  return dataPath("sites", siteId, versionId);
}

/**
 * The object key a (siteId, versionId, relpath) maps to in an S3/COS bucket. `relpath` runs through
 * safeRelativePath (blocks "..", absolute, control chars, ".git", overlong segments), so the key can
 * never escape its version prefix — the S3 analogue of resolveInside's containment. siteId/versionId
 * are server-generated ids (createId), never user input, so only relpath needs validating.
 */
export function storageKey(siteId: string, versionId: string, relpath: string): string {
  return `sites/${siteId}/${versionId}/${safeRelativePath(relpath)}`;
}

// --- limits (pure) ------------------------------------------------------------

/** Rejects a version whose file count / total bytes / any single file exceed the limits. */
export function assertWithinLimits(files: readonly UploadFile[]): void {
  if (files.length === 0) throw new BadRequestError("a version needs at least one file");
  if (files.length > limits.maxFiles) throw new BadRequestError(`too many files: ${files.length} > ${limits.maxFiles}`);
  let total = 0;
  for (const file of files) {
    const size = file.bytes.byteLength;
    if (size > limits.maxFileBytes) throw new BadRequestError(`file too large: ${file.relpath} (${size} bytes)`);
    total += size;
  }
  if (total > limits.maxBytes) throw new BadRequestError(`site too large: ${total} bytes > ${limits.maxBytes}`);
}

// --- Storage interface --------------------------------------------------------

/** A backend-internal failure (not a request-path guard violation). Callers that serve untrusted
 *  visitors must map this to a generic 500, never echo its message — it may carry storage internals. */
export class StorageError extends Error {
  constructor(message = "storage error") {
    super(message);
    this.name = "StorageError";
  }
}

export type PathKind = "file" | "directory" | "missing";

/** A version tree present in storage, with the newest object mtime (ms epoch) — for orphan GC. */
export interface StoredVersion { siteId: string; versionId: string; newestMtime: number }

/** The result of one range read. `total` is the whole file's size — a Range response must be able to report it. */
export interface RangeSlice { bytes: Uint8Array; total: number }

export interface Storage {
  /** Validate + write a whole version's files. Returns the stored fileCount + byteSize. */
  writeVersionFiles(siteId: string, versionId: string, files: readonly UploadFile[]): Promise<{ fileCount: number; byteSize: number }>;
  /**
   * Write a **stream** into a version without ever assembling the whole file in memory.
   *
   * This is the cure for "one upload can crash the service": the old path read the entire file into
   * a Uint8Array (more than one copy, too), so a single 50MB video could eat one or two hundred MB,
   * and under memory pressure the process simply fell over — production crashed exactly this way,
   * with everyone getting 503s meanwhile. Down this path, usage depends only on the buffer size, not
   * on how large the file is.
   */
  writeStreamToVersion(siteId: string, versionId: string, relpath: string, body: ReadableStream<Uint8Array>): Promise<number>;
  /**
   * Read one byte range of a file. Seeking in a video depends on it: the browser asks for
   * `Range: bytes=...` and we answer 206 with just that slice instead of pushing the whole file.
   * `end` is inclusive, matching HTTP semantics.
   */
  readRange(siteId: string, versionId: string, relpath: string, start: number, end: number): Promise<RangeSlice>;
  /** File size without reading the content — Range negotiation needs the total length first. */
  sizeOf(siteId: string, versionId: string, relpath: string): Promise<number | null>;
  /** Overwrite/create one guarded file in an existing version (folder-edit path). Enforces the per-file cap. */
  writeFileToVersion(siteId: string, versionId: string, relpath: string, bytes: Uint8Array): Promise<void>;
  /** Copy a whole version tree into a new version id (same site, or another site for a fork). */
  copyVersionTree(siteId: string, fromVersionId: string, toVersionId: string, toSiteId?: string): Promise<void>;
  /** Real stored fileCount + byte size of a version. */
  measureVersion(siteId: string, versionId: string): Promise<{ fileCount: number; byteSize: number }>;
  removeVersion(siteId: string, versionId: string): Promise<void>;
  removeSite(siteId: string): Promise<void>;
  /** Sorted relpaths of every file in a version (editor file picker). */
  list(siteId: string, versionId: string): Promise<string[]>;
  /** file | directory | missing for a validated relpath. */
  stat(siteId: string, versionId: string, relpath: string): Promise<PathKind>;
  /** Read a validated relpath's bytes. Throws on a guard violation or a missing file. */
  read(siteId: string, versionId: string, relpath: string): Promise<Uint8Array>;
  /** Every version tree in storage (siteId, versionId, newest mtime) — for the orphan reconciler. */
  listStoredVersions(): Promise<StoredVersion[]>;
}

// --- Local (filesystem) backend ----------------------------------------------

class LocalStorage implements Storage {
  async writeVersionFiles(siteId: string, versionId: string, files: readonly UploadFile[]): Promise<{ fileCount: number; byteSize: number }> {
    const safe = files.map((file) => ({ relpath: safeRelativePath(file.relpath), bytes: file.bytes }));
    assertWithinLimits(safe);
    const root = versionDir(siteId, versionId);
    let byteSize = 0;
    for (const file of safe) {
      const dest = resolveInside(root, file.relpath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.bytes);
      byteSize += file.bytes.byteLength;
    }
    return { fileCount: safe.length, byteSize };
  }

  async writeStreamToVersion(siteId: string, versionId: string, relpath: string, body: ReadableStream<Uint8Array>): Promise<number> {
    const safe = safeRelativePath(relpath);
    const dest = resolveInside(versionDir(siteId, versionId), safe);
    await mkdir(path.dirname(dest), { recursive: true });
    // pipeline propagates backpressure all the way back to the request stream: when disk writes slow
    // down, reads slow down with them, and buffers never pile up unbounded.
    // Count bytes as they are written, saving a stat after the fact.
    let written = 0;
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        written += chunk.byteLength;
        if (written > limits.maxFileBytes) throw new StorageError(`file too large: ${safe}`);
        controller.enqueue(chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body.pipeThrough(counted) as never), createWriteStream(dest));
    } catch (error) {
      // Half a file is worse than no file: measureVersion would count it and detectEntry would see it.
      await rm(dest, { force: true }).catch(() => {});
      throw error;
    }
    return written;
  }

  async sizeOf(siteId: string, versionId: string, relpath: string): Promise<number | null> {
    try {
      const file = resolveInside(versionDir(siteId, versionId), safeRelativePath(relpath));
      const info = await stat(file);
      return info.isFile() ? info.size : null;
    } catch { return null; }
  }

  async readRange(siteId: string, versionId: string, relpath: string, start: number, end: number): Promise<RangeSlice> {
    const file = resolveInside(versionDir(siteId, versionId), safeRelativePath(relpath));
    // Same defence as read(): symlinks are not served, and the real path must still be inside the version root.
    if ((await lstat(file)).isSymbolicLink()) throw new StorageError("symbolic links are not served");
    const [realRoot, realFile] = await Promise.all([realpath(versionDir(siteId, versionId)), realpath(file)]);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) throw new StorageError("path escapes root");
    const total = (await stat(file)).size;
    const chunks: Uint8Array[] = [];
    for await (const chunk of createReadStream(file, { start, end })) chunks.push(chunk as Uint8Array);
    return { bytes: Buffer.concat(chunks), total };
  }

  async writeFileToVersion(siteId: string, versionId: string, relpath: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new BadRequestError(`file too large: ${relpath} (${bytes.byteLength} bytes > ${limits.maxFileBytes})`);
    }
    const dest = resolveInside(versionDir(siteId, versionId), relpath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }

  async copyVersionTree(siteId: string, fromVersionId: string, toVersionId: string, toSiteId: string = siteId): Promise<void> {
    const from = versionDir(siteId, fromVersionId);
    const to = versionDir(toSiteId, toVersionId);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  async measureVersion(siteId: string, versionId: string): Promise<{ fileCount: number; byteSize: number }> {
    const root = versionDir(siteId, versionId);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    let fileCount = 0;
    let byteSize = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      fileCount += 1;
      byteSize += (await stat(path.join(entry.parentPath, entry.name))).size;
    }
    return { fileCount, byteSize };
  }

  async removeVersion(siteId: string, versionId: string): Promise<void> {
    await rm(versionDir(siteId, versionId), { recursive: true, force: true });
    await rmdir(siteDir(siteId)).catch(() => {}); // drop the parent site dir if it's now empty (else ENOTEMPTY, ignored)
  }

  async removeSite(siteId: string): Promise<void> {
    await rm(siteDir(siteId), { recursive: true, force: true });
  }

  async list(siteId: string, versionId: string): Promise<string[]> {
    const root = versionDir(siteId, versionId);
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .sort();
  }

  async stat(siteId: string, versionId: string, relpath: string): Promise<PathKind> {
    const target = resolveInside(versionDir(siteId, versionId), relpath);
    const info = await stat(target).catch(() => null);
    if (!info) return "missing";
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : "missing";
  }

  async read(siteId: string, versionId: string, relpath: string): Promise<Uint8Array> {
    const root = versionDir(siteId, versionId);
    const file = resolveInside(root, relpath);
    // Preserve preview's exact defenses: reject a symlinked file, and confirm the resolved real
    // path is still contained by the version root (blocks symlink-to-outside escapes).
    if ((await lstat(file)).isSymbolicLink()) throw new Error("symbolic links are not served");
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error("path escapes root");
    return await readFile(file);
  }

  async listStoredVersions(): Promise<StoredVersion[]> {
    const root = dataPath("sites");
    const out: StoredVersion[] = [];
    const sites = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const s of sites) {
      if (!s.isDirectory()) continue;
      const versions = await readdir(path.join(root, s.name), { withFileTypes: true }).catch(() => []);
      for (const v of versions) {
        if (!v.isDirectory()) continue;
        const info = await stat(path.join(root, s.name, v.name)).catch(() => null);
        out.push({ siteId: s.name, versionId: v.name, newestMtime: info ? info.mtimeMs : 0 });
      }
    }
    return out;
  }
}

// --- backend selection --------------------------------------------------------

let cached: Storage | null = null;

export function getStorage(): Storage {
  if (cached) return cached;
  const driver = config.storageDriver;
  if (driver === "local") {
    cached = new LocalStorage();
    return cached;
  }
  if (driver === "s3") {
    // storageKey() maps every path safely into the bucket; the S3 backend reuses it +
    // assertWithinLimits identically. Credentials are captured in the S3Client at construction,
    // so changing ARTIFACT_S3_* requires a restart to take effect.
    cached = new S3Storage();
    return cached;
  }
  throw new Error(`unknown ARTIFACT_STORAGE_DRIVER: ${driver}`);
}

/** Test-only: drop the memoized backend so a test can switch drivers. */
export function __resetStorageForTests(): void {
  cached = null;
}
