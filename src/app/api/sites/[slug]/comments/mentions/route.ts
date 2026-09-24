import { z } from "zod";
import {
  commentResponse,
  queryObject,
  type CommentRouteContext,
} from "@/lib/comments/http";
import { commentListQuerySchema } from "@/lib/comments/contracts";
import { commentSite } from "@/lib/comments/service";
import { requireCommentAccess } from "@/lib/comments/access";
import { mentionCandidatePage } from "@/lib/comments/mention-audience";
import { resolveSession } from "@/lib/session";
import { fail } from "@/lib/comments/store";
export function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    const { slug } = await context.params;
    const query = commentListQuerySchema
      .pick({ versionId: true, shareId: true })
      .extend({ q: z.string().max(100).default("") })
      .parse(queryObject(request));
    const session = await resolveSession(request);
    if (!session) return fail(401, "Authentication required");
    const site = await commentSite(slug),
      scope = {
        siteId: site.id,
        versionId: query.versionId,
        entry: query.shareId
          ? { kind: "share" as const, shareId: query.shareId }
          : { kind: "main" as const },
      };
    await requireCommentAccess(request, site, scope, session);
    return mentionCandidatePage(
      { site, scope, actorUserId: session.userId },
      query.q,
    );
  });
}
