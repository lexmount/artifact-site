// Upload parsing — turn any of the four drop modes (paste / file / folder / zip) into a
// normalized {kind, entry, title, files[]} ready to store as a version. No build step.
import type { NormalizedUpload, UploadFile, UploadInput, DocumentFormat, SiteKind } from "@/lib/types";
import { limits } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import { buildDocumentFiles, DOCUMENT_ENTRY, documentFormatOf, documentTitleOf, looksLikeOpcPackage, ORIGINAL_DIR, sniffsAsDocument } from "@/lib/document-site";
import { safeRelativePath } from "@/lib/store";
import { unzipBounded } from "@/lib/unzip";

const DEFAULT_ENTRY = "index.html";
const DEFAULT_TITLE = "Untitled site";

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** Pulls a display title from a document's <title>, collapsing whitespace. */
export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = match[1].replace(/\s+/g, " ").trim();
  return title || null;
}

/**
 * Pulls the artifact's own `<meta name="description">` (or the OG equivalent it may carry instead),
 * for the link preview a reader sees when the site is shared.
 *
 * Returns null rather than any kind of stand-in: with nothing here the share card falls back to
 * showing just the title, which is honest. What it must NEVER fall back to is the platform's own
 * tagline — that copy is aimed at whoever is publishing, and a reader who was sent a quarterly
 * report does not want to read about dragging .zip files. That exact leak is why this exists.
 */
