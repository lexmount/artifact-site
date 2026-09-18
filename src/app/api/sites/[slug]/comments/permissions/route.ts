import {
  commentResponse,
  queryObject,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { commentListQuerySchema } from "@/lib/comments/contracts";
import { commentSite, getCommentPermissions } from "@/lib/comments/service";
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    const { slug } = await context.params;
    const query = commentListQuerySchema
      .pick({ versionId: true, shareId: true })
      .parse(queryObject(request));
    const site = await commentSite(slug);
    return getCommentPermissions(request, slug, {
      siteId: site.id,
      versionId: query.versionId,
      entry: query.shareId
        ? { kind: "share", shareId: query.shareId }
        : { kind: "main" },
    });
  });
}
