import {
  commentResponse,
  commentBody,
  queryObject,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { commentListQuerySchema } from "@/lib/comments/contracts";
import { parseCreateComment } from "@/lib/comments/validation";
import {
  commentSite,
  listComments,
  createComment,
} from "@/lib/comments/service";
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    const { slug } = await context.params;
    const query = commentListQuerySchema.parse(queryObject(request));
    const site = await commentSite(slug);
    return listComments(request, slug, {
      kind: "space",
      scope: {
        siteId: site.id,
        versionId: query.versionId,
        entry: query.shareId
          ? { kind: "share", shareId: query.shareId }
          : { kind: "main" },
      },
      status: query.status,
      q: query.q,
      participated: query.participated,
      unread: query.unread,
      cursor: query.cursor,
      limit: query.limit,
    });
  });
}
export async function POST(request: Request, context: CommentRouteContext) {
  let replayed = false;
  const response = await commentResponse(async () => {
    const result = await createComment(
      request,
      (await context.params).slug,
      parseCreateComment(await commentBody(request)),
    );
    replayed = result.replayed;
    return result.detail;
  }, 201);
  if (replayed && response.status === 201)
    return new Response(response.body, {
      status: 200,
      headers: response.headers,
    });
  return response;
}
