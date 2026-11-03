import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";
export type BulkSharingChanges = { audience?: "private" | "tenant" | "login" | "anyone"; comments?: boolean; listInDiscover?: boolean };
export type BulkSharingItem = SharingState & {
  slug: string;
  title: string;
  requestedPolicy: SharingPolicy | null;
  after: SharingPolicy;
  changed: boolean;
};
export interface BulkSharingPreview {
  snapshot: string;
  confirmation: string;
  items: BulkSharingItem[];
  canSelectOrganization: boolean;
  updated: number;
  pending: number;
  unchanged: number;
  applied?: boolean;
}
/** Omitting a field preserves each site's value, including Discover listing. */
export function bulkSharingPolicy(policy: SharingPolicy, changes: BulkSharingChanges): SharingPolicy {
  return {
    audience: changes.audience === "anyone" && (changes.listInDiscover ?? (policy.audience === "public")) ? "public" : changes.audience ?? policy.audience,
    comments: changes.comments ?? policy.comments,
  };
}
export function bulkSharingEffects(items: BulkSharingItem[], changes: BulkSharingChanges) {
  return items.reduce((result, item) => {
    const before = item.requestedPolicy ?? item.policy, after = bulkSharingPolicy(before, changes);
    const changed = before.audience !== after.audience || before.comments !== after.comments;
    if (changed && ["folder", "all"].includes(item.source)) result.detach++;
    if (changes.audience === "anyone") result.anyone++;
    if (changed && before.audience === "public" && after.audience !== "public") result.unlist++;
    return result;
  }, { detach: 0, anyone: 0, unlist: 0 });
}
