import { z } from "zod";
import { commentUnread } from "@/lib/comments/service";
import { commentResponse, commentBody, queryObject, type CommentRouteContext } from "@/lib/comments/http";
const base = z.object({versionId:z.string().min(1).max(128),shareId:z.string().min(1).max(128).optional(),aggregate:z.boolean().optional()}).strict();
const query = base.extend({aggregate:z.enum(["true","false"]).transform(v=>v==="true").optional(),since:z.coerce.number().int().nonnegative().optional()});
const body = base.extend({messageIds:z.array(z.string().min(1).max(128)).max(100).optional(),through:z.number().int().nonnegative().optional()});
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => commentUnread(request,(await context.params).slug,query.parse(queryObject(request))));
}
export function POST(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => commentUnread(request,(await context.params).slug,body.parse(await commentBody(request))));
}
