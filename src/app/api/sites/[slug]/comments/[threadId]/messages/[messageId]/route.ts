import {
  commentResponse,
  commentBody,
  type CommentRouteContext,
} from "@/lib/comments/http";
import {
  editCommentSchema,
  deleteCommentSchema,
} from "@/lib/comments/contracts";
import { mutateMessage } from "@/lib/comments/service";
export function PATCH(
  request: Request,
  context: CommentRouteContext<{
    slug: string;
    threadId: string;
    messageId: string;
  }>,
) {
  return commentResponse(async () => {
    const { slug, threadId, messageId } = await context.params;
    return mutateMessage(
      request,
      slug,
      threadId,
      messageId,
      editCommentSchema.parse(await commentBody(request)),
      "edit",
    );
  });
}
export function DELETE(
  request: Request,
  context: CommentRouteContext<{
    slug: string;
    threadId: string;
    messageId: string;
  }>,
) {
  return commentResponse(async () => {
    const { slug, threadId, messageId } = await context.params;
    return mutateMessage(
      request,
      slug,
      threadId,
      messageId,
      deleteCommentSchema.parse(await commentBody(request)),
      "delete",
    );
  });
}
