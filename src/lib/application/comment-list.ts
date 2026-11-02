import { commentResponse, queryObject, type CommentRouteContext } from "@/lib/comments/http";
import { agentCommentListSchema, listAgentComments } from "@/lib/comments/agent-list";
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => listAgentComments(request, (await context.params).slug, agentCommentListSchema.parse(queryObject(request))));
}
