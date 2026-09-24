import type { Permission, ResourceRole, ShareMode } from "@/lib/rbac";
import type { CommentScope, MainCommentPolicy } from "./contracts";

/** Trusted server facts only. Not a request schema or a substitute for resolving credentials.
 * Resolve this for the exact scope on every read and again inside each write transaction. */
export interface CommentAccessFacts {
  scope: CommentScope;
  userId: string | null;
  /** False for disabled accounts/tenants, deleted sites, unavailable versions or denied content. */
  canReadArtifact: boolean;
  /** Exact version readable without any share credential (public/member/explicit management). */
  canReadMainArtifact: boolean;
  canWriteArtifactDiscussion: boolean;
  /** Permanent site membership only; never the combined account/share authority. */
  accountRole: ResourceRole | null;
  permissions: readonly Permission[];
  /** Explicit, audited governance for this tenant/site; never inferred from a global role alone. */
  managementRole: "platform-admin" | "tenant-admin" | null;
  mainPolicy: MainCommentPolicy;
  /** Null when no active grant for this exact share AND version was verified. */
  shareMode: ShareMode | null;
}
export interface CommentPermissions {
  canRead: boolean; canCreate: boolean; canReply: boolean; canAggregate: boolean;
  canManageSettings: boolean; canModerate: boolean; canResolveAny: boolean;
}
export function sameCommentScope(a: CommentScope, b: CommentScope): boolean {
  return a.siteId === b.siteId && a.versionId === b.versionId && a.entry.kind === b.entry.kind
    && (a.entry.kind !== "share" || (b.entry.kind === "share" && a.entry.shareId === b.entry.shareId));
}
export function describeCommentPermissions(facts: CommentAccessFacts): CommentPermissions {
  const allows = (permission: Permission) => facts.permissions.includes(permission);
  const manager = allows("comment.aggregate");
  const identity = Boolean(facts.userId);
  // Management can inspect all spaces, including revoked shares; ordinary membership cannot.
  const readable = facts.scope.entry.kind === "share"
    ? manager || facts.shareMode === "comment" || facts.shareMode === "edit"
    : facts.canReadMainArtifact && (manager || (identity && facts.mainPolicy !== "off" && (facts.mainPolicy === "login" || allows("comment.read"))));
  const canRead = facts.canReadArtifact && readable;
  const write = canRead && identity && facts.canWriteArtifactDiscussion;
  const author = write && (facts.scope.entry.kind === "main" || facts.shareMode === "comment" || facts.shareMode === "edit");
  return {
    canRead, canCreate: author, canReply: author,
    canAggregate: facts.canReadArtifact && manager,
    canManageSettings: facts.canReadArtifact && identity && facts.canWriteArtifactDiscussion && manager,
    canModerate: write && allows("comment.moderate"),
    canResolveAny: write && allows("comment.resolve"),
  };
}
export interface CommentTarget {
  scope: CommentScope; threadCreatorId: string; messageAuthorId?: string; messageDeleted?: boolean;
}
export type CommentTargetAction = "edit" | "delete" | "resolve" | "reopen";
/** Identity comes from the verified session; target ownership comes from stored rows. */
export function canActOnComment(facts: CommentAccessFacts, action: CommentTargetAction, target: CommentTarget): boolean {
  if (!sameCommentScope(facts.scope, target.scope)) return false;
  const permissions = describeCommentPermissions(facts);
  if (!permissions.canRead || !facts.canWriteArtifactDiscussion || !facts.userId) return false;
  if (action === "resolve" || action === "reopen") return permissions.canResolveAny || (permissions.canCreate && target.threadCreatorId === facts.userId);
  if (target.messageDeleted || !target.messageAuthorId) return false;
  if (action === "edit") return permissions.canCreate && target.messageAuthorId === facts.userId;
  return action === "delete" && ((permissions.canCreate && target.messageAuthorId === facts.userId) || permissions.canModerate);
}
