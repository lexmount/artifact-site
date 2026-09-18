import { fail } from "@/lib/comments/store";
import { listVersions, listShares, rbacQuery } from "@/lib/db";
import { commentSite, getCommentPermissionsForSite } from "@/lib/comments/service";
import { assertNoCommentQuery, commentResponse, type CommentRouteContext } from "@/lib/comments/http";
export async function GET(request: Request, context: CommentRouteContext) {
  return commentResponse(async () => {
    assertNoCommentQuery(request);
    const { slug } = await context.params;
    const site = await commentSite(slug);
    const access = await getCommentPermissionsForSite(request, site, {
      siteId: site.id,
      versionId: site.currentVersionId,
      entry: { kind: "main" },
    });
    if (!access.canAggregate) fail(404, "Not found");
    const [versions, shares, authors] = await Promise.all([
      listVersions(site.id),
      listShares(site.id),
      rbacQuery(
        "SELECT DISTINCT u.id,u.display_name FROM comment_threads t JOIN comment_spaces s ON s.id=t.space_id JOIN users u ON u.id=t.created_by WHERE s.site_id=$1 ORDER BY u.id",
        [site.id],
      ),
    ]);
    return {
      versions: versions.map((v) => ({
        id: v.id,
        entry: v.entry,
        createdAt: v.createdAt,
      })),
      shares: shares.map((s) => ({
        id: s.id,
        label: s.label || null,
        source: s.source,
      })),
      authors: authors.map((u) => ({
        id: String(u.id),
        label: u.display_name == null ? null : String(u.display_name),
      })),
    };
  });
}
