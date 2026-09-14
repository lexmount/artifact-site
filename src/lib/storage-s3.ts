// S3/COS backend for the Storage interface. Objects live at sites/<siteId>/<versionId>/<relpath>.
// Version trees are immutable, so reads are cached in-process (keyed by the full object key).
// Preview never redirects to S3 — the route reads bytes through here and adds the sandbox CSP itself.
// Server-only: this module reaches the database / object store / secrets, and must never be
// bundled into a client component. The import is a build-time tripwire (see next.js docs).
import "server-only";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config, limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import { assertWithinLimits, safeRelativePath, StorageError, storageKey, type PathKind, type RangeSlice, type Storage, type StoredVersion } from "@/lib/storage";
import type { UploadFile } from "@/lib/types";

const CONCURRENCY = 16;

/** Run tasks with a bounded concurrency, preserving result order. Stops handing out new work
 *  as soon as any task fails, so a failed batch doesn't keep mutating S3 after the error. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    while (!aborted) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        aborted = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// --- in-process read cache (immutable keys → bytes), LRU by total bytes ---------
const readCache = new Map<string, Uint8Array>();
/** Part size. The S3 protocol requires every part except the last to be ≥5MiB; 8MiB puts a 300MB
 *  file at a few dozen parts — not so many that round-trips pile up, and no single part large enough
 *  to take the memory back. */
const MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;

let cacheBytes = 0;

