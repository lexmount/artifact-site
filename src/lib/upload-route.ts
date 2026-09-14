// Which upload path content dropped into the web UI takes: the one-shot endpoint (file / zip /
// folder) or the chunked upload (chunked).
//
// Why this layer exists: the one-shot endpoint reads the whole multipart into server memory, a
// request over inlineMax gets a 413, and forcing it through can crash the service (not just this
// request failing — everyone gets 503s). So once the size crosses the line it must switch to the
// chunked channel. Previously only the "folder" path switched automatically, and a single large
// file (a 30MB HTML or PDF) went inline and hit the 413 — this module folds the decision into one
// place and covers single files too.
//
// The chunked channel currently serves only HTML sites and single PDF documents: neither needs the
// original read into memory at commit. Office documents are converted in memory, so they are
// inherently a one-shot path; over the limit they rely on raising inlineMax rather than switching
// to chunked here.

import type { Translator } from "@/lib/i18n";

const MiB = 1024 * 1024;
/** Frontend default aligned with the server's ARTIFACT_INLINE_UPLOAD_MAX_BYTES; the real decision uses the inlineMax passed in. */
export const INLINE_UPLOAD_MAX_BYTES = 20 * MiB;

/** Single-file types that can take the chunked channel: HTML sites and single PDF documents. Deliberately
 *  excludes .htm (the server's entry detection only recognises .html) and Office (converted in memory). */
const CHUNKABLE_SINGLE = /\.(html|pdf)$/i;
const SINGLE_SITE_FILE = /\.(html?|pdf|pptx?|docx?)$/i;
const ZIP_FILE = /\.zip$/i;

export const zipTooLargeMessage = (bytes: number, inlineMax: number, t: Translator): string =>
  t("This zip is {size}MB, over the {max}MB limit for a single upload. Unzip it and drop the whole folder in instead — the page uploads it in parts automatically.", {
    size: Math.round(bytes / MiB), max: Math.round(inlineMax / MiB),
  });

export type RoutedFile = { path: string; size: number };
export type UploadRoute =
  | { kind: "file" | "zip" | "folder" | "chunked" }
  | { kind: "error"; message: string };

/**
 * Decide how a set of selected files should be sent. Pure function, touches no DOM/network, easy to test and reason about.
 * - A single HTML/PDF over inlineMax → chunked; otherwise file (including Office within the limit)
 * - A single zip → error when over the limit (zip does not go chunked), otherwise zip
 * - Multiple files → error without an HTML entry; total over inlineMax → chunked; otherwise folder
 */
export function chooseUploadRoute(files: readonly RoutedFile[], inlineMax: number, t: Translator): UploadRoute {
  if (files.length === 0) return { kind: "error", message: t("No files to upload") };

  if (files.length === 1) {
    const only = files[0];
    if (SINGLE_SITE_FILE.test(only.path)) {
      if (CHUNKABLE_SINGLE.test(only.path) && only.size > inlineMax) return { kind: "chunked" };
      return { kind: "file" };
    }
    if (ZIP_FILE.test(only.path)) {
      if (only.size > inlineMax) return { kind: "error", message: zipTooLargeMessage(only.size, inlineMax, t) };
      return { kind: "zip" };
    }
    // A single file of any other type: neither a site entry nor an archive; leave it to the folder branch to report "no HTML entry"
  }

  const hasHtml = files.some((f) => /\.html?$/i.test(f.path));
  if (!hasHtml) {
    return { kind: "error", message: t("No .html entry file found. A folder needs at least one HTML page; for a single PDF or Office document, drop the file itself.") };
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > inlineMax) return { kind: "chunked" };
  return { kind: "folder" };
}
