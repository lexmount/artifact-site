import { getAgentContext } from "@/lib/comments/agent-context";
import { commentResponse, queryObject, type CommentRouteContext } from "@/lib/comments/http";
import { z } from "zod";
export async function GET(request: Request, context: CommentRouteContext<{ slug: string; threadId: string }>) {
  return commentResponse(async () => {
    z.strictObject({}).parse(queryObject(request));
    const { slug, threadId } = await context.params;
    return getAgentContext(request, slug, threadId);
  });
}
