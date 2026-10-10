import { z } from "zod";
export const sharingPolicySchema = z
  .object({
    audience: z.enum(["private", "tenant", "login", "anyone", "public"]),
    comments: z.boolean(),
  })
  .strict();
export type SharingPolicy = z.infer<typeof sharingPolicySchema>;
export type SharingSource = "default" | "manual" | "folder" | "all";
export const AUDIENCE_LABELS: Record<SharingPolicy["audience"], string> = {
  private: "Only me",
  tenant: "Members of each document's tenant",
  login: "All signed-in users",
  anyone: "Anyone",
  public: "Public (listed in Home — Discover sites)",
};
export interface SharingState {
  policy: SharingPolicy;
  source: SharingSource;
  sourceId: string | null;
  sourceName: string | null;
  revision: number;
  pending: boolean;
}
export interface SharingImpact {
  slug: string;
  title: string;
  tenantName: string;
  before: SharingPolicy;
  after: SharingPolicy;
  source: SharingSource;
  sourceName: string | null;
  changed: boolean;
}
export interface SharingPreview {
  confirmation: string;
  items: SharingImpact[];
  excluded: number;
  unchanged: number;
  applied?: boolean;
  pending?: number;
}
export interface ScopeSettings {
  enabled: boolean;
  policy: SharingPolicy;
  url: string | null;
  name: string;
  folderId: string | null;
  eligible: number;
  following: number;
  custom: number;
  folders: number;
  excluded: number;
}
