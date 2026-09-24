import { mentionsSchema, type CommentMention } from "./mention-types";
import { z } from "zod";

/** Wire format version, independent of the artifact version being discussed. */
export const COMMENT_CONTRACT_VERSION = 1 as const;
export const COMMENT_LIMITS = { body: 10_000, quote: 2_000, selector: 2_000, pageSize: 100 } as const;
export const commentIdSchema = z.string().min(1).max(128);
const id = commentIdSchema;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const unit = z.number().finite().min(0).max(1);
const point = z.strictObject({ x: unit, y: unit });
const rect = z.strictObject({ x: unit, y: unit, width: unit.gt(0), height: unit.gt(0) })
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "Region exceeds the page");
const quote = z.strictObject({
  exact: z.string().min(1).max(COMMENT_LIMITS.quote),
  prefix: z.string().max(200).optional(), suffix: z.string().max(200).optional(),
});
const region = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("point"), point }),
  z.strictObject({ kind: z.literal("rect"), rect }),
]);

/** File paths are validated with safeRelativePath by the server parser, never used as URLs. */
export const commentAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("document"), schemaVersion: z.literal(1), filePath: z.string().min(1).max(1024) }),
  z.strictObject({
    kind: z.literal("html"), schemaVersion: z.literal(1), filePath: z.string().min(1).max(1024),
    selector: z.string().min(1).max(COMMENT_LIMITS.selector), quote: quote.optional(),
    rect: rect.optional(), viewport: z.strictObject({ width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) }),
  }),
  z.strictObject({
    kind: z.literal("image"), schemaVersion: z.literal(1), filePath: z.string().min(1).max(1024), region,
  }),
  z.strictObject({
    kind: z.literal("pdf"), schemaVersion: z.literal(1), filePath: z.string().min(1).max(1024),
    page: z.number().int().positive().max(1_000_000), region, quote: quote.optional(),
  }),
]);
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export const commentScopeSchema = z.strictObject({
  siteId: id, versionId: id,
  entry: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("main") }),
    z.strictObject({ kind: z.literal("share"), shareId: id }),
  ]),
});
export type CommentScope = z.infer<typeof commentScopeSchema>;
export const mainCommentPolicySchema = z.enum(["off", "login", "members"]);
export type MainCommentPolicy = z.infer<typeof mainCommentPolicySchema>;
export const DEFAULT_MAIN_COMMENT_POLICY: MainCommentPolicy = "login";
const body = z.string().trim().max(COMMENT_LIMITS.body);
const richFields = {
  mentions: mentionsSchema.optional(),
  bodyFormat: z.enum(["plain", "lightweight"]).optional(),
  attachmentIds: z.array(commentIdSchema).max(4).refine(ids => new Set(ids).size === ids.length, "Duplicate attachment").optional(),
};
const hasContent = (value: {body: string; attachmentIds?: string[]}) => Boolean(value.body.length || value.attachmentIds?.length);
export const createCommentSchema = z.strictObject({
  scope: commentScopeSchema, clientRequestId: z.uuid(), anchor: commentAnchorSchema, body, ...richFields,
}).refine(hasContent, "Comment needs text or an image");
export const replyCommentSchema = z.strictObject({ clientRequestId: z.uuid(), body, ...richFields }).refine(hasContent, "Comment needs text or an image");
export const editCommentSchema = z.strictObject({ expectedRevision: revision, body, ...richFields }).refine(value => value.attachmentIds === undefined || hasContent(value), "Comment needs text or an image");
export const deleteCommentSchema = z.strictObject({ expectedRevision: revision });
export const resolveCommentSchema = z.strictObject({ expectedRevision: revision, status: z.enum(["open", "resolved"]) });
export const commentSettingsSchema = z.strictObject({ mainPolicy: mainCommentPolicySchema });
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ReplyCommentInput = z.infer<typeof replyCommentSchema>;

