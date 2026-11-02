/** Version-scoped package metadata. Missing metadata means a legacy website. */
export const PACKAGE_DIR = ".artifact-package";
export const PACKAGE_ENTRY = `${PACKAGE_DIR}/directory.html`;
export const PACKAGE_ORIGINAL = `${PACKAGE_DIR}/original`;
export const DEFAULT_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export type ArchiveFormat = "zip" | "rar" | "7z" | "tar" | "tar.gz";
export interface PackageFile { path: string; size: number }
export interface PackageMeta {
  source: "folder" | "archive";
  files: PackageFile[];
  directories: string[];
  ignored: string[];
  archive?: { name: string; format: ArchiveFormat; size: number; sha256: string };
}
export interface PackageOptions {
  source: "folder" | "archive";
  name?: string;
  directories?: string[];
}
export function archiveFormat(name: string): ArchiveFormat | undefined {
  const extension = /\.(tar\.gz|tgz|tar|zip|rar|7z)$/i.exec(name)?.[1].toLowerCase();
  return (extension === "tgz" ? "tar.gz" : extension) as ArchiveFormat | undefined;
}
export function isPackageInternal(path: string): boolean { return path.split("/")[0] === PACKAGE_DIR; }
