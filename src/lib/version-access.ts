import type { Site } from "@/lib/types";
/** Shared range predicate; callers must first verify identity, admission and resource state. */
export function readerVersionAllowed(site: Pick<Site, "currentVersionId" | "officialVersionId">, versionId: string, fixedVersionId?: string | null): boolean {
  return fixedVersionId ? versionId === fixedVersionId : versionId === site.currentVersionId || versionId === site.officialVersionId;
}
