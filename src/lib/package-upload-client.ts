import { archiveFormat, DEFAULT_ARCHIVE_MAX_BYTES, type PackageOptions } from "@/lib/package-contract";
export type PackagePickedFiles = { path: string; file: File }[] & { folder?: boolean; directories?: string[]; normalized?: boolean };
export function packageForFiles(files: PackagePickedFiles): PackageOptions | undefined {
  if (files.folder || files.directories?.length || files.some(f => f.path.includes("/") || f.file.webkitRelativePath)) return { source: "folder", directories: files.directories ?? [] };
  if (files.length === 1 && archiveFormat(files[0].path)) return { source: "archive", name: files[0].file.name };
  if (files.length > 1 || (files.length === 1 && !/\.(html?|pdf|pptx?|docx?)$/i.test(files[0].path))) return { source: "folder", directories: [] };
}
export function checkArchiveSize(files: PackagePickedFiles, options: PackageOptions, cap = DEFAULT_ARCHIVE_MAX_BYTES) {
  if (options.source === "archive" && files[0].file.size > cap) return false;
  return true;
}

export async function packageUploadLimit(request: typeof fetch, t: (message: string) => string, headers: HeadersInit = {}): Promise<number> {
  const response = await request("/api/auth/me", { headers });
  const data = await response.json();
  if (!response.ok || data.uploadLimits?.packageUploads !== 1) throw new Error(t("This server does not support file packages. Upgrade the server first."));
  const limit = data.uploadLimits.archiveMaxBytes;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_ARCHIVE_MAX_BYTES;
}


/** Browser selections include the selected wrapper; archive paths never pass here. */
export function normalizePickedFolder(files: PackagePickedFiles): PackagePickedFiles {
  if (!files.folder || files.normalized) return files;
  const paths = [...files.map(f => f.path), ...(files.directories ?? [])];
  const root = paths[0]?.split("/")[0];
  const strip = root && root !== "." && root !== ".." && paths.every(p => p === root || p.startsWith(root + "/")) && files.every(f => f.path !== root);
  const relative = (p: string) => strip ? p.slice(root.length + 1) : p;
  // Unsafe paths must still reach validation, even when their final segment looks like junk.
  const ignored = (p: string) => {
    const parts = p.split(/[\\/]/);
    return !parts.some(part => !part || part === "." || part === "..") && parts.some(part => [".DS_Store", "Thumbs.db", "__MACOSX"].includes(part));
  };
  const result = files.filter(f => !ignored(f.path)).map(f => ({ ...f, path: relative(f.path) }));
  const directories = (files.directories ?? []).filter(p => !ignored(p)).map(relative).filter(Boolean);
  if (!result.length && !directories.length && root && strip) directories.push(root);
  return Object.assign(result, { folder: true, directories, normalized: true });
}

/** Keep actionable server validation messages, but never leave users with a bare 500 label. */
export function uploadFailureMessage(error: unknown, fallback: string, t: (message: string) => string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (message === "internal error") return t("The server could not process this upload. Try again. If it still fails, ask the administrator to check the upload logs.");
  return message || fallback;
}
