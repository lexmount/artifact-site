import { packageJobContext } from "@/lib/package-job-context";
import { translatorFor, type Locale } from "@/lib/i18n";
import "@/locales";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RbacQuery } from "@/lib/rbac-store";
import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { rbacQuery, getVersion, getUploadSessionRow } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import type { UploadSession } from "@/lib/upload-session";
import { PACKAGE_ORIGINAL, archiveFormat, type PackageMeta } from "@/lib/package-contract";
import { packagePath, validatePackageEntries, writePackageDirectory } from "@/lib/package-directory";

/** A durable, bounded lease fences PUT against commit and other workers across replicas. */
const currentLease = new AsyncLocalStorage<{ versionId: string; lease: string }>();
export async function assertPackageLease(q: RbacQuery) {
  const active = currentLease.getStore(); if (!active) return;
  const rows = await q("SELECT version_id FROM upload_sessions WHERE version_id=$1 AND package_lease=$2 AND package_lease_until>$3", [active.versionId, active.lease, Date.now()]);
  if (!rows.length) throw new BadRequestError("Package processing lease expired; retry publication");
}
export async function packageLease<T>(session: UploadSession, work: () => Promise<T>): Promise<T> {
  const lease = randomUUID(), now = Date.now();
  const rows = await rbacQuery("UPDATE upload_sessions SET package_lease=$1,package_lease_until=$2 WHERE version_id=$3 AND (package_lease IS NULL OR package_lease_until<$4) AND ($5=1 OR NOT EXISTS (SELECT 1 FROM package_jobs j WHERE j.version_id=upload_sessions.version_id)) RETURNING version_id", [lease, now + 45_000, session.versionId, now, packageJobContext.getStore() ? 1 : 0]);
  if (!rows.length) throw Object.assign(new Error("Package upload or extraction is in progress; retry shortly"), { statusCode: 409 });
  const heartbeat = setInterval(() => { void rbacQuery("UPDATE upload_sessions SET package_lease_until=$1 WHERE version_id=$2 AND package_lease=$3", [Date.now() + 45_000, session.versionId, lease]).catch(() => {}); }, 10_000);
  heartbeat.unref();
  try {
    if (await getVersion(session.versionId)) throw new BadRequestError("This version has already been published");
    const fresh = await getUploadSessionRow(session.versionId);
    if (!fresh) throw new BadRequestError("Upload session no longer exists");
    session.files = fresh.files;
    return await currentLease.run({ versionId: session.versionId, lease }, work);
  } finally {
    clearInterval(heartbeat);
    await rbacQuery("UPDATE upload_sessions SET package_lease=NULL,package_lease_until=NULL WHERE version_id=$1 AND package_lease=$2", [session.versionId, lease]);
  }
}

/** Range-based reads keep both Local and S3 memory bounded. */
export function versionStream(siteId: string, versionId: string, file: string, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ async pull(controller) {
    if (offset >= size) { controller.close(); return; }
    try {
      const slice = await getStorage("package").readRange(siteId, versionId, file, offset, Math.min(size - 1, offset + 1024 * 1024 - 1));
      if (!slice.bytes.length || slice.total !== size) throw new Error("Stored file changed during read");
      offset += slice.bytes.length; controller.enqueue(slice.bytes);
    } catch (error) { controller.error(error); }
  } });
}

