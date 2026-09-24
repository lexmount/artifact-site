import "server-only";
import {
  getSite,
  rbacQuery,
  rbacTransaction,
  toSite,
  type Row,
} from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import { resolveSession, csrfSafe } from "@/lib/session";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { isTokenSession } from "@/lib/publish-token";
import { loadThread, fail, spaceDTO, messageDTO } from "@/lib/comments/store";
import { resolveCommentAccess } from "@/lib/comments/access";
import { describeCommentPermissions } from "@/lib/comments/permissions";
import { rememberShareAccess } from "./receipts";
import { config } from "@/lib/config";
import { policy } from "@/lib/settings";
import type { Session } from "@/lib/types";
import type { NotificationItem, NotificationPage } from "./types";

export async function notificationIdentity(request: Request, mutate = false) {
  const session = await resolveSession(request);
  if (!session || isTokenSession(session))
    return fail(401, "A browser session is required");
  if (!mutate) await assertSessionCurrent(rbacQuery, session);
  if (mutate && !csrfSafe(request)) fail(403, "Invalid request origin");
  return session;
}
export async function subscription(
  request: Request,
  slug: string,
  threadId: string,
  following?: boolean,
) {
  const session = await resolveSession(request);
  if (!session) return fail(401, "Sign in to follow discussions");
  if (following !== undefined && !isTokenSession(session) && !csrfSafe(request))
    fail(403, "Invalid request origin");
  const run = async (q: RbacQuery) => {
    const found = await loadThread(threadId, q);
    if (!found) return fail(404, "Discussion not found");
    const [row] = await q("SELECT * FROM sites WHERE id=$1 AND slug=$2", [
      found.space.siteId,
      slug,
    ]);
    if (!row) return fail(404, "Discussion not found");
    const site = toSite(row);
    // resolveCommentAccess revalidates the session through the ambient query/transaction.
    if (
      !describeCommentPermissions(
        await resolveCommentAccess(request, site, found.space, session),
      ).canRead
    )
      fail(404, "Discussion not found");
    if (following !== undefined) {
      await q(
        `INSERT INTO comment_subscriptions(thread_id,user_id,state,source,created_at,updated_at) VALUES($1,$2,$3,'manual',$4,$4)
        ON CONFLICT(thread_id,user_id) DO UPDATE SET state=excluded.state,source='manual',updated_at=excluded.updated_at`,
        [
          threadId,
          session.userId,
          following ? "following" : "unfollowed",
          Date.now(),
        ],
      );
      if (following)
        await rememberShareAccess(q, request, site, found.space, session);
    }
    const [sub] = await q(
      "SELECT state FROM comment_subscriptions WHERE thread_id=$1 AND user_id=$2",
      [threadId, session.userId],
    );
    return { following: sub?.state === "following" };
  };
  return following === undefined ? run(rbacQuery) : rbacTransaction(run);
}
const select = `SELECT n.*,e.message_id,e.actor_kind,m.thread_id,m.deleted_at AS message_deleted,sp.id AS space_id,sp.site_id,sp.version_id,sp.kind,sp.share_id
  FROM user_notifications n JOIN notification_events e ON e.id=n.event_id JOIN comment_messages m ON m.id=e.message_id
  JOIN comment_threads th ON th.id=m.thread_id JOIN comment_spaces sp ON sp.id=th.space_id`;
const cutoff = () =>
  policy.notificationRetentionDays
    ? Date.now() - policy.notificationRetentionDays * 86_400_000
    : 0;
