import "server-only";
import { createId } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";

export async function autoFollow(
  q: RbacQuery,
  threadId: string,
  userId: string,
  source: "create" | "reply",
  now: number,
) {
  await q(
    "INSERT INTO comment_subscriptions(thread_id,user_id,state,source,created_at,updated_at) VALUES($1,$2,'following',$3,$4,$4) ON CONFLICT(thread_id,user_id) DO NOTHING",
    [threadId, userId, source, now],
  );
}
/** Same transaction as the reply. In-app delivery is an INSERT, so no lossy after-response job
 * or queue worker is needed. Snapshot recipients now; authorize content on every inbox read. */
export async function recordReply(
  q: RbacQuery,
  threadId: string,
  messageId: string,
  actorId: string,
  agent: boolean,
  now: number,
) {
  const eventId = createId("nev");
  const rows = await q(
    "INSERT INTO notification_events(id,type,message_id,actor_user_id,actor_kind,created_at) VALUES($1,'comment.reply_created',$2,$3,$4,$5) ON CONFLICT(type,message_id) DO NOTHING RETURNING id",
    [eventId, messageId, actorId, agent ? "agent" : "user", now],
  );
  if (!rows.length) return;
  // One set-based insert avoids a transaction round trip per follower.
  await q(
    `INSERT INTO user_notifications(id,event_id,recipient_user_id,created_at)
    SELECT $1 || '_' || sub.user_id,$1,sub.user_id,$3 FROM comment_subscriptions sub JOIN users u ON u.id=sub.user_id
    WHERE sub.thread_id=$2 AND sub.state='following' AND sub.user_id<>$4 AND u.disabled_at IS NULL
    ON CONFLICT(event_id,recipient_user_id) DO NOTHING`,
    [eventId, threadId, now, actorId],
  );
}
