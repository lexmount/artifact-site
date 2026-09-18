import { canShowCommentScope } from "./comment-view";
import { z } from "zod";
import {
  COMMENT_LIMITS,
  commentScopeSchema,
  commentAnchorSchema,
  type CommentAnchor,
  type CommentScope,
} from "@/lib/comments/contracts";
export interface CommentDraft {
  kind: "create" | "reply" | "edit";
  body: string;
  requestId: string | null;
  scope: CommentScope;
  anchor?: CommentAnchor;
  threadId?: string;
  messageId?: string;
  revision?: number;
  updatedAt: number;
}
const PREFIX = "artifact:comment-drafts:v1:";
export function draftBucket(userId: string, siteId: string) {
  return PREFIX + JSON.stringify([userId, siteId]);
}
export function draftIdentity(draft: Pick<CommentDraft, "kind" | "scope" | "threadId" | "messageId">) {
  return JSON.stringify([
    draft.scope.versionId,
    draft.scope.entry,
    draft.kind,
    draft.threadId ?? "",
    draft.messageId ?? "",
  ]);
}
const draftBase = {
  body: z.string().max(COMMENT_LIMITS.body), requestId: z.uuid().nullable(),
  scope: commentScopeSchema, updatedAt: z.number().finite().nonnegative(),
};
const draftId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const draftSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...draftBase, kind: z.literal("create"), anchor: commentAnchorSchema }),
  z.strictObject({ ...draftBase, kind: z.literal("reply"), threadId: draftId }),
  z.strictObject({ ...draftBase, kind: z.literal("edit"), threadId: draftId, messageId: draftId, revision: z.number().int().positive() }),
]);
export function readDrafts(storage: Storage, bucket: string): Record<string, CommentDraft> {
  try {
    const value = JSON.parse(storage.getItem(bucket) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
      const parsed = draftSchema.safeParse(raw);
      if (!parsed.success) return [];
      const d = parsed.data;
      return d.updatedAt <= Date.now() && Date.now() - d.updatedAt < 7 * 86400000 && key === draftIdentity(d) ? [[key, d]] : [];
    }));
  } catch { return {}; }
}
export function writeDrafts(storage: Storage, bucket: string, drafts: Record<string, CommentDraft>) {
  const recent = Object.entries(drafts).filter(([, draft]) => draft.body.trim())
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 32)
    .map(([key, draft]) => [key, { ...draft, scope: {
      siteId: draft.scope.siteId, versionId: draft.scope.versionId, entry: draft.scope.entry,
    } }]);
  storage.setItem(bucket, JSON.stringify(Object.fromEntries(recent)));
}

export function stampDraft(draft: CommentDraft): CommentDraft { return { ...draft, updatedAt: Date.now() }; }

/** Discovery only: restoring or writing still checks the target discussion permissions. */
export function canRecoverCommentDraft(draft: CommentDraft, scope: CommentScope, aggregate: boolean, readVersions: boolean): boolean {
  return Boolean(draft.body.trim()) && (canShowCommentScope(draft.scope, scope, false) ||
    (scope.entry.kind === "main" && draft.scope.siteId === scope.siteId &&
      (draft.scope.entry.kind === "main" ? readVersions : aggregate && draft.kind !== "create")));
}
