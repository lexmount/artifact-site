import { z } from "zod";
import {
  commentResponse,
  commentBody,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { subscription } from "@/lib/notifications/service";
type Context = CommentRouteContext<{ slug: string; threadId: string }>;
export function GET(request: Request, context: Context) {
  return commentResponse(async () => {
    const { slug, threadId } = await context.params;
    return subscription(request, slug, threadId);
  });
}
export function POST(request: Request, context: Context) {
  return commentResponse(async () => {
    const { slug, threadId } = await context.params;
    const { following } = z
      .object({ following: z.boolean() })
      .strict()
      .parse(await commentBody(request));
    return subscription(request, slug, threadId, following);
  });
}
