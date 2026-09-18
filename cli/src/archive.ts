import { createReadStream, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
// Turning a local path into something the API accepts: walk a directory (skipping what the
// platform would reject or strip anyway), zip it in memory for the one-shot route, or list it
// for the chunked route. Pure file-system code; no HTTP here.
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Unzip, UnzipInflate, zipSync } from "fflate";

/** Directories the platform rejects outright (400) — never ship them. */
export const REJECTED_DIRS = new Set(["node_modules"]);
/** Junk the platform strips itself; skipped here so the size estimate is honest. */
export const IGNORED_NAMES = new Set(["__MACOSX", "Thumbs.db"]);
// Dot-leading paths can contain secrets (.env, .npmrc, .git). The CLI skips and reports them.

/** The one-shot endpoints read the whole request into memory; above this the chunked route is used.
 *  `ARTIFACT_SITE_ONE_SHOT_LIMIT` overrides it (deployments that raised the ceiling; tests). Read at call
 *  time, not import time, so the override is honoured wherever it is set. */
export function oneShotLimit(): number {
  return Number(process.env.ARTIFACT_SITE_ONE_SHOT_LIMIT || process.env.ARTIFACT_HUB_ONE_SHOT_LIMIT) || 24 * 1024 * 1024;
}

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".pptx", ".ppt", ".docx", ".doc"]);

export interface WalkedFile { relpath: string; absPath: string; size: number }

/** Paths under `root` that were deliberately left out of the last `walkDir` call (dot-leading
 *  segments, node_modules, junk) — for a progress line, so a missing file is never a mystery. */
export const skippedLastWalk: string[] = [];

export async function walkDir(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  skippedLastWalk.length = 0;
  async function visit(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const relpath = rel ? `${rel}/${e.name}` : e.name;
      if (IGNORED_NAMES.has(e.name) || e.name.startsWith(".") || (e.isDirectory() && REJECTED_DIRS.has(e.name.toLowerCase()))) {
        skippedLastWalk.push(relpath);
        continue;
      }
      if (e.isDirectory()) {
        await visit(path.join(dir, e.name), relpath);
      } else if (e.isFile()) {
        const absPath = path.join(dir, e.name);
        out.push({ relpath, absPath, size: (await stat(absPath)).size });
      }
      // symlinks and specials are skipped: the platform rejects symlinks anyway
    }
  }
  await visit(root, "");
  return out;
}

export function totalSize(files: WalkedFile[]): number {
  return files.reduce((n, f) => n + f.size, 0);
}

/** Zip a walked tree in memory (relative paths preserved). Only used under ONE_SHOT_LIMIT. */
export async function zipFiles(files: WalkedFile[]): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.relpath] = new Uint8Array(await readFile(f.absPath));
  return zipSync(entries, { level: 6, mtime: new Date(2000, 0, 1) });
}

export type LocalShape =
  | { type: "html"; file: string; size: number }
  | { type: "document"; file: string; size: number }
  | { type: "zip"; file: string; size: number }
  | { type: "dir"; root: string; files: WalkedFile[]; size: number };

/** What is at `target`, classified the way the API distinguishes uploads. */
export async function inspect(target: string): Promise<LocalShape> {
  const abs = path.resolve(target);
  const s = await stat(abs);
  if (s.isDirectory()) {
    const files = await walkDir(abs);
    if (files.length === 0) throw new Error(`${target} is an empty directory`);
    return { type: "dir", root: abs, files, size: totalSize(files) };
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".zip") return { type: "zip", file: abs, size: s.size };
  if (DOCUMENT_EXTENSIONS.has(ext)) return { type: "document", file: abs, size: s.size };
  if (ext === ".html" || ext === ".htm") return { type: "html", file: abs, size: s.size };
  throw new Error(`Unsupported file type ${ext || "(none)"}: publish a .html, a .zip, a directory, or a pdf/pptx/ppt/docx/doc document`);
}

