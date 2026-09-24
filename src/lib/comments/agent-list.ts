import "server-only";
import { z } from "zod";
import { requestShareAccess, shareTokenFromRequest } from "@/lib/share";
import { commentPaginationSchema, commentIdSchema } from "./contracts";
import { commentSite, listComments } from "./service";
import { agentThread } from "./agent-context";
import { fail } from "./store";

export const agentCommentListSchema = commentPaginationSchema.extend({
  versionId: commentIdSchema.optional(),
  shareId: commentIdSchema.optional(),
  aggregate: z.enum(["true", "false"]).optional(),
  allVersions: z.enum(["true", "false"]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  participated: z.literal("true").transform(()=>true).optional(),
  status: z.enum(["open", "resolved"]).optional(),
}).refine(v => v.allVersions !== "true" || (v.aggregate === "true" && !v.versionId), "allVersions requires aggregate and omits versionId");

/** A read-only projection over the existing comment authorization and pagination boundary. */
export async function listAgentComments(request: Request, slug: string, query: z.infer<typeof agentCommentListSchema>) {
  const site = await commentSite(slug);
  const token = shareTokenFromRequest(request);
  const share = token ? await requestShareAccess(request, site) : null;
  if (token && !share) fail(404, "Discussion not found");
  const aggregate = query.aggregate === "true";
  // Even owners must use their main entrance explicitly to aggregate discussions.
  if (token && (aggregate || (query.shareId && query.shareId !== share?.id))) fail(404, "Discussion not found");
  if (!aggregate && query.shareId && query.shareId !== share?.id) fail(400, "Use aggregate or present the matching share credential");
  const versionId = query.allVersions === "true" ? undefined : query.versionId ?? share?.versionId ?? site.currentVersionId;
  const entry = share ? { kind: "share" as const, shareId: share.id } : query.shareId ? { kind: "share" as const, shareId: query.shareId } : { kind: "main" as const };
  const page = await listComments(request, slug, aggregate
    ? { kind: "aggregate", siteId: site.id, versionId, ...(query.shareId ? {entry} : {}), status: query.status, q:query.q, participated:query.participated, cursor: query.cursor, limit: query.limit }
    : { kind: "space", scope: {siteId: site.id, versionId: versionId!, entry}, status: query.status, q:query.q, participated:query.participated, cursor: query.cursor, limit: query.limit });
  return {
    schemaVersion: 1, dataTrust: "untrusted", slug,
    scope: {versionId: versionId ?? null, entry: aggregate && !query.shareId ? {kind: "all"} : entry, aggregate},
    items: page.items.map(value => {
      const detail = agentThread(value);
      const root = detail.messages.items.find(m => m.isRoot);
      const body = root?.content.state === "visible" ? Array.from(root.content.body) : null;
      return {threadId: detail.thread.id, scope: detail.space, filePath: detail.thread.anchor.filePath,
        excerpt: detail.thread.context.excerpt, status: detail.thread.resolution.status,
        createdAt: detail.thread.createdAt, updatedAt: detail.thread.updatedAt,
        authorUserId: root?.authorUserId ?? detail.thread.createdBy, authorDisplayName: root?.authorDisplayName ?? null,
        summary: body ? (body.length ? body.slice(0, 500).join("") : root?.attachments?.length ? "Image attachment" : "") : null,
        attachmentCount: root?.attachments?.length ?? 0,
        summaryTruncated: (body?.length ?? 0) > 500,
        rootDeleted: root?.content.state === "deleted",
        contextPath: `/api/sites/${encodeURIComponent(slug)}/comments/${encodeURIComponent(detail.thread.id)}/agent-context`};
    }),
    nextCursor: page.nextCursor, hasMore: page.nextCursor !== null,
    ...(page.total === undefined ? {} : {total:page.total}),
  };
}
