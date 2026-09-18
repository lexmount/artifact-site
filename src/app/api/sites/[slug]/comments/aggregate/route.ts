import { commentAggregateQuerySchema } from "@/lib/comments/contracts";
import { commentResponse, queryObject, type CommentRouteContext } from "@/lib/comments/http";
import { listAggregate } from "@/lib/comments/service";
export async function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    const { slug } = await context.params;
    return listAggregate(request, slug, commentAggregateQuerySchema.parse(queryObject(request)));
  });
}