/** Match the server's path contract before creating local staging files. */
export function safeRelativePath(input: string): string {
  const normalized = input.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized) || Buffer.byteLength(normalized) > 1024) throw new Error(`Invalid relative path: ${input}`);
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".") || part.toLowerCase() === "node_modules" || Buffer.byteLength(part) > 255)) throw new Error(`Unsafe relative path: ${input}`);
  return normalized;
}

export interface UploadLimits { maxBytes: number; maxFileBytes: number; maxFiles: number }
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { maxBytes: 300 * 1048576, maxFileBytes: 250 * 1048576, maxFiles: 2000 };
export function preflightTree(files: WalkedFile[], limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): void {
  if (files.length > limits.maxFiles || totalSize(files) > limits.maxBytes || files.some(f => f.size > limits.maxFileBytes)) throw new Error(`Project exceeds upload limits: ${limits.maxBytes} bytes total, ${limits.maxFileBytes} bytes per file, ${limits.maxFiles} files`);
  for (const f of files) safeRelativePath(f.relpath);
  if (files.length === 1 && /\.pdf$/i.test(files[0].relpath)) return;
  const html = files.filter(f => f.relpath.toLowerCase().endsWith(".html"));
  if (!html.some(f => f.relpath === "index.html" || f.relpath.toLowerCase().endsWith("/index.html")) && html.length !== 1) throw new Error("The project needs an unambiguous HTML entry (prefer index.html). Image-only folders cannot be published independently.");
}

/** Inflate incrementally into a private directory, enforcing limits on ACTUAL output bytes. */
export async function extractZip(file: string, limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): Promise<{ root: string; files: WalkedFile[]; skipped: string[]; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-upload-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const files: WalkedFile[] = [], names = new Set<string>(), handles = new Set<number>();
  const skipped: string[] = [];
  let total = 0, failure: Error | undefined;
  const unzip = new Unzip(entry => {
    try {
      const normalized = entry.name.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
      const segments = normalized.replace(/\/$/, "").split("/");
      // Reject traversal even inside a path that would otherwise be skipped.
      if (segments.includes("..") || segments.includes(".") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Unsafe relative path: ${entry.name}`);
      if (segments.some(part => part.startsWith(".") || IGNORED_NAMES.has(part) || REJECTED_DIRS.has(part.toLowerCase()))) { skipped.push(entry.name); return; }
      if (entry.name.endsWith("/")) { safeRelativePath(entry.name.slice(0, -1)); return; }
      const relpath = safeRelativePath(entry.name);
      if (names.has(relpath)) throw new Error(`Duplicate ZIP path: ${relpath}`);
      names.add(relpath); if (names.size > limits.maxFiles) throw new Error(`ZIP exceeds ${limits.maxFiles} files`);
      const absPath = path.join(root, relpath); mkdirSync(path.dirname(absPath), { recursive: true });
      const fd = openSync(absPath, "wx", 0o600); handles.add(fd);
      const item = { relpath, absPath, size: 0 }; files.push(item);
      entry.ondata = (error, bytes, final) => {
        if (error) { failure = error; return; }
        if (failure) return;
        item.size += bytes.length; total += bytes.length;
        if (item.size > limits.maxFileBytes || total > limits.maxBytes) { failure = new Error("ZIP expanded size exceeds upload limits"); entry.terminate(); return; }
        try { writeSync(fd, bytes); if (final) { closeSync(fd); handles.delete(fd); } } catch (e) { failure = e as Error; }
      };
      entry.start();
    } catch (error) { failure = error as Error; }
  });
  unzip.register(UnzipInflate);
  try {
    for await (const bytes of createReadStream(file, { highWaterMark: 65536 })) { unzip.push(bytes as Buffer); if (failure) throw failure; }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    if (handles.size) throw new Error("Truncated ZIP archive");
    preflightTree(files, limits);
    return { root, files, skipped, cleanup };
  } catch (error) { for (const fd of handles) closeSync(fd); await cleanup(); throw error; }
}