/** Server-generated evidence, not arbitrary client metadata. Never include HTML or credentials. */
export interface CommentContext {
  schemaVersion: 1;
  excerpt: string | null;
  /** Office originals map to an immutable PDF rendition, not to editable source coordinates. */
  originalFilePath: string | null;
  rendition: { filePath: string; sha256: string } | null;
  assetIds: string[];
}
export interface CommentSpace extends CommentScope { id: string; createdAt: number }
export interface CommentThread {
  id: string;
  spaceId: string;
  /** Optional result association; the original scope and resolution remain unchanged. */
  resultVersionId?: string | null;
  resultVersionNumber?: number | null;
  resultAssociation?: { userId: string; at: number; actorKind: "user" | "agent" } | null;
  createdBy: string;
  anchor: CommentAnchor;
  context: CommentContext;
  resolution: { status: "open" } | { status: "resolved"; resolvedBy: string; resolvedByDisplayName?: string | null; resolvedAt: number };
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export const COMMENT_LOCATION_FLASH_MS = 1500;
export function commentReadScopeKey(versionId: string, shareId?: string, aggregate = false) {
  return aggregate ? "aggregate" : JSON.stringify([versionId, shareId ?? "main"]);
}
export const COMMENT_EMOJI = ["👍", "❤️", "🎉", "👀", "🙏", "😄"] as const;
/** A validated Unicode emoji sequence; shortcuts do not restrict allowed reactions. */
export type CommentEmoji = string;
export interface CommentReaction { emoji: CommentEmoji; count: number; reacted: boolean }
export const commentAttachmentSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.string().max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().positive().max(5 * 1024 * 1024),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
});
export type CommentAttachment = z.infer<typeof commentAttachmentSchema>;
export interface CommentMessage {
  attachments?: CommentAttachment[];
  reactions?: CommentReaction[];
  id: string;
  threadId: string;
  authorUserId: string;
  /** Safe account label; never includes email or uploaded HTML. */
  authorDisplayName?: string | null;
  isRoot: boolean;
  content: { state: "visible"; body: string; format?: "plain" | "lightweight"; mentions?: CommentMention[] } | { state: "deleted"; deletedAt: number; deletedBy: string };
  revision: number;
  createdAt: number;
  editedAt: number | null;
}
export interface CommentContextAsset {
  id: string; messageId: string; kind: "region_image" | "page_image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number; pixelWidth: number; pixelHeight: number; sha256: string;
  createdAt: number; deletedAt: number | null;
}
/** Storage keys are backend-only; readers receive an authorized asset route. */
export interface StoredCommentContextAsset extends CommentContextAsset { storageKey: string }
export interface StoredCommentMessage extends CommentMessage {
  clientRequestId: string;
  /** Immutable, keyed request digest for conflict detection; never serialize to readers. */
  requestFingerprint: string;
}
export interface CommentPage<T> { total?: number; items: T[]; nextCursor: string | null }
export interface CommentThreadDetail {
  searchMatch?: { messageId: string; excerpt: string };
  space: CommentSpace;
  thread: CommentThread;
  messages: CommentPage<CommentMessage>;
  /** Server-derived affordances, never persisted or accepted back as authorization. */
  permissions: {
    canReply: boolean;
    canAssociateResult?: boolean;
    canResolve: boolean;
    canReopen: boolean;
    messages: Record<string, { canEdit: boolean; canDelete: boolean }>;
  };
}
export const associateCommentSchema = z.strictObject({ expectedRevision: revision, versionId: id.nullable() });
export type AssociateCommentInput = z.infer<typeof associateCommentSchema>;
export type CommentListFilter =
  | { kind: "space"; scope: CommentScope; status?: "open" | "resolved"; q?: string; participated?: boolean; unread?: boolean; cursor?: string; limit?: number }
  | { kind: "aggregate"; authorUserId?: string; sort?: "activity" | "newest" | "oldest"; siteId: string; versionId?: string; entry?: CommentScope["entry"]; status?: "open" | "resolved"; q?: string; participated?: boolean; unread?: boolean; cursor?: string; limit?: number };
/** Site likes and authenticated message emoji use distinct actor and authorization rules. */
export type ReactionTarget = { kind: "site"; siteId: string } | { kind: "comment_message"; siteId: string; messageId: string };
export interface AgentCommentBundle {
  schemaVersion: 1;
  scope: CommentScope;
  threads: CommentThreadDetail[];
  /** Always explicit: comment access does not imply source export or editing. */
  capabilities: { canExportSource: boolean; canEditContent: boolean };
}

/** Untrusted preview events. The host binds channel + iframe Window + immutable scope. */
export const previewCommentEventSchema = z.strictObject({
  protocol: z.literal("artifact-comments"), schemaVersion: z.literal(1), channelId: z.uuid(),
  scope: commentScopeSchema,
  event: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("ready"), filePath: z.string().min(1).max(1024).optional() }),
    z.strictObject({ type: z.literal("selected"), anchor: commentAnchorSchema, position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional() }),
    z.strictObject({ type: z.literal("text-selected"), anchor: commentAnchorSchema, position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional() }),
    z.strictObject({ type: z.literal("cancelled") }),
    z.strictObject({ type: z.literal("activated"), threadId: id }),
    z.strictObject({ type: z.literal("located"), threadId: id, outcome: z.enum(["exact", "approximate", "missing"]) }),
  ]),
});
export type PreviewCommentEvent = z.infer<typeof previewCommentEventSchema>;
export type PreviewCommentCommand = {
  protocol: "artifact-comments"; schemaVersion: 1; channelId: string; scope: CommentScope;
  command: { type: "text-selection"; enabled: boolean; label: string } | { type: "select" } | { type: "cancel" } | { type: "markers"; visible: boolean; markers: { threadId: string; anchor: CommentAnchor }[] } | { type: "locate"; threadId: string; anchor: CommentAnchor };

};

export type EditCommentInput = z.infer<typeof editCommentSchema>;
export type DeleteCommentInput = z.infer<typeof deleteCommentSchema>;
export type ResolveCommentInput = z.infer<typeof resolveCommentSchema>;
export type CommentSettings = z.infer<typeof commentSettingsSchema>;
/** Accept decimal URL query strings or numbers; reject blank/null/boolean coercions. */
export const commentPaginationSchema = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.union([z.number(), z.string().regex(/^[0-9]+$/).transform(Number)]).pipe(z.number().int().min(1).max(COMMENT_LIMITS.pageSize)).default(30),
});

/** Parse Object.fromEntries(searchParams); duplicate keys must be rejected by the route. */
export const commentListQuerySchema = commentPaginationSchema.extend({
  versionId: id,
  shareId: id.optional(),
  status: z.enum(["open", "resolved"]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  participated: z.literal("true").transform(() => true).optional(),
  unread: z.literal("true").transform(() => true).optional(),
});
export const commentAggregateQuerySchema = commentPaginationSchema.extend({
  authorUserId: id.optional(),
  sort: z.enum(["activity", "newest", "oldest"]).optional(),
  versionId: id.optional(),
  shareId: id.optional(),
  entry: z.literal("main").optional(),
  status: z.enum(["open", "resolved"]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  participated: z.literal("true").transform(() => true).optional(),
  unread: z.literal("true").transform(() => true).optional(),
}).refine(value => !(value.shareId && value.entry), "Choose main or a share, not both");
