import { previewCommentEventSchema, type CommentScope, type PreviewCommentEvent } from "./contracts";

export const COMMENT_PREVIEW_MESSAGE_LIMIT = 64 * 1024;
export function sameCommentScope(a: CommentScope, b: CommentScope): boolean {
  return a.siteId === b.siteId && a.versionId === b.versionId && a.entry.kind === b.entry.kind &&
    (a.entry.kind !== "share" || (b.entry.kind === "share" && a.entry.shareId === b.entry.shareId));
}
/** A channel routes untrusted candidates; it is never a write credential. */
export function acceptPreviewCommentEvent(
  event: Pick<MessageEvent, "source" | "data">,
  expected: { source: MessageEventSource | null; channelId: string; scope: CommentScope; selecting: boolean; pendingThreadId?: string | null; visibleThreadIds?: readonly string[] },
): PreviewCommentEvent | null {
  if (!expected.source || event.source !== expected.source) return null;
  try {
    if (JSON.stringify(event.data).length > COMMENT_PREVIEW_MESSAGE_LIMIT) return null;
    const parsed = previewCommentEventSchema.safeParse(event.data);
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.channelId !== expected.channelId || !sameCommentScope(value.scope, expected.scope)) return null;
    if ((value.event.type === "selected" || value.event.type === "cancelled") && !expected.selecting) return null;
    if (value.event.type === "located" && value.event.threadId !== expected.pendingThreadId) return null;
    if (value.event.type === "activated" && !expected.visibleThreadIds?.includes(value.event.threadId)) return null;
    return value;
  } catch { return null; }
}
