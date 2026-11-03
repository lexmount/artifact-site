import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";

export type AccessAudience = Exclude<SharingPolicy["audience"], "public">;
export const MAIN_ACCESS_LABELS: Record<AccessAudience, string> = {
  private: "Private",
  tenant: "Members of this organization",
  login: "Users who are signed in",
  anyone: "Anyone",
  passcode: "People with the passcode",
};
export const MAIN_ACCESS_HINTS: Record<AccessAudience, string> = {
  private: "Only the creator and authorized members can access.",
  tenant: "Open the link and sign in with an account in this organization.",
  login: "Open the link and sign in to access.",
  anyone: "Anyone with the link can access, without signing in or entering a passcode.",
  passcode: "Open the link and enter the correct passcode to access.",
};
/** Public is the existing server policy for anonymous access plus Discover listing. */
export function accessAudience(policy: SharingPolicy): AccessAudience {
  return policy.audience === "public" ? "anyone" : policy.audience;
}
export function changeAudience(policy: SharingPolicy, audience: AccessAudience): SharingPolicy {
  return { ...policy, audience: policy.audience === "public" && audience === "anyone" ? "public" : audience };
}
export function changeDiscovery(policy: SharingPolicy, listed: boolean): SharingPolicy {
  return { ...policy, audience: listed && ["anyone", "public"].includes(policy.audience) ? "public" : policy.audience === "public" ? "anyone" : policy.audience };
}
export function sharingChangeEffects(current: SharingState, next: SharingPolicy) {
  const publicAccess = !["anyone", "public"].includes(current.policy.audience) && ["anyone", "public"].includes(next.audience);
  const listing = current.policy.audience !== "public" && next.audience === "public";
  const unlist = current.policy.audience === "public" && !["public", "anyone"].includes(next.audience);
  const detach = current.source === "folder" || current.source === "all";
  return { publicAccess, listing, unlist, detach, confirm: publicAccess || unlist };
}
export type DocumentSharingState = SharingState & {
  passcode?: string | null;
  organization?: { name: string; canSelect: boolean };
  links: number;
  members: number;
  canStop: boolean;
  follow: Pick<SharingState, "policy" | "source" | "sourceId" | "sourceName"> | null;
};
export function canStopSharing(data: DocumentSharingState) {
  return data.canStop && (data.policy.audience !== "private" || data.links > 0 || data.members > 0 || data.pending || data.source === "folder" || data.source === "all");
}
