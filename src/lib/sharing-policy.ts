import { z } from "zod";
export const sharingPolicySchema = z
  .object({
    audience: z.enum(["private", "tenant", "login", "anyone", "public", "passcode"]),
    comments: z.boolean(),
  })
  .strict();
export const inheritedSharingPolicySchema = sharingPolicySchema.refine(p => p.audience !== "passcode", "Passcodes are configured per artifact");
export type SharingPolicy = z.infer<typeof sharingPolicySchema>;
export type SharingSource = "default" | "manual" | "folder" | "all";
export const AUDIENCE_LABELS: Record<SharingPolicy["audience"], string> = {
  private: "Private",
  passcode: "People with the passcode",
  tenant: "Members of this organization",
  login: "Users who are signed in",
  anyone: "Anyone",
  public: "Public (listed in Home — Discover sites)",
};
export function canSelectOrganization(userTenantId: string | null | undefined, siteTenantId?: string): boolean {
  const real = (id: string | null | undefined) => Boolean(id && !["init", "anonymous"].includes(id));
  return real(userTenantId) && (siteTenantId === undefined || real(siteTenantId));
}
export function accessAudiences(organization: boolean, passcode = false): Exclude<SharingPolicy["audience"], "public">[] {
  return ["private", ...(organization ? ["tenant" as const] : []), "login", ...(passcode ? ["passcode" as const] : []), "anyone"];
}
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
export interface ScopePreview extends SharingPreview {
  scope: { enabled: boolean; revision: number };
  requiresConfirmation: boolean;
}
export interface ScopeSettings {
  canSelectOrganization: boolean;
  enabled: boolean;
  revision: number;
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
