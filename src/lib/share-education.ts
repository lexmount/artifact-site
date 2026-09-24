/** Acknowledgements belong to a viewer and a site; link history comes from the server. */
export const SHARE_EDUCATION_LIMIT = 3;
export const SHARE_LINK_CREATED_EVENT = "artifact-site:share-link-created";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export function isShareEducationStorageKey(key: string | null): boolean {
  return key === null || key.startsWith("artifact-site:share-education:v2:");
}
export function educationKey(scope: string, slug: string): string {
  return `artifact-site:share-education:v2:${encodeURIComponent(scope)}:${encodeURIComponent(slug)}`;
}
export function readAcknowledgements(storage: StorageLike | null, scope: string, slug: string): number {
  try {
    const count = Number(storage?.getItem(educationKey(scope, slug)) ?? 0);
    return Number.isFinite(count) ? Math.min(3, Math.max(0, Math.floor(count))) : 0;
  } catch { return 0; }
}
export function acknowledgeShareEducation(storage: StorageLike | null, scope: string, slug: string): number {
  const count = Math.min(3, readAcknowledgements(storage, scope, slug) + 1);
  try { storage?.setItem(educationKey(scope, slug), String(count)); } catch { /* Current visit still dismisses. */ }
  return count;
}
export function shouldShowShareEducation(acknowledgements: number, linksCreated: number): boolean {
  return acknowledgements < SHARE_EDUCATION_LIMIT && linksCreated < SHARE_EDUCATION_LIMIT;
}
/** A successful mutation invalidates history; unavailable storage must not break link copying. */
export function recordShareLinkCreated(): void { window.dispatchEvent(new Event(SHARE_LINK_CREATED_EVENT)); }
