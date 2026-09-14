// Turning a local path into something the API accepts: walk a directory (skipping what the
// platform would reject or strip anyway), zip it in memory for the one-shot route, or list it
// for the chunked route. Pure file-system code; no HTTP here.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

/** Directories the platform rejects outright (400) — never ship them. */
export const REJECTED_DIRS = new Set(["node_modules"]);
/** Junk the platform strips itself; skipped here so the size estimate is honest. */
export const IGNORED_NAMES = new Set(["__MACOSX", "Thumbs.db"]);
// Any path segment starting with a dot is refused by the platform (400) — and it is also where
// secrets live (.env, .npmrc, .git). Skipped entirely, and reported so the caller can see it.

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
  return zipSync(entries, { level: 6 });
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
