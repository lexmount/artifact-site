// Pure permission catalog. Resource and credential checks belong to rbac-access.ts.
export const INIT_TENANT = "init";
export const ANONYMOUS_TENANT = "anonymous";
export type TenantRole = "admin" | "member";
export type SiteRole = "admin" | "editor";
export type ShareMode = "view" | "comment" | "edit";
export type ResourceRole =
  | "platform-admin"
  | "tenant-admin"
  | "tenant-member"
  | "owner"
  | "site-admin"
  | "editor"
  | "commenter"
  | "viewer";
export const PERMISSIONS = [
  "platform.tenants.manage",
  "platform.users.manage",
  "site.create",
  "tenant.manage",
  "tenant.members.manage",
  "site.read",
  "site.content.edit",
  "site.history.read",
  "site.rename",
  "site.version.rollback",
  "site.sharing.manage",
  "site.members.manage",
  "site.admins.manage",
  "site.delete",
  "site.owner.transfer",
  "site.audit.read",
  "site.source.export",
  "comment.read",
  "comment.create",
  "comment.reply",
  "comment.editOwn",
  "comment.deleteOwn",
  "comment.resolveOwn",
  "comment.moderate",
  "comment.aggregate",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
const comments: Permission[] = [
  "comment.read",
  "comment.create",
  "comment.reply",
  "comment.editOwn",
  "comment.deleteOwn",
  "comment.resolveOwn",
];
const editor: Permission[] = [
  "site.read",
  "site.content.edit",
  "site.history.read",
  "site.source.export",
  ...comments,
];
const manager: Permission[] = [
  ...editor,
  "site.rename",
  "site.version.rollback",
  "site.sharing.manage",
  "site.members.manage",
  "site.audit.read",
  "comment.moderate",
  "comment.aggregate",
];
const owner: Permission[] = [
  ...manager,
  "site.admins.manage",
  "site.delete",
  "site.owner.transfer",
];
export const ROLE_PERMISSIONS: Record<ResourceRole, readonly Permission[]> = {
  "platform-admin": PERMISSIONS,
  "tenant-admin": PERMISSIONS.filter((p) => !p.startsWith("platform.")),
  "tenant-member": ["site.create"],
  owner,
  "site-admin": manager,
  editor,
  commenter: ["site.read", ...comments],
  viewer: ["site.read"],
};
export function roleAllows(
  role: ResourceRole | null,
  permission: Permission,
): boolean {
  return role !== null && ROLE_PERMISSIONS[role].includes(permission);
}
export interface Tenant {
  id: string;
  name: string;
  disabledAt: number | null;
}
export interface TenantMember {
  tenantId: string;
  userId: string;
  role: TenantRole;
}
export interface ShareAuthorization {
  mode: ShareMode;
  versionId: string | null;
}
