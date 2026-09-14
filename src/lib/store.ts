// Facade over the storage backend. Historically this file held the fs code directly; that now
// lives in storage.ts behind the Storage interface. Callers keep importing the same names from
// "@/lib/store"; each write helper just delegates to the active backend (local today, S3 later).
import { getStorage } from "@/lib/storage";
import type { UploadFile } from "@/lib/types";

// Path guards + layout + pure limit check re-exported unchanged (preview, upload, tests use these).
export { safeRelativePath, resolveInside, siteDir, versionDir, storageKey, assertWithinLimits } from "@/lib/storage";

export function writeVersionFiles(siteId: string, versionId: string, files: readonly UploadFile[]): Promise<{ fileCount: number; byteSize: number }> {
  return getStorage().writeVersionFiles(siteId, versionId, files);
}

export function writeFileToVersion(siteId: string, versionId: string, relpath: string, bytes: Uint8Array): Promise<void> {
  return getStorage().writeFileToVersion(siteId, versionId, relpath, bytes);
}

export function copyVersionTree(siteId: string, fromVersionId: string, toVersionId: string, toSiteId?: string): Promise<void> {
  return getStorage().copyVersionTree(siteId, fromVersionId, toVersionId, toSiteId);
}

export function measureVersion(siteId: string, versionId: string): Promise<{ fileCount: number; byteSize: number }> {
  return getStorage().measureVersion(siteId, versionId);
}

export function removeVersion(siteId: string, versionId: string): Promise<void> {
  return getStorage().removeVersion(siteId, versionId);
}

export function removeSite(siteId: string): Promise<void> {
  return getStorage().removeSite(siteId);
}
