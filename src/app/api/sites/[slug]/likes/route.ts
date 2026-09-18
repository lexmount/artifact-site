import { z } from "zod";
import {
  commentResponse,
  commentBody,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { siteLikes } from "@/lib/comments/likes";
async function respond(
  request: Request,
  context: CommentRouteContext,
  write: boolean,
) {
  let cookie: string | null = null;
  const response = await commentResponse(async () => {
    const liked = write
      ? z.strictObject({ liked: z.boolean() }).parse(await commentBody(request))
          .liked
      : undefined;
    const result = await siteLikes(request, (await context.params).slug, liked);
    cookie = result.cookie;
    return { count: result.count, liked: result.liked };
  });
  if (cookie) response.headers.set("Set-Cookie", cookie);
  return response;
}
export function GET(request: Request, context: CommentRouteContext) {
  return respond(request, context, false);
}
export function PUT(request: Request, context: CommentRouteContext) {
  return respond(request, context, true);
}
