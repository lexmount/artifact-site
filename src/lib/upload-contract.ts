/** Dependency-free upload contract shared by the server, browser, and published CLI.
 * Regenerate the CLI copy after changes: npm run generate:upload-contract.
 * Routing, ZIP extraction, presentation, and environment overrides belong to each client.
 */
const MiB = 1024 * 1024;

export interface UploadLimits { maxBytes: number; maxFileBytes: number; maxFiles: number }
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 300 * MiB,
  maxFileBytes: 250 * MiB,
  maxFiles: 2000,
};
export const DEFAULT_INLINE_BODY_MAX_BYTES = 24 * MiB;
/** Browser payload budget leaves room for multipart framing below the default body ceiling.
 * This is a routing policy, not the configured server limit. The CLI retains its 24 MiB policy
 * and can retry a confirmed no-effect body rejection through individual file uploads.
 */
export const BROWSER_INLINE_PAYLOAD_MAX_BYTES = 20 * MiB;

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".pptx", ".ppt", ".docx", ".doc"]);
export type UploadFileKind = "html" | "document" | "zip";
export function uploadFileKind(name: string): UploadFileKind | undefined {
  const extension = /\.[^./\\]+$/.exec(name)?.[0].toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension && DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (extension === ".zip") return "zip";
}

/** Chunked commit accepts HTML trees and single PDFs, not Office conversion or legacy .htm. */
export function supportsChunkedSingleFile(name: string): boolean {
  return /\.(html|pdf)$/i.test(name);
}

/** A gateway's generic 413 does not prove publication had no effect. */
export function isInlineUploadRejection(status: number, body: unknown): boolean {
  if (status !== 413 || !body || typeof body !== "object") return false;
  const error = body as { code?: unknown; effect?: unknown };
  return error.code === "inline_upload_too_large" && error.effect === "none";
}