export function extractDescription(html: string): string | null {
  // Attribute order is not fixed in real documents, so match the tag and then read its content,
  // rather than assuming `name` comes before `content`.
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const isDescription = /\bname\s*=\s*["']?description["']?/i.test(tag)
      || /\bproperty\s*=\s*["']?og:description["']?/i.test(tag);
    if (!isDescription) continue;
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i);
    const text = content?.[1].replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

/** OS/editor cruft that has no business in a hosted site. */
function isJunk(relpath: string): boolean {
  const parts = relpath.split("/");
  if (parts.includes("__MACOSX")) return true;
  const base = parts[parts.length - 1];
  return base === ".DS_Store" || base === "Thumbs.db";
}

/**
 * When every file sits under one common top directory (the shape a webkitdirectory upload or a
 * wrapped zip produces), strip that prefix so the entry lands at the root.
 */
export function flattenSingleTopDir(files: UploadFile[]): UploadFile[] {
  if (files.length === 0) return files;
  const tops = new Set(files.map((file) => file.relpath.split("/")[0]));
  if (tops.size !== 1) return files;
  const top = [...tops][0];
  if (top === "." || top === "..") return files; // never treat a traversal segment as a wrapper dir
  const prefix = `${top}/`;
  if (!files.every((file) => file.relpath.startsWith(prefix))) return files; // a bare file named `top`
  return files.map((file) => ({ relpath: file.relpath.slice(prefix.length), bytes: file.bytes }));
}

/** Picks the entry HTML: root index.html, else the sole .html, else any nested index.html. */
export function detectEntry(relpaths: string[]): string {
  if (relpaths.includes(DEFAULT_ENTRY)) return DEFAULT_ENTRY;
  const htmls = relpaths.filter((relpath) => relpath.toLowerCase().endsWith(".html"));
  if (htmls.length === 0) throw new BadRequestError("No HTML file found: the site entry must be an .html file");
  if (htmls.length === 1) return htmls[0];
  const nestedIndex = htmls.find((relpath) => relpath.toLowerCase().endsWith("/index.html"));
  if (nestedIndex) return nestedIndex;
  throw new BadRequestError("Could not determine the entry file: put an index.html at the root, or keep only one .html file");
}

/**
 * What kind of site a set of already-stored relative paths should become when a chunked upload commits.
 *
 * - A single document file → document site: the entry is the generated index.html wrapper, and the
 *   original stays where it was PUT (at commit it is **neither moved nor read into memory**, see
 *   commitUploadedVersion). Only PDF is allowed for now — pdf.js reads it by byte range directly, no
 *   conversion needed; Office is converted in memory and belongs to the one-shot file mode, so it is
 *   explicitly refused here with a pointer to that route.
 * - Anything else → HTML site, entry decided by detectEntry as before.
 */
export type UploadDocumentTarget = { format: DocumentFormat; name: string; relpath: string };
export type UploadTarget =
  | { kind: "document"; entry: string; document: UploadDocumentTarget }
  | { kind: "folder"; entry: string; document?: undefined };

export function resolveUploadTarget(relpaths: string[]): UploadTarget {
  if (relpaths.length === 1) {
    const relpath = relpaths[0];
    const format = documentFormatOf(relpath);
    if (format === "pdf") {
      const name = relpath.split("/").pop() || relpath;
      return { kind: "document", entry: DOCUMENT_ENTRY, document: { format, name, relpath } };
    }
    if (format) {
      throw new BadRequestError("Chunked upload currently supports a single PDF document only; for Office documents use single-request file mode (within the per-request limit), or convert to PDF first");
    }
  }
  return { kind: "folder", entry: detectEntry(relpaths), document: undefined };
}

/**
 * The decision when adding a version to an **existing site**: whatever the site is, the new version
 * must still be, guarded in both directions.
 * - Document site ← must still be a single document (PDF for now). Pushing a set of HTML into it would
 *   swap the online reader page for a web page and change what every share link means.
 * - Web site ← must still be an HTML site. Pushing a single PDF in would turn the entry into the
 *   generated wrapper and make the original site's content disappear entirely.
 * Without this split, a document-site user updating with a single PDF would only hit "No HTML file
 * found" — a sentence that makes no sense in a PDF workflow; worse, chunked upload can build a 100MB
 * PDF site that the one-shot endpoint cannot carry, so the site could be created but never updated.
 */
export function resolveUploadTargetForSite(siteKind: SiteKind, relpaths: string[]): UploadTarget {
  if (siteKind === "document") {
    const target = resolveUploadTarget(relpaths); // a single Office file gets the "PDF only" hint right here
    if (target.kind !== "document") {
      throw new BadRequestError("A new version of a document site must still be a single PDF file: upload just that one .pdf in the session, then commit (create a new site for web content)");
    }
    return target;
  }
  if (relpaths.length === 1 && documentFormatOf(relpaths[0])) {
    throw new BadRequestError("This is a web site; its content cannot be replaced with a document. Create a new site for the document, or re-upload the whole file to a document site");
  }
  return { kind: "folder", entry: detectEntry(relpaths), document: undefined };
}

function normalizeTree(rawFiles: UploadFile[], title: string | undefined): NormalizedUpload {
  const cleaned = rawFiles
    .map((file) => ({ relpath: file.relpath.replaceAll("\\", "/").replace(/^\.\//, ""), bytes: file.bytes }))
    .filter((file) => file.relpath && !file.relpath.endsWith("/") && !isJunk(file.relpath));
  if (cleaned.length === 0) throw new BadRequestError("The upload is empty");
  // Validate every path BEFORE flattening so a "../x" upload is rejected, never silently un-prefixed.
  const safe = cleaned.map((file) => ({ relpath: safeRelativePath(file.relpath), bytes: file.bytes }));
  const files = flattenSingleTopDir(safe);
  const entry = detectEntry(files.map((file) => file.relpath));
  const entryFile = files.find((file) => file.relpath === entry);
  const resolvedTitle = title?.trim() || (entryFile ? extractTitle(decode(entryFile.bytes)) : null) || DEFAULT_TITLE;
  return { kind: "folder", entry, title: resolvedTitle, files };
}

/** Parse any UploadInput into the version-ready shape. Throws on empty / no-entry / unsafe input. */
export function normalizeUpload(input: UploadInput): NormalizedUpload {
  switch (input.mode) {
    case "paste": {
      if (!input.html.trim()) throw new BadRequestError("The pasted HTML is empty");
      const title = input.title?.trim() || extractTitle(input.html) || DEFAULT_TITLE;
      return { kind: "single", entry: DEFAULT_ENTRY, title, files: [{ relpath: DEFAULT_ENTRY, bytes: encode(input.html) }] };
    }
    case "file": {
      // Route by extension BEFORE anything touches the bytes: a document is not "an HTML site
      // that failed validation", it is its own branch with its own generated wrapper.
      const format = documentFormatOf(input.filename);
      if (format) {
        // Documents have their own size copy (the generic guard fires later, in English, with a
        // relpath — useless to whoever dropped a 40MB deck) and a content sniff: base64 decoding
        // silently swallows corrupt input, and a mislabelled/broken file must die HERE with a
        // clear message, not later in the viewer as an unexplained blank.
        if (input.bytes.byteLength === 0) throw new BadRequestError("The uploaded document is an empty file");
        if (input.bytes.byteLength > limits.maxFileBytes) {
          throw new BadRequestError(`The document exceeds the per-file limit (${Math.round(limits.maxFileBytes / 1048576)}MB): this file is about ${Math.ceil(input.bytes.byteLength / 1048576)}MB`);
        }
        if (!sniffsAsDocument(format, input.bytes)) {
          throw new BadRequestError(`The file content is not a valid .${format} document: the base64 may have been corrupted in transit, or the extension does not match the content`);
        }
        const originalName = input.filename.split("/").pop() || input.filename;
        const meta = { format, originalName, originalRelpath: safeRelativePath(`${ORIGINAL_DIR}/${originalName}`) };
        const title = input.title?.trim() || documentTitleOf(originalName) || DEFAULT_TITLE;
        // `files` is the NO-CONVERSION outcome (pdf: viewer over the original; office: download
        // card). The create path may rebuild them with a preview — see NormalizedUpload.document.
        return { kind: "document", entry: DOCUMENT_ENTRY, title, files: buildDocumentFiles(meta, input.bytes, null), document: meta };
      }
      if (!input.filename.toLowerCase().endsWith(".html")) throw new BadRequestError("A single-file site's entry must be an .html file, or a .pdf / .pptx / .ppt / .docx / .doc document");
      const html = decode(input.bytes);
      const fallback = input.filename.replace(/\.html?$/i, "").split("/").pop();
      const title = input.title?.trim() || extractTitle(html) || fallback || DEFAULT_TITLE;
      // A lone .html always becomes index.html so the entry is stable and edits replace the whole doc.
      return { kind: "single", entry: DEFAULT_ENTRY, title, files: [{ relpath: DEFAULT_ENTRY, bytes: input.bytes }] };
    }
    case "folder":
      return normalizeTree(input.files, input.title);
    case "zip": {
      // Bounded extraction: per-file and total caps are enforced DURING inflation (zlib
      // maxOutputLength), so even a forged-header bomb is aborted before its bytes materialize.
      const files: UploadFile[] = unzipBounded(input.bytes).map((f) => ({ relpath: f.name, bytes: f.bytes }));
      if (files.length === 0) throw new BadRequestError("The archive contains no files");
      // pptx/docx ARE zip archives (OPC). Without this check they inflate cleanly and then die in
      // detectEntry with "No HTML file found" — a message that sends the uploader the wrong way.
      if (looksLikeOpcPackage(files.map((f) => f.relpath))) {
        throw new BadRequestError("This is an Office document (pptx/docx files are zip containers themselves); upload it directly as a file rather than as an archive");
      }
      return normalizeTree(files, input.title);
    }
  }
}