let active = 0;
export type PackageProgress = (progress: { stage: string; processed: number; total?: number }) => Promise<void>;
export async function preparePackage(session: UploadSession, locale: Locale = "en", progress: PackageProgress = async () => {}): Promise<PackageMeta> {
  await progress({ stage: "validating", processed: 0 });
  const options = session.packageOptions!;
  const t = translatorFor(locale);
  if (options.source === "folder") {
    const meta: PackageMeta = { source: "folder", files: [], directories: (options.directories ?? []).map(packagePath), ignored: [] };
    for (const file of session.files) {
      const size = await getStorage("package").sizeOf(session.siteId, session.versionId, file.relpath);
      if (size !== file.bytes) throw new BadRequestError("Uploaded file does not match its receipt");
      meta.files.push({ path: packagePath(file.relpath), size });
      await progress({ stage: "validating", processed: meta.files.length, total: session.files.length });
    }
    const paths = await getStorage("package").list(session.siteId, session.versionId);
    if (paths.some(p => !p.startsWith(".artifact-package/") && !session.files.some(f => f.relpath === p))) throw new BadRequestError("An uploaded file is incomplete; retry that file before committing");
    validatePackageEntries(meta.files, meta.directories);
    if (!meta.files.length && !meta.directories.length) throw new BadRequestError("The package is empty");
    await progress({ stage: "publishing", processed: meta.files.length, total: meta.files.length });
    await writePackageDirectory(session.siteId, session.versionId, meta, session.title || t("Files"), t);
    return meta;
  }
  if (active >= 2) throw Object.assign(new Error("Archive processing is busy; retry shortly"), { statusCode: 503 });
  active++;
  let dir: string | undefined;
  try {
    const receipt = session.files.find(f => f.relpath === PACKAGE_ORIGINAL);
    if (!receipt?.sha256 || receipt.bytes > limits.archiveMaxBytes) throw new BadRequestError("Upload the original archive before committing");
    dir = await mkdtemp(path.join(tmpdir(), "artifact-archive-"));
    const input = path.join(dir, "input");
    const handle = await open(input, "wx", 0o600);
    const hash = createHash("sha256");
    try { for await (const chunk of Readable.fromWeb(versionStream(session.siteId, session.versionId, PACKAGE_ORIGINAL, receipt.bytes) as import("node:stream/web").ReadableStream)) { hash.update(chunk); await handle.writeFile(chunk); } }
    finally { await handle.close(); }
    if (hash.digest("hex") !== receipt.sha256) throw new BadRequestError("Original archive does not match its upload receipt");
    const source = await open(input, "r"); const signature = Buffer.alloc(8);
    try { await source.read(signature, 0, 8, 0); } finally { await source.close(); }
    const format = archiveFormat(options.name!)!;
    const detected = signature.subarray(0, 2).equals(Buffer.from("PK")) ? "zip" : signature.subarray(0, 6).equals(Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])) ? "7z" : signature.subarray(0, 6).equals(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07])) ? "rar" : undefined;
    // TAR begins with a filename, not a unique magic prefix; the native reader verifies it.
    const gzip = signature[0] === 0x1f && signature[1] === 0x8b && signature[2] === 8;
    if (format === "tar.gz" ? !gzip : format === "tar" ? false : detected !== format) throw new BadRequestError("Archive contents do not match the filename format");
    if (format === "zip") {
      // ZIP64 and multi-volume ZIP are deliberately outside the initial package contract.
      const handle = await open(input, "r");
      const tail = Buffer.alloc(Math.min(receipt.bytes, 65_557));
      try { await handle.read(tail, 0, tail.length, receipt.bytes - tail.length); } finally { await handle.close(); }
      let end = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
      }
      if (end < 0) throw new BadRequestError("Missing ZIP directory record");
      if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) throw new BadRequestError("Multi-volume ZIP is unsupported");
      if (tail.readUInt16LE(end + 10) === 0xffff || tail.readUInt32LE(end + 12) === 0xffffffff || tail.readUInt32LE(end + 16) === 0xffffffff || (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50)) throw new BadRequestError("ZIP64 is unsupported");
    }
    if (format === "tar.gz") {
      // libarchive does not consistently verify gzip trailers. Validate CRC and the full
      // stream with zlib, bounding TAR headers/padding as well as decompressed file bytes.
      let expanded = 0;
      const containerLimit = limits.maxBytes + limits.maxFiles * 2 * 4096 + 1024 * 1024;
      try {
        await pipeline(createReadStream(input), createGunzip(), new Writable({ write(chunk, _encoding, callback) {
          expanded += chunk.length;
          callback(expanded > containerLimit ? new BadRequestError("Compressed TAR exceeds its container size limit") : undefined);
        } }), { signal: AbortSignal.timeout(120_000) });
      } catch (error) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError("Invalid, truncated or timed-out gzip stream; recreate the TAR.GZ archive and try again");
      }
    }
    const meta: PackageMeta = { source: "archive", files: [], directories: [], ignored: [], archive: { name: options.name!, format: archiveFormat(options.name!)!, size: receipt.bytes, sha256: receipt.sha256 } };
    await extract(input, session, meta, dir, progress);
    validatePackageEntries(meta.files, meta.directories);
    if (!meta.files.length && !meta.directories.length) throw new BadRequestError("The archive contains no supported entries");
    await writePackageDirectory(session.siteId, session.versionId, meta, session.title || options.name!, t);
    return meta;
  } finally { active--; if (dir) await rm(dir, { recursive: true, force: true }); }
}