function cacheGet(key: string): Uint8Array | undefined {
  const hit = readCache.get(key);
  if (hit) {
    readCache.delete(key); // move to MRU tail
    readCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, bytes: Uint8Array): void {
  const max = config.s3.cacheBytes;
  if (bytes.byteLength > max) return; // never cache an object larger than the whole budget
  const existing = readCache.get(key);
  if (existing) {
    cacheBytes -= existing.byteLength;
    readCache.delete(key);
  }
  while (cacheBytes + bytes.byteLength > max) {
    const lru = readCache.keys().next().value;
    if (lru === undefined) break;
    cacheBytes -= readCache.get(lru)!.byteLength;
    readCache.delete(lru);
  }
  readCache.set(key, bytes);
  cacheBytes += bytes.byteLength;
}

function cacheEvictPrefix(prefix: string): void {
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) {
      cacheBytes -= readCache.get(key)!.byteLength;
      readCache.delete(key);
    }
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const c = config.s3;
    if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey) {
      throw new Error("s3 driver needs ARTIFACT_S3_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY");
    }
    this.bucket = c.bucket;
    this.client = new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      // Newer AWS SDK adds a default crc32 request checksum that S3-compatible providers
      // (COS/MinIO/R2) reject ("Missing Content-MD5"). Only checksum when strictly required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  private versionPrefix(siteId: string, versionId: string): string {
    return `sites/${siteId}/${versionId}/`;
  }
  private sitePrefix(siteId: string): string {
    return `sites/${siteId}/`;
  }

  /** Every object key under a prefix (paginated). */
  private async listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async writeVersionFiles(siteId: string, versionId: string, files: readonly UploadFile[]): Promise<{ fileCount: number; byteSize: number }> {
    const safe = files.map((file) => ({ relpath: safeRelativePath(file.relpath), bytes: file.bytes }));
    assertWithinLimits(safe);
    try {
      await mapLimit(safe, CONCURRENCY, async (file) => {
        const key = storageKey(siteId, versionId, file.relpath);
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file.bytes }));
        cachePut(key, file.bytes);
      });
    } catch (error) {
      // A version is written all-or-nothing; drop any partial objects so we don't leak orphans.
      await this.cleanupPartial(siteId, versionId);
      throw error;
    }
    const byteSize = safe.reduce((sum, f) => sum + f.bytes.byteLength, 0);
    return { fileCount: safe.length, byteSize };
  }

  /** Best-effort removal of a version's objects after a failed write (never masks the write error). */
  private async cleanupPartial(siteId: string, versionId: string): Promise<void> {
    await this.deletePrefix(this.versionPrefix(siteId, versionId)).catch(() => {});
  }

  /**
   * Stream into object storage: accumulate as bytes arrive, push a part whenever the threshold is
   * reached, and hold no more than one part's worth at any time.
   *
   * Deliberately uses the SDK's native three-step flow (Create/Upload/Complete) rather than pulling
   * in lib-storage: "push one part at a time" is precisely the thing wanted here, and an extra
   * dependency buys nothing else. Failure must Abort — unfinished parts keep being billed, are
   * invisible in the object store, and become a permanent bill unless actively cleaned up.
   */
  async writeStreamToVersion(siteId: string, versionId: string, relpath: string, body: ReadableStream<Uint8Array>): Promise<number> {
    const key = `${this.versionPrefix(siteId, versionId)}${safeRelativePath(relpath)}`;
    const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }));
    const uploadId = created.UploadId!;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let total = 0;
    const flush = async () => {
      if (!bufferedBytes) return;
      const part = await this.client.send(new UploadPartCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
        PartNumber: parts.length + 1, Body: Buffer.concat(buffered),
      }));
      parts.push({ ETag: part.ETag!, PartNumber: parts.length + 1 });
      buffered = []; bufferedBytes = 0;
    };
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limits.maxFileBytes) throw new StorageError(`file too large: ${relpath}`);
        buffered.push(value); bufferedBytes += value.byteLength;
        if (bufferedBytes >= MULTIPART_CHUNK_BYTES) await flush();
      }
      await flush();
      if (!parts.length) { // empty file: multipart upload rejects zero parts, fall back to a plain PUT
        await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: new Uint8Array() }));
        return 0;
      }
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
      }));
      return total;
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => {});
      throw error;
    }
  }

  async sizeOf(siteId: string, versionId: string, relpath: string): Promise<number | null> {
    const key = `${this.versionPrefix(siteId, versionId)}${safeRelativePath(relpath)}`;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? null;
    } catch { return null; }
  }

  /** Range reads are passed straight through to object storage — it supports them natively, so there is no need to pull the whole object down and slice it. */
  async readRange(siteId: string, versionId: string, relpath: string, start: number, end: number): Promise<RangeSlice> {
    const key = `${this.versionPrefix(siteId, versionId)}${safeRelativePath(relpath)}`;
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }));
    } catch (error) {
      // A zero-byte object satisfies no byte range at all (RFC 7233): S3 answers 416 where the
      // local backend simply returns nothing. Normalise, so an empty file reads as empty everywhere.
      if (isInvalidRange(error) && start === 0) return { bytes: new Uint8Array(0), total: 0 };
      throw error;
    }
    if (!res.Body) throw new StorageError("empty object body");
    const bytes = await res.Body.transformToByteArray();
    // ContentRange looks like "bytes 0-99/12345"; the part after the slash is the total size.
    const total = Number(res.ContentRange?.split("/")[1] ?? bytes.byteLength);
    return { bytes, total };
  }

  async writeFileToVersion(siteId: string, versionId: string, relpath: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new BadRequestError(`file too large: ${relpath} (${bytes.byteLength} bytes > ${limits.maxFileBytes})`);
    }
    const key = storageKey(siteId, versionId, relpath);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }));
    cachePut(key, bytes);
  }

  async copyVersionTree(siteId: string, fromVersionId: string, toVersionId: string, toSiteId: string = siteId): Promise<void> {
    const fromPrefix = this.versionPrefix(siteId, fromVersionId);
    const objects = await this.listKeys(fromPrefix);
    try {
      await mapLimit(objects, CONCURRENCY, async ({ key }) => {
        const rel = key.slice(fromPrefix.length);
        const destKey = storageKey(toSiteId, toVersionId, rel);
        // CopySource must be URL-encoded but keep the slashes; server-side copy (no download/upload).
        const source = `${this.bucket}/${key}`.split("/").map(encodeURIComponent).join("/");
        await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: destKey, CopySource: source }));
      });
    } catch (error) {
      await this.cleanupPartial(toSiteId, toVersionId);
      throw error;
    }
  }

  async measureVersion(siteId: string, versionId: string): Promise<{ fileCount: number; byteSize: number }> {
    const objects = await this.listKeys(this.versionPrefix(siteId, versionId));
    return { fileCount: objects.length, byteSize: objects.reduce((sum, o) => sum + o.size, 0) };
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const objects = await this.listKeys(prefix);
    // Single DeleteObject per key (bounded concurrency): COS's multi-object DeleteObjects
    // requires a legacy Content-MD5 header the newer AWS SDK no longer sends, so it 400s.
    await mapLimit(objects, CONCURRENCY, async ({ key }) => {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    });
    cacheEvictPrefix(prefix);
  }

  async removeVersion(siteId: string, versionId: string): Promise<void> {
    await this.deletePrefix(this.versionPrefix(siteId, versionId));
  }

  async removeSite(siteId: string): Promise<void> {
    await this.deletePrefix(this.sitePrefix(siteId));
  }

  async list(siteId: string, versionId: string): Promise<string[]> {
    const prefix = this.versionPrefix(siteId, versionId);
    const objects = await this.listKeys(prefix);
    return objects.map((o) => o.key.slice(prefix.length)).sort();
  }

  async stat(siteId: string, versionId: string, relpath: string): Promise<PathKind> {
    const key = storageKey(siteId, versionId, relpath); // validates relpath
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return "file";
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    // Not an exact object — is it a "directory" (any object under key/)? KeyCount is optional in
    // the S3 API (some compatible backends omit it), so fall back to the Contents length.
    const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${key}/`, MaxKeys: 1 }));
    const n = res.KeyCount ?? res.Contents?.length ?? 0;
    return n > 0 ? "directory" : "missing";
  }

  async read(siteId: string, versionId: string, relpath: string): Promise<Uint8Array> {
    const key = storageKey(siteId, versionId, relpath); // validates relpath
    const cached = cacheGet(key);
    if (cached) return cached;
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new StorageError("empty object body"); // don't leak the internal key to callers
    const bytes = await res.Body.transformToByteArray();
    cachePut(key, bytes);
    return bytes;
  }

  async listStoredVersions(): Promise<StoredVersion[]> {
    // One full scan of sites/, grouped by <siteId>/<versionId>, tracking the newest object mtime.
    const newest = new Map<string, number>();
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: "sites/", ContinuationToken: token }));
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const parts = obj.Key.split("/"); // sites / <siteId> / <versionId> / <relpath...>
        if (parts.length < 4 || parts[0] !== "sites" || !parts[1] || !parts[2]) continue;
        const groupKey = `${parts[1]}/${parts[2]}`;
        const mtime = obj.LastModified ? obj.LastModified.getTime() : 0;
        if (mtime > (newest.get(groupKey) ?? 0)) newest.set(groupKey, mtime);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return [...newest].map(([groupKey, newestMtime]) => {
      const slash = groupKey.indexOf("/");
      return { siteId: groupKey.slice(0, slash), versionId: groupKey.slice(slash + 1), newestMtime };
    });
  }
}

function isInvalidRange(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "InvalidRange" || e?.$metadata?.httpStatusCode === 416;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

/** Test-only: clear the read cache between cases. */
export function __resetS3CacheForTests(): void {
  readCache.clear();
  cacheBytes = 0;
}
