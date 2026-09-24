import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { getStorage, safeRelativePath } from "@/lib/storage";
import { htmlToText, MAX_DOCUMENT_BYTES, MAX_TEXT_FILE_READ } from "@/lib/site-text";
import type { Site, Version } from "@/lib/types";
import type { CommentAnchor, CommentContext } from "./contracts";

export class CommentEvidenceError extends Error { readonly statusCode = 400; }
const emptyContext = (): CommentContext => ({ schemaVersion: 1, excerpt: null, originalFilePath: null, rendition: null, assetIds: [] });
/** Remove form subtrees before deriving any evidence. Never return HTML/attributes or URLs. */
export function commentHtmlText(html: string): string {
  return htmlToText(html.replace(/<(form|textarea|select|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")).replace(/\s+/g, " ").trim();
}

/** Derived from immutable stored bytes, not a client context object. Call after read authorization. */
export async function prepareCommentEvidence(site: Site, version: Version, anchor: CommentAnchor): Promise<CommentContext> {
  if (version.siteId !== site.id) throw new CommentEvidenceError("Version does not belong to site");
  const filePath = safeRelativePath(anchor.filePath);
  const storage = getStorage();
  const size = await storage.sizeOf(site.id, version.id, filePath);
  if (size === null) throw new CommentEvidenceError("Comment file does not exist");
  const ext = path.extname(filePath).toLowerCase();
  const context = emptyContext();
  if (anchor.kind === "html" && site.kind === "document") throw new CommentEvidenceError("Document previews require PDF or whole-document anchors");
  if (anchor.kind === "html" && !/\.html?$/.test(ext)) throw new CommentEvidenceError("HTML anchor requires an HTML file");
  if (anchor.kind === "image" && !/\.(png|jpe?g|webp|gif|avif|svg)$/.test(ext)) throw new CommentEvidenceError("Image anchor requires an image file");
  if (anchor.kind === "pdf" && ext !== ".pdf") throw new CommentEvidenceError("PDF anchor requires a PDF file");
  if ((anchor.kind === "html" || anchor.kind === "document") && /\.html?$/.test(ext)) {
    const raw = size > MAX_TEXT_FILE_READ ? (await storage.readRange(site.id, version.id, filePath, 0, MAX_TEXT_FILE_READ - 1)).bytes : await storage.read(site.id, version.id, filePath);
    const text = commentHtmlText(Buffer.from(raw).toString("utf8"));
    if (anchor.kind === "html") {
      const quote = anchor.quote?.exact.replace(/\s+/g, " ").trim();
      // Dynamic DOM cannot be certified from the immutable file. Preserve position, report no excerpt.
      if (quote && text.includes(quote)) context.excerpt = quote.slice(0, 2000);
    } else context.excerpt = text.slice(0, 2000) || null;
  }
  if (anchor.kind === "image") {
    const head = Buffer.from((await storage.readRange(site.id, version.id, filePath, 0, Math.min(size, ext === ".svg" ? 16 * 1024 : 512) - 1)).bytes);
    const format = head.toString("latin1");
    const valid = head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (head[0] === 255 && head[1] === 216 && head[2] === 255) || /^(GIF87a|GIF89a)/.test(format) ||
      (format.startsWith("RIFF") && format.slice(8, 12) === "WEBP") ||
      (format.slice(4, 8) === "ftyp" && /avif|avis/.test(format.slice(8, 40))) ||
      (ext === ".svg" && /<svg[\s>]/i.test(format));
    if (!valid) throw new CommentEvidenceError("Image file format is invalid");
  }
  if (anchor.kind === "pdf") {
    if (size > MAX_DOCUMENT_BYTES) throw new CommentEvidenceError("PDF is too large for page validation; use a whole-document comment");
    const bytes = await storage.read(site.id, version.id, filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
    try {
      const doc = await task.promise;
      if (anchor.page > doc.numPages) throw new CommentEvidenceError("Comment page does not exist");
      const page = await doc.getPage(anchor.page);
      const content = await page.getTextContent();
      const view = page.view;
      const region = anchor.region.kind === "point" ? { x: anchor.region.point.x - .08, y: anchor.region.point.y - .04, width: .16, height: .08 } : anchor.region.rect;
      context.excerpt = content.items.filter(item => {
        if (!("str" in item)) return false;
        const x = (item.transform[4] - view[0]) / (view[2] - view[0]);
        const y = 1 - (item.transform[5] - view[1]) / (view[3] - view[1]);
        const width = item.width / (view[2] - view[0]);
        const height = item.height / (view[3] - view[1]);
        return x + width >= region.x && x <= region.x + region.width && y >= region.y && y - height <= region.y + region.height;
      }).map(item => "str" in item ? item.str : "").join(" ").slice(0, 2000) || null;
      // Prefer the selected substring only after certifying it against immutable PDF text.
      const selected = anchor.quote?.exact.replace(/\s+/g, " ").trim();
      if (selected && context.excerpt?.replace(/\s+/g, " ").includes(selected)) context.excerpt = selected;
      page.cleanup();
      context.rendition = { filePath, sha256: hash };
    } catch (error) {
      if (error instanceof CommentEvidenceError) throw error;
      throw new CommentEvidenceError("PDF page could not be validated; use a whole-document comment");
    } finally { await task.destroy(); }
    if (site.kind === "document") {
      const wrapperSize = await storage.sizeOf(site.id, version.id, version.entry);
      if (wrapperSize !== null && wrapperSize <= MAX_TEXT_FILE_READ) {
        const html = Buffer.from(await storage.read(site.id, version.id, version.entry)).toString("utf8");
        const island = html.match(/<script\b[^>]*\bid="doc-config"[^>]*>([\s\S]*?)<\/script>/)?.[1];
        if (island) {
          try {
            const config: unknown = JSON.parse(island);
            if (config && typeof config === "object" && "file" in config && "original" in config && typeof config.file === "string" && typeof config.original === "string") {
              const rendition = safeRelativePath(decodeURIComponent(config.file));
              const original = safeRelativePath(decodeURIComponent(config.original));
              if (rendition === filePath && await storage.sizeOf(site.id, version.id, original) !== null) context.originalFilePath = original;
            }
          } catch { /* Corrupt metadata cannot grant another path. */ }
        }
      }
    }
  }
  return context;
}
