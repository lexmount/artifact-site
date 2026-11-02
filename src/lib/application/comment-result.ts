import { commentResponse, commentBody, assertNoCommentQuery, type CommentRouteContext } from "@/lib/comments/http";
import { associateCommentSchema } from "@/lib/comments/contracts";
import { associateCommentResult, commentResultOptions } from "@/lib/comments/service";
export function PATCH(request: Request, context: CommentRouteContext<{slug: string; threadId: string}>) {
  return commentResponse(async () => {
    const {slug, threadId} = await context.params;
    return associateCommentResult(request, slug, threadId, associateCommentSchema.parse(await commentBody(request)));
  });
}

export function GET(request: Request, context: CommentRouteContext<{slug:string;threadId:string}>) {
  return commentResponse(async () => { assertNoCommentQuery(request); const {slug,threadId}=await context.params; return commentResultOptions(request,slug,threadId); });
}
