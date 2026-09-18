import {
  commentResponse,
  commentBody,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { resolveCommentSchema } from "@/lib/comments/contracts";
import { resolveComment } from "@/lib/comments/service";
export function PATCH(
  request: Request,
  context: CommentRouteContext<{ slug: string; threadId: string }>,
) {
  return commentResponse(async () => {
    const { slug, threadId } = await context.params;
    return resolveComment(
      request,
      slug,
      threadId,
      resolveCommentSchema.parse(await commentBody(request)),
    );
  });
}
