import "server-only";
import { canReadVersion } from "@/lib/share";
import { requirePermission } from "@/lib/authz";
import { resolveSession } from "@/lib/session";
import { SCOPE_WRITE } from "@/lib/oauth-shared";
import type { AgentCommentBundle, CommentThreadDetail } from "./contracts";
import { commentSite, getCommentDetail } from "./service";

export interface AgentContextBundle extends AgentCommentBundle {
  dataTrust: "untrusted";
  artifact: { slug: string; title: string; originalVersionId: string; latestVersionId: string | null; filePath: string };
  evidence: { textStatus: "available" | "unavailable"; captureStatus: "unsupported"; captureReason: string };
  continuation: { messagesPath: string | null };
}
/** Whitelist each DTO instead of forwarding rows or caller-supplied context. */
export function agentThread(detail: CommentThreadDetail): CommentThreadDetail {
  const rootDeleted = detail.messages.items.some(message => message.isRoot && message.content.state === "deleted");
  const thread = detail.thread;
  return {
    space: { id: detail.space.id, siteId: detail.space.siteId, versionId: detail.space.versionId, entry: detail.space.entry, createdAt: detail.space.createdAt },
    thread: {
      id: thread.id, spaceId: thread.spaceId, resultVersionId: thread.resultVersionId ?? null, createdBy: thread.createdBy,
      anchor: rootDeleted ? { kind: "document", schemaVersion: 1, filePath: thread.anchor.filePath } : thread.anchor,
      context: rootDeleted ? { schemaVersion: 1, excerpt: null, originalFilePath: null, rendition: null, assetIds: [] } : {
        schemaVersion: 1, excerpt: thread.context.excerpt?.slice(0, 2000) ?? null,
        originalFilePath: thread.context.originalFilePath, rendition: thread.context.rendition, assetIds: [],
      },
      resolution: thread.resolution.status === "open" ? { status: "open" } : { status: "resolved", resolvedBy: thread.resolution.resolvedBy, resolvedAt: thread.resolution.resolvedAt }, revision: thread.revision, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    },
    messages: { items: detail.messages.items.map(message => ({ id: message.id, threadId: message.threadId, authorUserId: message.authorUserId, isRoot: message.isRoot, content: message.content.state === "visible" ? { state: "visible", body: message.content.body } : { state: "deleted", deletedAt: message.content.deletedAt, deletedBy: message.content.deletedBy }, revision: message.revision, createdAt: message.createdAt, editedAt: message.editedAt })), nextCursor: detail.messages.nextCursor },
    permissions: detail.permissions,
  };
}
export async function getAgentContext(request: Request, slug: string, threadId: string): Promise<AgentContextBundle> {
  const detail = agentThread(await getCommentDetail(request, slug, threadId));
  const site = await commentSite(slug);
  const session = await resolveSession(request);
  let canExportSource = false, canEditContent = false;
  try { await requirePermission(request, site, "site.source.export", session, false); canExportSource = true; } catch { /* Independent permission, never inferred from comment access. */ }
  try {
    await requirePermission(request, site, "site.content.edit", session, false);
    canEditContent = Boolean(!session?.scopes || session.scopes.includes(SCOPE_WRITE));
  } catch { /* A false capability is not a failed comment read. */ }
  const cursor = detail.messages.nextCursor;
  return {
    schemaVersion: 1, dataTrust: "untrusted", scope: { siteId: detail.space.siteId, versionId: detail.space.versionId, entry: detail.space.entry }, threads: [detail],
    capabilities: { canExportSource, canEditContent },
    artifact: { slug, title: site.title, originalVersionId: detail.space.versionId, latestVersionId: await canReadVersion(request, site, site.currentVersionId, session) ? site.currentVersionId : null, filePath: detail.thread.anchor.filePath },
    evidence: { textStatus: detail.thread.context.excerpt ? "available" : "unavailable", captureStatus: "unsupported", captureReason: "Region screenshots are not captured in this release; use the authorized original artifact and anchor." },
    continuation: { messagesPath: cursor ? `/api/sites/${encodeURIComponent(slug)}/comments/${encodeURIComponent(threadId)}/messages?cursor=${encodeURIComponent(cursor)}` : null },
  };
}