type InboxCache = {
  sites: Map<string, Awaited<ReturnType<typeof getSite>>>;
  access: Map<string, boolean>;
  ordinals: Map<string, number>;
  labels: Map<string, string | null>;
};
const inboxCache = (): InboxCache => ({
  sites: new Map(),
  access: new Map(),
  ordinals: new Map(),
  labels: new Map(),
});
async function readableNotification(
  request: Request,
  session: Session,
  row: Row,
  cache: InboxCache,
) {
  const siteId = String(row.site_id);
  if (!cache.sites.has(siteId)) cache.sites.set(siteId, await getSite(siteId));
  const site = cache.sites.get(siteId);
  if (!site || row.message_deleted != null) return null;
  const scope = spaceDTO({ ...row, id: row.space_id });
  // Management-mode headers are not passed from the client. Inbox rights never imply governance.
  if (!cache.access.has(scope.id))
    cache.access.set(
      scope.id,
      describeCommentPermissions(
        await resolveCommentAccess(request, site, scope, session),
      ).canRead,
    );
  if (!cache.access.get(scope.id)) return null;
  return { site, scope };
}
async function visible(
  request: Request,
  session: Session,
  row: Row,
  cache: InboxCache = inboxCache(),
): Promise<NotificationItem> {
  const base = {
    id: String(row.id),
    createdAt: Number(row.created_at),
    readAt: row.read_at == null ? null : Number(row.read_at),
  };
  const readable = await readableNotification(request, session, row, cache);
  if (!readable) return { ...base, available: false };
  const { site, scope } = readable;
  const [message] = await rbacQuery(
    "SELECT m.*,u.display_name AS author_display_name FROM comment_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.id=$1 AND m.deleted_at IS NULL",
    [String(row.message_id)],
  );
  if (!message) return { ...base, available: false };
  const dto = messageDTO(message);
  const shareId = scope.entry.kind === "share" ? scope.entry.shareId : null;
  if (shareId && !cache.labels.has(shareId)) {
    const [share] = await rbacQuery(
      "SELECT label FROM site_shares WHERE id=$1",
      [shareId],
    );
    cache.labels.set(shareId, share?.label ? String(share.label) : null);
  }
  const versionKey = JSON.stringify([site.id, scope.versionId]);
  if (!cache.ordinals.has(versionKey)) {
    const [ordinal] = await rbacQuery(
      "SELECT COUNT(*) AS n FROM versions WHERE site_id=$1 AND (created_at<(SELECT created_at FROM versions WHERE id=$2) OR id=$2)",
      [site.id, scope.versionId],
    );
    cache.ordinals.set(versionKey, Number(ordinal.n));
  }
  return {
    ...base,
    available: true,
    mentioned: row.reason === "mention",
    author: dto.authorDisplayName ?? null,
    agent: row.actor_kind === "agent",
    excerpt:
      dto.content.state === "visible" ? dto.content.body.slice(0, 240) : "",
    siteTitle: site.title,
    versionNumber: cache.ordinals.get(versionKey)!,
    shareLabel: shareId ? (cache.labels.get(shareId) ?? null) : null,
    shared: scope.entry.kind === "share",
    threadId: String(row.thread_id),
    messageId: String(row.message_id),
  };
}
/** Read-only authorization checks do not hold the global RBAC mutation lock. */
export async function listNotifications(
  request: Request,
  unread = false,
  before?: { time: number; id: string },
): Promise<NotificationPage> {
  const session = await notificationIdentity(request);
  const sharedCache = inboxCache();
  let cursor = before;
  // Skip inaccessible pages for the reader; reuse permission results across those pages.
  while (true) {
    const rows = await rbacQuery(
      `${select} WHERE n.recipient_user_id=$1 AND n.created_at>$2 ${unread ? "AND n.read_at IS NULL AND m.deleted_at IS NULL AND EXISTS(SELECT 1 FROM sites s WHERE s.id=sp.site_id AND s.deleted_at IS NULL)" : ""} ${cursor ? "AND (n.created_at<$3 OR (n.created_at=$3 AND n.id<$4))" : ""} ORDER BY n.created_at DESC,n.id DESC LIMIT 31`,
      [session.userId, cutoff(), ...(cursor ? [cursor.time, cursor.id] : [])],
    );
    const items: NotificationItem[] = [],
      cache = sharedCache;
    for (const row of rows.slice(0, 30)) {
      const item = await visible(request, session, row, cache);
      if (!unread || item.available) items.push(item);
    }
    const last = rows[29];
    const nextCursor =
      rows.length > 30
        ? { time: Number(last.created_at), id: String(last.id) }
        : null;
    if (!unread || items.length || !nextCursor) return { items, nextCursor };
    cursor = nextCursor;
  }
}
export async function hasUnreadNotifications(request: Request) {
  const session = await notificationIdentity(request);
  const [quick] = await rbacQuery(
    "SELECT 1 FROM user_notifications WHERE recipient_user_id=$1 AND read_at IS NULL AND created_at>$2 LIMIT 1",
    [session.userId, cutoff()],
  );
  if (!quick) return { hasUnread: false };
  // Many unread messages in one revoked share cost one authorization check, not one page
  // hydration per 30 messages. Do not cap the first page and hide older readable updates.
  const scopes = await rbacQuery(
    `SELECT sp.*,sp.id AS space_id,MAX(n.created_at) AS newest
    FROM user_notifications n JOIN notification_events e ON e.id=n.event_id
    JOIN comment_messages m ON m.id=e.message_id JOIN comment_threads th ON th.id=m.thread_id
    JOIN comment_spaces sp ON sp.id=th.space_id JOIN sites s ON s.id=sp.site_id
    WHERE n.recipient_user_id=$1 AND n.read_at IS NULL AND n.created_at>$2 AND m.deleted_at IS NULL AND s.deleted_at IS NULL
    GROUP BY sp.id,sp.site_id,sp.version_id,sp.kind,sp.share_id,sp.created_at ORDER BY newest DESC`,
    [session.userId, cutoff()],
  );
  const cache = inboxCache();
  for (const row of scopes)
    if (await readableNotification(request, session, row, cache))
      return { hasUnread: true };
  return { hasUnread: false };
}

