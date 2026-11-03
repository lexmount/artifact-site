import type { SharingPreview } from "@/lib/sharing-policy";

export function draggedSites(slug: string, selected: readonly string[]): string[] {
  return selected.includes(slug) ? [...selected] : [slug];
}

/** Items include changes to inheritance even when access and comments stay the same. */
export function needsMoveConfirmation(preview: SharingPreview): boolean {
  return preview.items.length > 0;
}
