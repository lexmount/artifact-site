import "server-only";
import { createId } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import { mayMention, type MentionAudienceContext } from "./mention-audience";
import type { CommentMention } from "./mention-types";
import { fail } from "./store";
/** Tombstones prevent remove/re-add edits from repeatedly notifying the same person. */
export async function syncMentions(
  q: RbacQuery,
  context: MentionAudienceContext,
  messageId: string,
  body: string,
  mentions: CommentMention[],
  agent: boolean,
  now: number,
) {
  let end = 0;
  const ids = new Set<string>();
  const old = await q(
    "SELECT mentioned_user_id,removed_at FROM comment_mentions WHERE message_id=$1",
    [messageId],
  );
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (
      mention.start < end ||
      mention.end > body.length ||
      body.slice(mention.start, mention.end) !== "@" + mention.label
    )
      fail(400, "Invalid mention range");
    end = mention.end;
    const [recipient] = await q("SELECT display_name FROM users WHERE id=$1", [
      mention.userId,
    ]);
    if (
      !old.some(
        (row) =>
          row.mentioned_user_id === mention.userId && row.removed_at == null,
      ) &&
      String(recipient?.display_name ?? "").slice(0, 100) !== mention.label
    )
      fail(400, "Mention recipient label changed; select them again");
    // Retained mentions are historical attribution, not a new delivery. Losing access must
    // not block an author's unrelated edit. Only new/re-added recipients need fresh admission;
    // tombstones prevent repeat delivery, and inbox reads always recheck current access.
    const previous = old.find(
      (row) => row.mentioned_user_id === mention.userId,
    );
    if (
      (!previous || previous.removed_at != null) &&
      !(await mayMention(context, mention.userId))
    )
      fail(400, "Mention recipient is unavailable in this discussion");
    ids.add(mention.userId);
  }
  await q(
    "UPDATE comment_mentions SET removed_at=$2 WHERE message_id=$1 AND removed_at IS NULL",
    [messageId, now],
  );
  for (const userId of ids) {
    const first = !old.some((row) => row.mentioned_user_id === userId);
    await q(
      "INSERT INTO comment_mentions(message_id,mentioned_user_id,created_at) VALUES($1,$2,$3) ON CONFLICT(message_id,mentioned_user_id) DO UPDATE SET removed_at=NULL",
      [messageId, userId, now],
    );
    if (!first || userId === context.actorUserId) continue;
    let [event] = await q(
      "SELECT id FROM notification_events WHERE message_id=$1 ORDER BY created_at,id LIMIT 1",
      [messageId],
    );
    if (!event) {
      [event] = await q(
        "INSERT INTO notification_events(id,type,message_id,actor_user_id,actor_kind,created_at) VALUES($1,'comment.mentioned',$2,$3,$4,$5) ON CONFLICT(type,message_id) DO UPDATE SET id=notification_events.id RETURNING id",
        [
          createId("nev"),
          messageId,
          context.actorUserId,
          agent ? "agent" : "user",
          now,
        ],
      );
    }
    if (!event) fail(500, "Could not record mention notification");
    await q(
      "INSERT INTO user_notifications(id,event_id,recipient_user_id,reason,created_at) VALUES($1,$2,$3,'mention',$4) ON CONFLICT(event_id,recipient_user_id) DO UPDATE SET reason='mention'",
      [String(event.id) + "_" + userId, String(event.id), userId, now],
    );
  }
}
