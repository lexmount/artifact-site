import {
  commentResponse,
  assertNoCommentQuery,
  commentBody,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { commentSettingsSchema } from "@/lib/comments/contracts";
import { commentSettings } from "@/lib/comments/service";
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    assertNoCommentQuery(request);
    return commentSettings(request, (await context.params).slug);
  });
}
export function PATCH(request: Request, context: CommentRouteContext) {
  return commentResponse(async () =>
    commentSettings(
      request,
      (await context.params).slug,
      commentSettingsSchema.parse(await commentBody(request)),
    ),
  );
}