export async function markNotificationsRead(
  request: Request,
  id?: string,
  through?: number,
) {
  const session = await notificationIdentity(request, true);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    await q(
      `UPDATE user_notifications SET read_at=$1 WHERE recipient_user_id=$2 AND read_at IS NULL ${id ? "AND id=$3" : "AND created_at<=$3"}`,
      [
        Date.now(),
        session.userId,
        id ?? Math.min(through ?? Date.now(), Date.now()),
      ],
    );
    return { ok: true };
  });
}
export async function notificationTarget(request: Request, id: string) {
  const session = await notificationIdentity(request);
  const [row] = await rbacQuery(
    `${select} WHERE n.id=$1 AND n.recipient_user_id=$2 AND n.created_at>$3`,
    [id, session.userId, cutoff()],
  );
  if (!row) return null;
  const readable = await readableNotification(
    request,
    session,
    row,
    inboxCache(),
  );
  if (!readable) return null;
  return {
    site: readable.site,
    scope: readable.scope,
    threadId: String(row.thread_id),
    messageId: String(row.message_id),
  };
}

export async function pruneNotifications(now = Date.now()) {
  return rbacTransaction(async (q) => {
    const [row] = await q(
      "SELECT value FROM settings WHERE scope='global' AND key='notificationRetentionDays'",
    );
    let days = config.notificationRetentionDays;
    if (row) {
      try {
        days = JSON.parse(String(row.value));
      } catch {
        return;
      }
    }
    if (!Number.isInteger(days) || days < 1 || days > 3650) return;
    if (days)
      await q(
        "DELETE FROM notification_events WHERE id IN (SELECT id FROM notification_events WHERE created_at<$1 ORDER BY created_at LIMIT 1000)",
        [now - days * 86_400_000],
      );
    await q(
      "DELETE FROM share_access_receipts WHERE (user_id,space_id) IN (SELECT user_id,space_id FROM share_access_receipts WHERE expires_at<$1 OR revoked_at IS NOT NULL LIMIT 1000)",
      [now],
    );
  });
}
