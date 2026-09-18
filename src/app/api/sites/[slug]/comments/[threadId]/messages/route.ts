import {
  commentResponse,
  commentBody,
  queryObject,
  type CommentRouteContext,
} from "@/lib/comments/http";
import {
  commentPaginationSchema,
  replyCommentSchema,
} from "@/lib/comments/contracts";
import { getMessages, replyComment } from "@/lib/comments/service";
export function GET(
  request: Request,
  context: CommentRouteContext<{ slug: string; threadId: string }>,
) {
  return commentResponse(async () => {
    const { slug, threadId } = await context.params;
    const query = commentPaginationSchema.parse(queryObject(request));
    return getMessages(request, slug, threadId, query.cursor, query.limit);
  });
}
export function POST(
  request: Request,
  context: CommentRouteContext<{ slug: string; threadId: string }>,
) {
  return commentResponse(async () => {
    const { slug, threadId } = await context.params;
    return replyComment(
      request,
      slug,
      threadId,
      replyCommentSchema.parse(await commentBody(request)),
    );
  });
}
