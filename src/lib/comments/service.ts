import { syncMentions } from "./mentions";
import { autoFollow, recordReply } from "@/lib/notifications/events";
import { rememberShareAccess } from "@/lib/notifications/receipts";
import { isTokenSession } from "@/lib/publish-token";
import { attachCommentImages, bindCommentAttachments } from "./attachments";
import { requirePermission } from "@/lib/authz";
import { canReadVersion, readableVersionFilter } from "@/lib/share";
import type { AssociateCommentInput } from "./contracts";
import { commentReadScopeKey } from "./contracts";
import { canonicalCommentEmoji } from "./emoji";
import "server-only";
import {
  createId,
  getSiteBySlug,
  getVersion,
  listVersions,
  rbacQuery,
  rbacTransaction,
  toSite,
  type Row,
} from "@/lib/db";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession, csrfSafe } from "@/lib/session";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";
import { prepareCommentEvidence } from "./evidence";
import type { Session, Site } from "@/lib/types";
import type { RbacQuery } from "@/lib/rbac-store";
import { resolveCommentAccess, auditCommentAccess } from "./access";
import {
  describeCommentPermissions,
  canActOnComment,
  type CommentAccessFacts,
} from "./permissions";
import type {
  CommentScope,
  CommentThreadDetail,
  CommentPage,
  CommentMessage,
  CommentListFilter,
  CreateCommentInput,
  ReplyCommentInput,
  EditCommentInput,
  DeleteCommentInput,
  ResolveCommentInput,
  CommentSettings,
  CommentEmoji,
  CommentReaction,
} from "./contracts";
import {
  fail,
  commentSearchBodySql,
  loadThread,
  messageDTO,
  fingerprint,
  legacyCommentFingerprint,
  ensureSpace,
  cursorDecode,
  cursorEncode,
} from "./store";
function unreadMessagePredicate(alias: string, actor: string, baseline: string) {
  return `${alias}.deleted_at IS NULL AND (${alias}.author_user_id<>${actor} OR ${actor} IS NULL) AND ${alias}.created_at>${baseline} AND NOT EXISTS (SELECT 1 FROM comment_read_messages receipt WHERE receipt.user_id=${actor} AND receipt.message_id=${alias}.id)`;
}
const auditedRequests = new WeakSet<Request>();
export async function commentSite(slug: string): Promise<Site> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return fail(404, "Site not found");
  return site;
}
async function facts(
  request: Request,
  site: Site,
  scope: CommentScope,
  session: Session | null,
) {
  await assertPresentedBearerAlive(request, session);
  if (scope.siteId !== site.id) return fail(404, "Discussion not found");
  const value = await resolveCommentAccess(request, site, scope, session);
  if (value.canReadArtifact && !auditedRequests.has(request)) {
    await auditCommentAccess(request, site, value);
    auditedRequests.add(request);
  }
  return value;
}
function readable(f: CommentAccessFacts) {
  if (!describeCommentPermissions(f).canRead) fail(404, "Discussion not found");
}
export async function getCommentPermissions(
  request: Request,
  slug: string,
  scope: CommentScope,
) {
  return getCommentPermissionsForSite(request, await commentSite(slug), scope);
}
export async function getCommentPermissionsForSite(request: Request, site: Site, scope: CommentScope) {
  const session = await resolveSession(request),
    f = await facts(request, site, scope, session);
  if (!f.canReadArtifact) fail(404, "Artifact not found");
  return {
    ...describeCommentPermissions(f),
    // Unrestricted main-history access, independent of share aggregation. Ordinary readers
    // may still read the latest and official snapshots, but not arbitrary historical drafts.
    canReadVersions: Boolean(f.accountRole || f.managementRole),
    isAuthenticated: Boolean(f.userId),
    userId: f.userId,
    needsLogin:
      !f.userId &&
      f.canReadArtifact &&
      (f.scope.entry.kind === "main"
        ? f.canReadMainArtifact && f.mainPolicy !== "off"
        : f.shareMode === "comment" || f.shareMode === "edit"),
  };
}
async function messagePage(
  threadId: string,
  cursor?: string,
  limit = 30,
  userId?: string | null,
  includeReactions = true,
): Promise<CommentPage<CommentMessage>> {
  const filter = { threadId },
    after = cursorDecode(cursor, filter);
  const params: (string | number | null)[] = [threadId];
  let where = "m.thread_id=$1";
  if (after) {
    params.push(after.time, after.id);
    where += " AND (m.created_at>$2 OR (m.created_at=$2 AND m.id>$3))";
  }
  params.push(limit + 1);
  const rows = await rbacQuery(
    `SELECT m.*,u.display_name AS author_display_name FROM comment_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE ${where} ORDER BY m.created_at,m.id LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(messageDTO),
    last = items.at(-1);
  await attachCommentImages(items);
  if (includeReactions) await attachReactions(items,userId);
  return {
    items,
    nextCursor:
      more && last ? cursorEncode(filter, last.createdAt, last.id) : null,
  };
}
async function attachReactions(items: CommentMessage[], userId?: string | null) {
  const live = items.filter(item=>item.content.state !== "deleted");
  for (const item of items) item.reactions=[];
  if (live.length) {
    const slots=live.map((_,index)=>`$${index+2}`).join(",");
    const reactions = await rbacQuery(`SELECT r.message_id,r.emoji,COUNT(*) AS count,MAX(CASE WHEN r.user_id=$1 THEN 1 ELSE 0 END) AS reacted FROM comment_reactions r JOIN comment_messages m ON m.id=r.message_id WHERE m.id IN (${slots}) AND m.deleted_at IS NULL GROUP BY r.message_id,r.emoji ORDER BY MIN(r.created_at),r.emoji`, [userId ?? null, ...live.map(item=>item.id)]);
    for (const item of items) item.reactions = reactions.filter(r => r.message_id === item.id).map(r => ({ emoji: r.emoji as CommentEmoji, count: Number(r.count), reacted: Boolean(Number(r.reacted)) }));
  }
}
type ListFactsCache = Map<string, CommentAccessFacts>;
const scopeKey = (scope: CommentScope) =>
  JSON.stringify([
    scope.siteId,
    scope.versionId,
    scope.entry.kind,
    scope.entry.kind === "share" ? scope.entry.shareId : null,
  ]);
async function authorizedThread(
  request: Request,
  site: Site,
  id: string,
  session: Session | null,
  cache?: ListFactsCache,
) {
  const found = await loadThread(id);
  if (!found || found.space.siteId !== site.id)
    return fail(404, "Discussion not found");
  const key = scopeKey(found.space);
  const f =
    cache?.get(key) ?? (await facts(request, site, found.space, session));
  readable(f);
  cache?.set(key, f);
  return { found, f };
}
/** The memoized values are valid only for this request and site, never across readers. */
function detailLookups(request: Request, site: Site, session: Session | null) {
  let edit: Promise<boolean> | undefined;
  let readableVersions: ReturnType<typeof readableVersionFilter> | undefined;
  let ordinals: Promise<Map<string, number>> | undefined;
  const readOrdinals = () => ordinals ??= listVersions(site.id).then(versions => new Map(versions.map((version,index) => [version.id,versions.length-index])));
  return {
    readOrdinals,
    canEdit: () => edit ??= requirePermission(request,site,"site.content.edit",session,false).then(()=>true,()=>false),
    canReadResult: async (versionId: string) => {
      const allowed=await (readableVersions ??= readableVersionFilter(request,site,session));
      return allowed(versionId) && (await readOrdinals()).has(versionId);
    },
  };
}
/** Every public thread response uses the same result-version visibility rules. */
async function visibleThread(thread: CommentThreadDetail["thread"], lookups: ReturnType<typeof detailLookups>) {
  const visible = {...thread};
  if (!visible.resultVersionId || !await lookups.canReadResult(visible.resultVersionId)) {
    visible.resultVersionId = null;
    visible.resultAssociation = null;
    delete visible.resultVersionNumber;
  } else {
    visible.resultVersionNumber = (await lookups.readOrdinals()).get(visible.resultVersionId) ?? null;
  }
  return visible;
}
async function canAssociateResult(request: Request, site: Site, session: Session | null, f: CommentAccessFacts, lookups=detailLookups(request,site,session)) {
  // Exact discussion facts remain outside the shared editorial-authority cache.
  return Boolean(f.userId && f.canWriteArtifactDiscussion) && await lookups.canEdit();
}
async function detail(
  request: Request,
  site: Site,
  id: string,
  session: Session | null,
  cache?: ListFactsCache,
  lookups = detailLookups(request,site,session),
): Promise<CommentThreadDetail> {
  const { found, f } = await authorizedThread(
    request,
    site,
    id,
    session,
    cache,
  );
  found.thread = await visibleThread(found.thread, lookups);
  const messages = await messagePage(id, undefined, 30, session?.userId, !cache);
  const target = {
    scope: found.space,
    threadCreatorId: found.thread.createdBy,
  };
  return {
    ...found,
    messages,
    permissions: {
      canReply: describeCommentPermissions(f).canReply,
      canAssociateResult: await canAssociateResult(request, site, session, f, lookups),
      canResolve: canActOnComment(f, "resolve", target),
      canReopen: canActOnComment(f, "reopen", target),
      messages: Object.fromEntries(
        messages.items.map((m) => [
          m.id,
          {
            canEdit: canActOnComment(f, "edit", {
              ...target,
              messageAuthorId: m.authorUserId,
              messageDeleted: m.content.state === "deleted",
            }),
            canDelete: canActOnComment(f, "delete", {
              ...target,
              messageAuthorId: m.authorUserId,
              messageDeleted: m.content.state === "deleted",
            }),
          },
        ]),
      ),
    },
  };
}
export async function getCommentDetail(
  request: Request,
  slug: string,
  id: string,
) {
  return detail(
    request,
    await commentSite(slug),
    id,
    await resolveSession(request),
  );
}
export async function getMessages(
  request: Request,
  slug: string,
  id: string,
  cursor?: string,
  limit = 30,
) {
  const site = await commentSite(slug);
  const session = await resolveSession(request);
  const { found, f } = await authorizedThread(request, site, id, session);
  const page = await messagePage(id, cursor, limit, session?.userId);
  return {
    ...page,
    permissions: Object.fromEntries(
      page.items.map((m) => [
        m.id,
        {
          canEdit: canActOnComment(f, "edit", {
            scope: found.space,
            threadCreatorId: found.thread.createdBy,
            messageAuthorId: m.authorUserId,
            messageDeleted: m.content.state === "deleted",
          }),
          canDelete: canActOnComment(f, "delete", {
            scope: found.space,
            threadCreatorId: found.thread.createdBy,
            messageAuthorId: m.authorUserId,
            messageDeleted: m.content.state === "deleted",
          }),
        },
      ]),
    ),
  };
}
export async function listComments(
  request: Request,
  slug: string,
  filter: CommentListFilter,
) {
  const site = await commentSite(slug),
    session = await resolveSession(request);
  if (filter.kind === "aggregate" && filter.siteId !== site.id)
    fail(404, "Discussion not found");
  let permissionFacts: CommentAccessFacts;
  if (filter.kind === "space") {
    permissionFacts = await facts(request, site, filter.scope, session);
    readable(permissionFacts);
  } else {
    permissionFacts = await facts(
      request,
      site,
      {
        siteId: site.id,
        versionId: site.currentVersionId,
        entry: { kind: "main" },
      },
      session,
    );
    if (!describeCommentPermissions(permissionFacts).canAggregate)
      fail(404, "Discussion not found");
  }
  const accessCache: ListFactsCache = new Map([
    [scopeKey(permissionFacts.scope), permissionFacts],
  ]);
  const params: (string | number | null)[] = [site.id];
  let where = "s.site_id=$1";
  const add = (sql: string, value: string | number | null) => {
    params.push(value);
    where += ` AND ${sql.replace("?", `$${params.length}`)}`;
  };
  const scope = filter.kind === "space" ? filter.scope : null;
  const versionId =
    scope?.versionId ??
    (filter.kind === "aggregate" ? filter.versionId : undefined);
  if (versionId) add("s.version_id=?", versionId);
  const entry =
    scope?.entry ?? (filter.kind === "aggregate" ? filter.entry : undefined);
  if (entry) {
    if (entry.kind === "main") where += " AND s.kind='main'";
    else add("s.share_id=?", entry.shareId);
  }
  if (filter.unread) {
    if (!session) return fail(401,"Sign in to filter unread comments");
    const readKey = commentReadScopeKey(filter.kind === "space" ? filter.scope.versionId : "", filter.kind === "space" && filter.scope.entry.kind === "share" ? filter.scope.entry.shareId : undefined, filter.kind === "aggregate");
    const [progress] = await rbacQuery("SELECT read_through FROM comment_read_scopes WHERE user_id=$1 AND site_id=$2 AND scope_key=$3",[session.userId,site.id,readKey]);
    params.push(session.userId, progress ? Number(progress.read_through) : Date.now());
    const actor=`$${params.length-1}`, baseline=`$${params.length}`;
    where += ` AND EXISTS (SELECT 1 FROM comment_messages unread WHERE unread.thread_id=t.id AND ${unreadMessagePredicate("unread",actor,baseline)})`;
  }
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    add(`EXISTS (SELECT 1 FROM comment_messages searched WHERE searched.thread_id=t.id AND searched.deleted_at IS NULL AND LOWER(${commentSearchBodySql("searched")}) LIKE LOWER(?) ESCAPE '\\')`, pattern);
  }
  // Participation is historical: deleting your text does not erase having joined a discussion.
  if (filter.participated) {
    if (!session) return fail(401, "Sign in to filter participated comments");
    add("EXISTS (SELECT 1 FROM comment_messages participant WHERE participant.thread_id=t.id AND participant.author_user_id=?)", session.userId);
  }
  if (filter.status) add("t.status=?", filter.status);
  const authorUserId = filter.kind === "aggregate" ? filter.authorUserId : undefined;
  const sort = filter.kind === "aggregate" ? filter.sort ?? "activity" : "activity";
  if (authorUserId) add("t.created_by=?", authorUserId);
  const timeColumn = sort === "activity" ? "updated_at" : "created_at";
  const direction = sort === "oldest" ? "ASC" : "DESC";
  const comparison = sort === "oldest" ? ">" : "<";
  const key = {
    kind: filter.kind,
    siteId: site.id,
    versionId: versionId ?? null,
    entry: entry ?? null,
    status: filter.status ?? null,
    q: filter.q ?? null, participated: filter.participated ? session?.userId : null,
    ...(filter.unread ? {unread:true} : {}),
    authorUserId: authorUserId ?? null, sort,
  };
  const after = cursorDecode(filter.cursor, key);
  const [count] = filter.cursor || filter.unread ? [] : await rbacQuery(`SELECT COUNT(*) AS total FROM comment_threads t JOIN comment_spaces s ON s.id=t.space_id WHERE ${where}`, params);
  if (after) {
    params.push(after.time, after.id);
    where += ` AND (t.${timeColumn}${comparison}$${params.length - 1} OR (t.${timeColumn}=$${params.length - 1} AND t.id${comparison}$${params.length}))`;
  }
  const limit = filter.limit ?? 30;
  params.push(limit + 1);
  const rows = await rbacQuery(
    `SELECT t.id,t.${timeColumn} AS sort_time FROM comment_threads t JOIN comment_spaces s ON s.id=t.space_id WHERE ${where} ORDER BY t.${timeColumn} ${direction},t.id ${direction} LIMIT $${params.length}`,
    params,
  );
  const items: CommentThreadDetail[] = [];
  const lookups=detailLookups(request,site,session);
  for (const row of rows.slice(0, limit))
    items.push(
      await detail(request, site, String(row.id), session, accessCache, lookups),
    );
  if (filter.q && items.length) {
    const pattern=`%${filter.q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    const ids=items.map(item=>item.thread.id);
    // One bounded query for the first visible match per authorized result thread.
    const matches=await rbacQuery(`SELECT id,thread_id,body FROM (SELECT searched.id,searched.thread_id,${commentSearchBodySql("searched")} AS body,ROW_NUMBER() OVER (PARTITION BY searched.thread_id ORDER BY searched.created_at,searched.id) AS match_rank FROM comment_messages searched WHERE searched.thread_id IN (${ids.map((_,index)=>`$${index+1}`).join(",")}) AND searched.deleted_at IS NULL AND LOWER(${commentSearchBodySql("searched")}) LIKE LOWER($${ids.length+1}) ESCAPE '\\') ranked WHERE match_rank=1`,[...ids,pattern]);
    const byThread=new Map(matches.map(match=>[String(match.thread_id),match]));
    for(const item of items) {
      const match=byThread.get(item.thread.id);
      if(!match) continue;
      const body=String(match.body), start=Math.max(0,body.toLowerCase().indexOf(filter.q.toLowerCase())-60);
      item.searchMatch={messageId:String(match.id),excerpt:`${start ? "…" : ""}${Array.from(body.slice(start)).slice(0,240).join("")}`};
    }
  }
  await attachReactions(items.flatMap(item=>item.messages.items),session?.userId);
  const last = rows.slice(0, limit).at(-1);
  return {
    items,
    ...(count ? { total: Number(count.total) } : {}),
    nextCursor:
      rows.length > limit && last
        ? cursorEncode(key, Number(last.sort_time), String(last.id))
        : null,
    permissions: {
      ...describeCommentPermissions(permissionFacts),
      isAuthenticated: Boolean(session),
    },
  };
}
export async function listAggregate(
  request: Request,
  slug: string,
  query: {
    versionId?: string;
    shareId?: string;
    entry?: "main";
    authorUserId?: string;
    sort?: "activity" | "newest" | "oldest";
    status?: "open" | "resolved";
    unread?: boolean;
    q?: string;
    participated?: boolean;
    cursor?: string;
    limit?: number;
  },
) {
  const site = await commentSite(slug);
  return listComments(request, slug, {
    kind: "aggregate",
    siteId: site.id,
    ...query,
    entry: query.shareId
      ? { kind: "share", shareId: query.shareId }
      : query.entry
        ? { kind: "main" }
        : undefined,
  });
}
const preflightSessions = new WeakMap<Request, Session>();
async function preflightWrite(request: Request): Promise<Session> {
  const existing = preflightSessions.get(request);
  if (existing) return existing;
  if (!csrfSafe(request)) fail(401, "Cross-site request rejected");
  checkRateLimit(request);
  const session = await resolveSession(request);
  await assertPresentedBearerAlive(request, session);
  if (!session) return fail(401, "Sign in to comment");
  preflightSessions.set(request, session);
  return session;
}
async function write<T>(
  request: Request,
  slug: string,
  work: (q: RbacQuery, site: Site, session: Session) => Promise<T>,
  auditTargetId?: string,
): Promise<T> {
  const session = await preflightWrite(request);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    const [row] = await q(
      "SELECT * FROM sites WHERE slug=$1 AND deleted_at IS NULL",
      [slug],
    );
    if (!row) return fail(404, "Site not found");
    const site = toSite(row);
    const result = await work(q, site, session);
    // The service result contains a server-created thread/message ID. Settings target the site.
    const targetId = auditTargetId ?? (
      result &&
      typeof result === "object" &&
      "id" in result &&
      typeof result.id === "string"
        ? result.id
        : site.id);
    await q(
      "INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        createId("rba"),
        site.tenantId,
        session.userId,
        "comment.mutation",
        targetId,
        request.method + " " + new URL(request.url).pathname,
        Date.now(),
      ],
    );
    return result;
  });
}
export async function createComment(
  request: Request,
  slug: string,
  input: CreateCommentInput,
) {
  const site = await commentSite(slug);
  const session = await preflightWrite(request);
  const f = await facts(request, site, input.scope, session);
  readable(f);
  if (!describeCommentPermissions(f).canCreate)
    fail(session ? 403 : 401, "Comment creation is not allowed");
  const version = await getVersion(input.scope.versionId);
  if (!version || version.siteId !== site.id) fail(400, "Comment file not found");
  // A matching replay still passes the authoritative transaction checks below. Avoid reading
  // immutable bytes/parsing PDFs again after a lost response; mismatched IDs fail identically.
  const [replay] = await rbacQuery(
    "SELECT request_fingerprint FROM comment_messages WHERE author_user_id=$1 AND client_request_id=$2",
    [session.userId, input.clientRequestId],
  );
  const evidence = replay ? null : await prepareCommentEvidence(site, version!, input.anchor);
  const result = await write(request, slug, async (q, current, identity) => {
    const currentFacts = await facts(request, current, input.scope, identity);
    readable(currentFacts);
    if (!describeCommentPermissions(currentFacts).canCreate)
      fail(403, "Comment creation is not allowed");
    const digest = await fingerprint(q, { type: "create", ...input });
    const [old] = await q(
      "SELECT * FROM comment_messages WHERE author_user_id=$1 AND client_request_id=$2",
      [identity.userId, input.clientRequestId],
    );
    if (old) {
      if (old.request_fingerprint !== digest && old.request_fingerprint !== await legacyCommentFingerprint(q, {type:"create",...input}))
        fail(409, "Request ID was already used for different content");
      return { id: String(old.thread_id), replayed: true };
    }
    if (!evidence) fail(409, "Replayed comment is no longer available");
    const spaceId = await ensureSpace(q, input.scope),
      id = createId("cth"),
      messageId = createId("cmsg"),
      now = Date.now();
    await q(
      "INSERT INTO comment_threads(id,space_id,created_by,anchor,context_snapshot,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)",
      [
        id,
        spaceId,
        identity.userId,
        JSON.stringify(input.anchor),
        JSON.stringify(evidence),
        now,
      ],
    );
    await q(
      "INSERT INTO comment_messages(id,thread_id,author_user_id,is_root,body,client_request_id,request_fingerprint,created_at,rich_content) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)",
      [
        messageId,
        id,
        identity.userId,
        input.body || "[Image attachment]",
        input.clientRequestId,
        digest,
        now,
        JSON.stringify({body:input.body,format:input.bodyFormat ?? "plain",mentions:input.mentions ?? []}),
      ],
    );
    await bindCommentAttachments(q,input.scope,identity.userId,messageId,input.attachmentIds ?? []);
    await syncMentions(q,{site:current,scope:input.scope,actorUserId:identity.userId},messageId,input.body,input.mentions ?? [],isTokenSession(identity),now);
    await autoFollow(q,id,identity.userId,"create",now);
    await rememberShareAccess(q,request,current,input.scope,identity);
    return { id, replayed: false };
  });
  return {
    detail: await getCommentDetail(request, slug, result.id),
    replayed: result.replayed,
  };
}
async function writeThread<T>(
  request: Request,
  slug: string,
  id: string,
  work: (
    q: RbacQuery,
    site: Site,
    session: Session,
    found: NonNullable<Awaited<ReturnType<typeof loadThread>>>,
    f: CommentAccessFacts,
  ) => Promise<T>,
) {
  return write(request, slug, async (q, site, session) => {
    const found = await loadThread(id, q);
    if (!found || found.space.siteId !== site.id)
      fail(404, "Discussion not found");
    const valid = found!;
    const f = await facts(request, site, valid.space, session);
    readable(f);
    return work(q, site, session, valid, f);
  });
}
export async function replyComment(
  request: Request,
  slug: string,
  id: string,
  input: ReplyCommentInput,
) {
  return writeThread(request, slug, id, async (q, _site, session, found, f) => {
    if (!describeCommentPermissions(f).canReply)
      fail(403, "Replies are not allowed");
    const digest = await fingerprint(q, {
      type: "reply",
      threadId: id,
      ...input,
    });
    const [old] = await q(
      "SELECT * FROM comment_messages WHERE author_user_id=$1 AND client_request_id=$2",
      [session.userId, input.clientRequestId],
    );
    if (old) {
      if (old.request_fingerprint !== digest && old.request_fingerprint !== await legacyCommentFingerprint(q, {type:"reply",threadId:id,...input}))
        fail(409, "Request ID was already used for different content");
      const replay = messageDTO(old);
      await attachCommentImages([replay],q);
      return replay;
    }
    const now = Date.now();
    const [row] = await q(
      "INSERT INTO comment_messages(id,thread_id,author_user_id,is_root,body,client_request_id,request_fingerprint,created_at,rich_content) VALUES($1,$2,$3,0,$4,$5,$6,$7,$8) RETURNING *",
      [
        createId("cmsg"),
        id,
        session.userId,
        input.body || "[Image attachment]",
        input.clientRequestId,
        digest,
        now,
        JSON.stringify({body:input.body,format:input.bodyFormat ?? "plain",mentions:input.mentions ?? []}),
      ],
    );
    await bindCommentAttachments(q,found.space,session.userId,String(row.id),input.attachmentIds ?? []);
    await q("UPDATE comment_threads SET updated_at=$1 WHERE id=$2", [
      now,
      found.thread.id,
    ]);
    await autoFollow(q,id,session.userId,"reply",now);
    await rememberShareAccess(q,request,_site,found.space,session);
    await recordReply(q,id,String(row.id),session.userId,isTokenSession(session),now);
    await syncMentions(q,{site:_site,scope:found.space,actorUserId:session.userId},String(row.id),input.body,input.mentions ?? [],isTokenSession(session),now);
    const message = messageDTO(row);
    await attachCommentImages([message],q);
    return message;
  });
}
export async function mutateMessage(
  request: Request,
  slug: string,
  id: string,
  messageId: string,
  input: EditCommentInput | DeleteCommentInput,
  action: "edit" | "delete",
) {
  return writeThread(request, slug, id, async (q, _site, session, found, f) => {
    const [old] = await q(
      "SELECT * FROM comment_messages WHERE id=$1 AND thread_id=$2",
      [messageId, id],
    );
    if (!old) fail(404, "Message not found");
    if (
      !canActOnComment(f, action, {
        scope: found.space,
        threadCreatorId: found.thread.createdBy,
        messageAuthorId: String(old.author_user_id),
        messageDeleted: old.deleted_at != null,
      })
    )
      fail(403, "Action is not allowed");
    if (Number(old.revision) !== input.expectedRevision)
      fail(409, "Comment changed; refresh before trying again");
    if (action === "edit" && !(input as EditCommentInput).body.trim()) {
      const ids = (input as EditCommentInput).attachmentIds;
      const retained = ids === undefined ? await q("SELECT id FROM comment_attachments WHERE message_id=$1 AND deleted_at IS NULL AND ready=1 LIMIT 1", [messageId]) : ids;
      if (!retained.length) fail(400, "Comment needs text or an image");
    }
    const now = Date.now();
    const edited = input as EditCommentInput;
    await syncMentions(q,{site:_site,scope:found.space,actorUserId:session.userId},messageId,action === "edit" ? edited.body : "",action === "edit" ? edited.mentions ?? [] : [],isTokenSession(session),now);
    let rows: Row[];
    if (action === "edit")
      rows = await q(
        "UPDATE comment_messages SET body=$1,edited_at=$2,revision=revision+1,rich_content=$5 WHERE id=$3 AND revision=$4 RETURNING *",
        [
          (input as EditCommentInput).body || "[Image attachment]",
          now,
          messageId,
          input.expectedRevision,
          JSON.stringify({body:(input as EditCommentInput).body,format:(input as EditCommentInput).bodyFormat ?? "plain",mentions:(input as EditCommentInput).mentions ?? []}),
        ],
      );
    else {
      rows = await q(
        "UPDATE comment_messages SET body=NULL,rich_content=NULL,deleted_at=$1,deleted_by=$2,revision=revision+1 WHERE id=$3 AND revision=$4 RETURNING *",
        [now, session.userId, messageId, input.expectedRevision],
      );
      await q(
        "UPDATE comment_context_assets SET deleted_at=$1 WHERE message_id=$2 AND deleted_at IS NULL",
        [now, messageId],
      );
      if (Number(old.is_root) === 1)
        await q(
          "UPDATE comment_threads SET anchor=$1,context_snapshot=$2 WHERE id=$3",
          [
            JSON.stringify({
              kind: "document",
              schemaVersion: 1,
              filePath: found.thread.anchor.filePath,
            }),
            JSON.stringify({
              schemaVersion: 1,
              excerpt: null,
              originalFilePath: null,
              rendition: null,
              assetIds: [],
            }),
            id,
          ],
        );
    }
    if (!rows.length) fail(409, "Comment changed; refresh before trying again");
    if (action === "delete") await q("UPDATE comment_attachments SET deleted_at=$2 WHERE message_id=$1 AND deleted_at IS NULL",[messageId,now]);
    else if ((input as EditCommentInput).attachmentIds !== undefined) await bindCommentAttachments(q,found.space,session.userId,messageId,(input as EditCommentInput).attachmentIds!);
    await q("UPDATE comment_threads SET updated_at=$1 WHERE id=$2", [now, id]);
    const message = messageDTO(rows[0]);
    await attachCommentImages([message],q);
    return message;
  });
}
export async function resolveComment(
  request: Request,
  slug: string,
  id: string,
  input: ResolveCommentInput,
) {
  return writeThread(request, slug, id, async (q, site, session, found, f) => {
    if (
      !canActOnComment(f, input.status === "open" ? "reopen" : "resolve", {
        scope: found.space,
        threadCreatorId: found.thread.createdBy,
      })
    )
      fail(403, "Action is not allowed");
    const now = Date.now();
    const [row] = await q(
      "UPDATE comment_threads SET status=$1,resolved_by=$2,resolved_at=$3,revision=revision+1,updated_at=$4 WHERE id=$5 AND revision=$6 RETURNING *",
      [
        input.status,
        input.status === "resolved" ? session.userId : null,
        input.status === "resolved" ? now : null,
        now,
        id,
        input.expectedRevision,
      ],
    );
    if (!row) fail(409, "Thread changed; refresh before trying again");
    return visibleThread((await loadThread(id, q))!.thread, detailLookups(request, site, session));
  });
}
export async function commentResultOptions(request: Request, slug: string, id: string) {
  const site = await commentSite(slug), session = await resolveSession(request);
  const {f} = await authorizedThread(request, site, id, session);
  if (!await canAssociateResult(request, site, session, f)) fail(403, "Action is not allowed");
  const versions = await listVersions(site.id);
  const visible = [];
  const readableVersion=await readableVersionFilter(request,site,session);
  for (const [index,version] of versions.entries()) if (readableVersion(version.id)) visible.push({id:version.id,createdAt:version.createdAt,number:versions.length-index});
  return {versions:visible};
}
/** Association is editorial metadata, not a resolution or a move to a new discussion. */
export async function associateCommentResult(request: Request, slug: string, id: string, input: AssociateCommentInput) {
  return writeThread(request, slug, id, async (q, site, session, found, f) => {
    if (!await canAssociateResult(request, site, session, f)) fail(403, "Action is not allowed");
    if (input.versionId) {
      const version = await getVersion(input.versionId);
      if (!version || version.siteId !== site.id || !await canReadVersion(request, site, input.versionId, session)) fail(404, "Version not found");
    }
    const now = Date.now();
    const actorKind = isTokenSession(session) ? "agent" : "user";
    const [row] = await q("UPDATE comment_threads SET result_version_id=$1,result_associated_by=$2,result_associated_at=$3,result_actor_kind=$4,revision=revision+1,updated_at=$5 WHERE id=$6 AND revision=$7 RETURNING *", [input.versionId,input.versionId ? session.userId : null,input.versionId ? now : null,input.versionId ? actorKind : null,now,id,input.expectedRevision]);
    if (!row) fail(409, "Thread changed; refresh before trying again");
    await q("INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [createId("rba"),site.tenantId,session.userId,"comment.result.associate",id,JSON.stringify({previousVersionId:found.thread.resultVersionId ?? null,versionId:input.versionId,actorKind}),now]);
    return visibleThread((await loadThread(id, q))!.thread, detailLookups(request, site, session));
  });
}
export async function commentSettings(
  request: Request,
  slug: string,
  input?: CommentSettings,
) {
  const run = async (site: Site, session: Session | null, q: RbacQuery) => {
    const f = await facts(
      request,
      site,
      {
        siteId: site.id,
        versionId: site.currentVersionId,
        entry: { kind: "main" },
      },
      session,
    );
    if (
      !describeCommentPermissions(f)[
        input ? "canManageSettings" : "canAggregate"
      ]
    )
      fail(404, "Settings not found");
    if (input)
      await q(
        "INSERT INTO site_comment_settings(site_id,main_policy,updated_by,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(site_id) DO UPDATE SET main_policy=excluded.main_policy,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
        [site.id, input.mainPolicy, session!.userId, Date.now()],
      );
    const [row] = await q(
      "SELECT main_policy FROM site_comment_settings WHERE site_id=$1",
      [site.id],
    );
    return { mainPolicy: row?.main_policy ?? "login" };
  };
  return input
    ? write(request, slug, (q, site, session) => run(site, session, q))
    : run(await commentSite(slug), await resolveSession(request), rbacQuery);
}

/** Explicit desired state makes retries safe; never accept an actor ID from the client. */
export async function setCommentReaction(request: Request, slug: string, threadId: string, messageId: string, emoji: CommentEmoji, reacted: boolean): Promise<CommentReaction[]> {
  const canonical = canonicalCommentEmoji(emoji);
  if (!canonical) return fail(400, "Expected one Unicode emoji");
  emoji = canonical;
  return write(request, slug, async (q, site, session) => {
    const { f } = await authorizedThread(request, site, threadId, session);
    if (!describeCommentPermissions(f).canReply) fail(403, "Comment reactions are not allowed");
    const [message] = await q("SELECT id FROM comment_messages WHERE id=$1 AND thread_id=$2 AND deleted_at IS NULL", [messageId, threadId]);
    if (!message) fail(404, "Comment not found");
    if (reacted) {
      const existing = await q("SELECT emoji FROM comment_reactions WHERE message_id=$1 AND user_id=$2", [messageId,session.userId]);
      if (!existing.some(row=>row.emoji===emoji)) {
        if (existing.length >= 12) fail(409, "You can add up to 12 different reactions per message");
        const distinct = await q("SELECT DISTINCT emoji FROM comment_reactions WHERE message_id=$1", [messageId]);
        if (distinct.length >= 64 && !distinct.some(row=>row.emoji===emoji)) fail(409, "This message has reached its limit of 64 different reactions");
      }
    }
    if (reacted) await q("INSERT INTO comment_reactions(message_id,user_id,emoji,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [messageId, session.userId, emoji, Date.now()]);
    else await q("DELETE FROM comment_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3", [messageId, session.userId, emoji]);
    const rows = await q("SELECT emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=$2 THEN 1 ELSE 0 END) AS reacted FROM comment_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY MIN(created_at),emoji", [messageId, session.userId]);
    return rows.map(r => ({ emoji: r.emoji as CommentEmoji, count: Number(r.count), reacted: Boolean(Number(r.reacted)) }));
  }, messageId);
}

export interface CommentReadInput {
  versionId: string;
  shareId?: string;
  aggregate?: boolean;
  since?: number;
  messageIds?: string[];
  through?: number;
}
/** Reading progress is private to an account and an authorized entry, never a site permission. */
export async function commentUnread(request: Request, slug: string, input: CommentReadInput) {
  const session = await resolveSession(request);
  const writing = request.method !== "GET";
  // Reading progress must never exhaust the bucket used for replies or login.
  checkRateLimit(request, Date.now(), `comment-progress:${writing ? "write" : "read"}:${session?.userId ?? clientKey(request)}`, 60, 120);
  if (writing) {
    if (!csrfSafe(request)) fail(401, "Cross-site request rejected");
    if (!session) fail(401, "Sign in to save reading progress");
  }
  const run = async (q: RbacQuery) => {
    await assertSessionCurrent(q, session);
    const [row] = await q("SELECT * FROM sites WHERE slug=$1 AND deleted_at IS NULL", [slug]);
    if (!row) return fail(404, "Site not found");
    const site = toSite(row);
    const scope: CommentScope = {siteId:site.id,versionId:input.versionId,entry:input.shareId ? {kind:"share",shareId:input.shareId} : {kind:"main"}};
    const f = await facts(request,site,scope,session);
    readable(f);
    const aggregate = Boolean(input.aggregate);
    if (aggregate && (input.shareId || !describeCommentPermissions(f).canAggregate)) fail(404, "Discussion not found");
    const key = commentReadScopeKey(input.versionId,input.shareId,aggregate);
    const now = Date.now();
    let since = Math.min(input.since ?? now, now), initialized = !session;
    if (session) {
      if (writing) {
        await q("INSERT INTO comment_read_scopes(user_id,site_id,scope_key,read_through) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [session.userId,site.id,key,Math.min(input.through ?? now,now)]);
        if (input.through !== undefined) await q("UPDATE comment_read_scopes SET read_through=CASE WHEN read_through<$4 THEN $4 ELSE read_through END WHERE user_id=$1 AND site_id=$2 AND scope_key=$3", [session.userId,site.id,key,Math.min(now,input.through)]);
      }
      const [progress] = await q("SELECT read_through FROM comment_read_scopes WHERE user_id=$1 AND site_id=$2 AND scope_key=$3", [session.userId,site.id,key]);
      initialized = Boolean(progress);
      since = progress ? Number(progress.read_through) : now;
    }
    const params: (string|number|null)[] = [site.id,since,session?.userId ?? null];
    let where = `s.site_id=$1 AND ${unreadMessagePredicate("m","$3","$2")}`;
    if (!aggregate) {
      params.push(input.versionId); where += ` AND s.version_id=$${params.length}`;
      if (input.shareId) {params.push(input.shareId); where += ` AND s.share_id=$${params.length}`;}
      else where += " AND s.kind='main'";
    }
    if (writing && session && input.messageIds?.length) {
      const receiptParams = [...params];
      const slots = input.messageIds.map(id => {receiptParams.push(id);return `$${receiptParams.length}`;}).join(",");
      await q(`INSERT INTO comment_read_messages(user_id,message_id) SELECT $3,m.id FROM comment_messages m JOIN comment_threads t ON t.id=m.thread_id JOIN comment_spaces s ON s.id=t.space_id WHERE ${where} AND m.id IN (${slots}) ON CONFLICT DO NOTHING`, receiptParams);
    }
    const messages = await q(`SELECT m.id,m.thread_id,m.created_at FROM comment_messages m JOIN comment_threads t ON t.id=m.thread_id JOIN comment_spaces s ON s.id=t.space_id WHERE ${where} ORDER BY m.created_at,m.id LIMIT 1001`, params);
    if (writing && session) {
      // Under the write lock: never advance beyond the first still-unread message.
      since = Math.max(since,messages.length ? Number(messages[0].created_at)-1 : now);
      await q("UPDATE comment_read_scopes SET read_through=$4 WHERE user_id=$1 AND site_id=$2 AND scope_key=$3",[session.userId,site.id,key,since]);
      // Receipts are shared by entries; only prune below every existing scope watermark.
      await q("DELETE FROM comment_read_messages WHERE user_id=$1 AND message_id IN (SELECT m.id FROM comment_messages m JOIN comment_threads t ON t.id=m.thread_id JOIN comment_spaces s ON s.id=t.space_id WHERE s.site_id=$2 AND m.created_at <= (SELECT MIN(read_through) FROM comment_read_scopes WHERE user_id=$1 AND site_id=$2))",[session.userId,site.id]);
    }
    return {since,initialized,snapshotAt:now,hasMore:messages.length>1000,messages:messages.slice(0,1000).map(m => ({id:String(m.id),threadId:String(m.thread_id),createdAt:Number(m.created_at)}))};
  };
  return writing ? rbacTransaction(run) : run(rbacQuery);
}
