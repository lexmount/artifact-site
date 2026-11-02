/** Browser-safe equivalent of storage.safeRelativePath. Kept standalone for sandbox serialization. */
export function canonicalPreviewPath(input: string, packagePaths = false): string | null {
  const value = input.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  const bytes = (part: string) => new TextEncoder().encode(part).byteLength;
  if (!value || value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value) || bytes(value) > 1024) return null;
  if (value.split("/").some(part => !part || part === "." || part === ".." || (!packagePaths && [".git", "node_modules"].includes(part.toLowerCase())) || bytes(part) > 255)) return null;
  return value;
}
