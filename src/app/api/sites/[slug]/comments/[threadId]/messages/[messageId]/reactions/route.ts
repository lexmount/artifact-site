import { z } from "zod";
import { isCommentEmoji } from "@/lib/comments/emoji";
import { commentResponse, commentBody, type CommentRouteContext } from "@/lib/comments/http";
import { setCommentReaction } from "@/lib/comments/service";
const schema = z.object({ emoji: z.string().max(128).refine(isCommentEmoji, "Expected one Unicode emoji"), reacted: z.boolean() }).strict();
export function PUT(request: Request, context: CommentRouteContext<{slug: string; threadId: string; messageId: string}>) {
  return commentResponse(async () => {
    const {slug,threadId,messageId} = await context.params;
    const input = schema.parse(await commentBody(request));
    return setCommentReaction(request,slug,threadId,messageId,input.emoji,input.reacted);
  });
}