async function extract(input: string, session: UploadSession, meta: PackageMeta, dir: string, progress: PackageProgress) {
  await progress({ stage: "extracting", processed: 0 });
  const staged: { path: string; local: string; size: number }[] = [];
  // The native helper only emits bytes. It never uses an archive path as a filesystem destination.
  const binary = path.resolve(limits.archiveReader);
  const child = spawn(binary, [input, String(limits.maxFiles), String(limits.maxFileBytes), String(limits.maxBytes), meta.archive!.format], { stdio: ["ignore", "pipe", "pipe"], env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, LANG: process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8" } });
  let errorText = "";
  child.stderr.on("data", chunk => { if (errorText.length < 4096) errorText += String(chunk).slice(0, 4096 - errorText.length); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Archive reader is unavailable; build scripts/archive/build.sh")));
    child.once("close", code => code === 0 ? resolve() : reject(new BadRequestError(errorText.trim() || "Archive extraction failed or exceeded its resource limit")));
  });
  // Observe early rejection while the framed stream is still being consumed.
  void completion.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const iterator = child.stdout[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function take(n: number, eof = false): Promise<Buffer | null> {
    const parts: Buffer[] = []; let remaining = n;
    while (remaining) {
      if (!buffered.length) {
        const chunk = await iterator.next();
        if (chunk.done) { if (eof && remaining === n) return null; throw new BadRequestError("Truncated archive output"); }
        buffered = Buffer.from(chunk.value);
      }
      const size = Math.min(remaining, buffered.length);
      parts.push(buffered.subarray(0, size)); buffered = buffered.subarray(size); remaining -= size;
    }
    return Buffer.concat(parts, n);
  }
  const allFiles: { path: string; size: number }[] = [], allDirs: string[] = [];
  try {
    while (true) {
      const header = await take(13, true); if (!header) break;
      const type = header[0], length = header.readUInt32BE(1), size = Number(header.readBigUInt64BE(5));
      if (![68, 70].includes(type) || length > 1024 || !Number.isSafeInteger(size) || size > limits.maxFileBytes) throw new BadRequestError("Invalid archive entry header");
      const raw = new TextDecoder("utf-8", { fatal: true }).decode((await take(length))!).replace(/\/$/, "");
      // TAR commonly includes a root directory marker; it is not a stored entry.
      if (type === 68 && size === 0 && raw === ".") continue;
      // Only known OS metadata is filtered; traversal is checked even in ignored entries.
      const ignored = raw.split(/[\\/]/).some(p => ["__MACOSX", ".DS_Store", "Thumbs.db"].includes(p));
      const safe = ignored ? (await import("@/lib/storage")).safeRelativePath(raw, "package") : packagePath(raw);
      if (type === 68) allDirs.push(safe); else allFiles.push({ path: safe, size });
      // Validate every non-junk prefix before writing any bytes.
      validatePackageEntries(allFiles.filter(f => !f.path.split("/").some(p => ["__MACOSX", ".DS_Store", "Thumbs.db"].includes(p))), allDirs.filter(d => !d.split("/").some(p => ["__MACOSX", ".DS_Store", "Thumbs.db"].includes(p))));
      let remaining = size;
      const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (!remaining) { controller.close(); return; }
        try { const chunk = (await take(Math.min(remaining, 65536)))!; remaining -= chunk.length; controller.enqueue(chunk); } catch (e) { controller.error(e); }
      } });
      if (ignored) { meta.ignored.push(safe); for await (const chunk of Readable.fromWeb(stream as import("node:stream/web").ReadableStream)) void chunk; }
      else if (type === 68) meta.directories.push(safe);
      else {
        const local = path.join(dir, `entry-${staged.length}`);
        await pipeline(Readable.fromWeb(stream as import("node:stream/web").ReadableStream), createWriteStream(local, { flags: "wx", mode: 0o600 }));
        staged.push({ path: safe, local, size });
      }
    }
    await completion;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    // A partially consumed async iterator otherwise leaves the pipe open after exit.
    child.stdout.destroy();
    child.stderr.destroy();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([completion.catch(() => {}), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 5000); })]);
    } finally { clearTimeout(cleanupTimer); }
  }
  // Native CPU/decompression limits end before remote I/O. Disk usage remains bounded
  // by maxBytes plus the retained original; never buffer a whole extracted file in RAM.
  await progress({ stage: "uploading_preview_files", processed: 0, total: staged.length });
  let next = 0, done = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limits.packageUploadConcurrency, staged.length) }, async () => {
    while (!failure && next < staged.length) {
      const file = staged[next++];
      const source = createReadStream(file.local);
      try {
        await getStorage("package").writeStreamToVersion(session.siteId, session.versionId, file.path, Readable.toWeb(source) as ReadableStream<Uint8Array>);
        await progress({ stage: "uploading_preview_files", processed: ++done, total: staged.length });
      } catch (error) { failure = error; }
      finally { source.destroy(); }
    }
  }));
  if (failure) throw failure;
  meta.files.push(...staged.map(({ path, size }) => ({ path, size })));
  await progress({ stage: "publishing", processed: done, total: staged.length });
}
