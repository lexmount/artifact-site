import { assertNoCommentQuery, commentResponse, type CommentRouteContext } from "@/lib/comments/http";
import { getCommentDetail } from "@/lib/comments/service";
export function GET(
  request: Request,
  context: CommentRouteContext<{ slug: string; threadId: string }>,
) {
  return commentResponse(async () => {
    assertNoCommentQuery(request);
    const { slug, threadId } = await context.params;
    return getCommentDetail(request, slug, threadId);
  });
}
