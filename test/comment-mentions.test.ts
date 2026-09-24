import * as db from "@/lib/db";
import { MENTION_CANDIDATE_LIMIT } from "@/lib/comments/mention-types";
import * as access from "@/lib/comments/access";
import {
  mentionAudiencePolicy,
  mentionCandidatePage,
} from "@/lib/comments/mention-audience";
import { GET as candidatesGET } from "@/app/api/sites/[slug]/comments/mentions/route";
import { mentionTrigger } from "@/components/comments/mention-trigger";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  closeDbForTests,
  createId,
  upsertUser,
  rbacQuery,
  createShare,
  revokeShare,
} from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { hashToken } from "@/lib/share";
import {
  createComment,
  replyComment,
  mutateMessage,
} from "@/lib/comments/service";
import { mentionCandidates, mayMention } from "@/lib/comments/mention-audience";
import {
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications/service";
import {
  rebaseMentions,
  normalizedMentions,
} from "@/lib/comments/mention-types";
const origin = "https://mentions.example";
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDbForTests();
});
async function person(name: string) {
  const user = await upsertUser({
    authProvider: "mentions",
    providerSubject: createId("sub"),
    email: createId("mail") + "@example.com",
    emailVerified: true,
    displayName: name,
  });
  const { cookie } = await mintSession(new Request(origin), user.id);
  return {
    user,
    request: (token?: string) =>
      new Request(origin, {
        headers: {
          cookie: cookie.split(";")[0],
          origin,
          ...(token ? { "x-artifact-share": token } : {}),
        },
      }),
  };
}
async function fixture(shared = false) {
  const owner = await person("Owner"),
    reader = await person("Reader"),
    other = await person("Other");
  const { site } = await createSite(
    { mode: "paste", html: "<p>Review me</p>" },
    { ownerId: owner.user.id },
  );
  await rbacQuery("UPDATE sites SET visibility=$2 WHERE id=$1", [
    site.id,
    shared ? "private" : "public",
  ]);
  site.visibility = shared ? "private" : "public";
  const token = createId("token"),
    share = shared
      ? await createShare({
          id: createId("shr"),
          label: null,
          createdAnonId: null,
          siteId: site.id,
          mode: "comment",
          versionId: site.currentVersionId,
          policy: "login",
          tokenHash: hashToken(token),
          passcodeHash: null,
          expiresAt: null,
          createdBy: owner.user.id,
          allowAi: false,
        })
      : null;
  const scope = {
    siteId: site.id,
    versionId: site.currentVersionId,
    entry: share
      ? { kind: "share" as const, shareId: share.id }
      : { kind: "main" as const },
  };
  const root = await createComment(owner.request(), site.slug, {
    scope,
    anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" },
    body: "Review",
    clientRequestId: randomUUID(),
  });
  return {
    site,
    owner,
    reader,
    other,
    scope,
    token,
    share,
    id: root.detail.thread.id,
  };
}
function mention(userId: string, label: string) {
  return { userId, label, start: 0, end: label.length + 1 };
}
it("rebases identities through edits and trims without changing UTF-16 ranges", () => {
  const m = mention("u", "熊😀");
  expect(rebaseMentions("@熊😀 ok", "Hi @熊😀 ok", [m])).toEqual([
    { ...m, start: 3, end: m.end + 3 },
  ]);
  expect(rebaseMentions("@熊😀 ok", "@熊 ok", [m])).toEqual([]);
  expect(
    normalizedMentions("  @熊😀 ", [{ ...m, start: 2, end: m.end + 2 }]),
  ).toEqual([m]);
});
it("deduplicates following and mention, preserves read state on remove/re-add", async () => {
  const f = await fixture(),
    m = mention(f.owner.user.id, "Owner");
  const message = await replyComment(f.reader.request(), f.site.slug, f.id, {
    body: "@Owner review",
    mentions: [m],
    clientRequestId: randomUUID(),
  });
  let inbox = await listNotifications(f.owner.request());
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({ available: true, mentioned: true });
  await markNotificationsRead(f.owner.request());
  const edited = await mutateMessage(
    f.reader.request(),
    f.site.slug,
    f.id,
    message.id,
    { body: "review", mentions: [], expectedRevision: message.revision },
    "edit",
  );
  await mutateMessage(
    f.reader.request(),
    f.site.slug,
    f.id,
    message.id,
    { body: "@Owner review", mentions: [m], expectedRevision: edited.revision },
    "edit",
  );
  inbox = await listNotifications(f.owner.request());
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0].readAt).not.toBeNull();
});
it("rejects forged recipients, labels and ranges atomically", async () => {
  const f = await fixture();
  for (const mentions of [
    [mention(f.other.user.id, "Other")],
    [mention(f.owner.user.id, "Fake")],
    [{ ...mention(f.owner.user.id, "Owner"), end: 99 }],
  ]) {
    await expect(
      replyComment(f.reader.request(), f.site.slug, f.id, {
        body: "@Owner test",
        mentions,
        clientRequestId: randomUUID(),
      }),
    ).rejects.toThrow();
  }
  expect(
    await rbacQuery("SELECT id FROM comment_messages WHERE thread_id=$1", [
      f.id,
    ]),
  ).toHaveLength(1);
});
it("restricts discovery and commit to the exact share; revoked receipts cannot grant access", async () => {
  const f = await fixture(true),
    context = { site: f.site, scope: f.scope, actorUserId: f.owner.user.id };
  expect(await mentionCandidates(context, "")).toEqual([]);
  await replyComment(f.reader.request(f.token), f.site.slug, f.id, {
    body: "Here",
    clientRequestId: randomUUID(),
  });
  expect(await mentionCandidates(context, "read")).toEqual([
    { userId: f.reader.user.id, label: "Reader" },
  ]);
  expect(
    await mayMention(
      { ...context, scope: { ...f.scope, entry: { kind: "main" } } },
      f.reader.user.id,
    ),
  ).toBe(false);
  await revokeShare(f.share!.id);
  expect(await mayMention(context, f.reader.user.id)).toBe(false);
});
it("supports root mentions, excludes self notifications and disabled users", async () => {
  const f = await fixture();
  await replyComment(f.reader.request(), f.site.slug, f.id, {
    body: "Join",
    clientRequestId: randomUUID(),
  });
  await createComment(f.owner.request(), f.site.slug, {
    scope: f.scope,
    anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" },
    body: "@Reader",
    mentions: [mention(f.reader.user.id, "Reader")],
    clientRequestId: randomUUID(),
  });
  expect((await listNotifications(f.reader.request())).items).toHaveLength(1);
  await rbacQuery("UPDATE users SET disabled_at=$2 WHERE id=$1", [
    f.reader.user.id,
    Date.now(),
  ]);
  expect(
    await mentionCandidates(
      { site: f.site, scope: f.scope, actorUserId: f.owner.user.id },
      "Reader",
    ),
  ).toEqual([]);
});

it("preserves inbox rows and read state through the event-kind migration", async () => {
  const f = await fixture();
  await replyComment(f.reader.request(), f.site.slug, f.id, {
    body: "Before migration",
    clientRequestId: randomUUID(),
  });
  await markNotificationsRead(f.owner.request());
  const before = await rbacQuery(
    "SELECT * FROM user_notifications ORDER BY id",
  );
  const { up } = await import("@/lib/migrations/0013-comment-mentions");
  const { rbacTransaction } = await import("@/lib/db");
  await rbacTransaction(up);
  expect(
    await rbacQuery("SELECT * FROM user_notifications ORDER BY id"),
  ).toEqual(before);
  expect((await listNotifications(f.owner.request())).items).toHaveLength(1);
});
it("does not notify an author who mentions themselves", async () => {
  const f = await fixture();
  await replyComment(f.owner.request(), f.site.slug, f.id, {
    body: "@Owner",
    mentions: [mention(f.owner.user.id, "Owner")],
    clientRequestId: randomUUID(),
  });
  expect((await listNotifications(f.owner.request())).items).toEqual([]);
});
it("keeps mention offsets inside formatted labels instead of breaking code or links", async () => {
  const { commentTextParts } = await import("@/lib/comments/format");
  const body = "`@Owner` [@Reader](https://example.com) @Owner";
  const parts = commentTextParts(body, true);
  for (const part of parts)
    expect(body.slice(part.start!, part.start! + part.text.length)).toBe(
      part.text,
    );
  expect(parts.filter((p) => p.kind !== "text").map((p) => p.start)).toEqual([
    1, 10,
  ]);
});

it("serves candidate searches without taking the global mutation lock", async () => {
  const f = await fixture();
  await replyComment(f.reader.request(), f.site.slug, f.id, {
    body: "Joined",
    clientRequestId: randomUUID(),
  });
  const lock = vi.spyOn(db, "rbacTransaction");
  const request = new Request(
    `${origin}/api/sites/${f.site.slug}/comments/mentions?versionId=${f.scope.versionId}&q=Reader`,
    { headers: f.owner.request().headers },
  );
  const response = await candidatesGET(request, {
    params: Promise.resolve({ slug: f.site.slug }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).items).toContainEqual({
    userId: f.reader.user.id,
    label: "Reader",
  });
  expect(lock).not.toHaveBeenCalled();
});
it("caps authorization work even when every discovered candidate is denied", async () => {
  const f = await fixture(),
    context = { site: f.site, scope: f.scope, actorUserId: f.owner.user.id },
    provider = mentionAudiencePolicy(context)[0];
  vi.spyOn(provider, "search").mockResolvedValue(
    Array.from({ length: 60 }, (_, i) => ({
      userId: "unavailable_" + i,
      label: "Unavailable " + i,
    })),
  );
  const contains = vi.spyOn(provider, "contains"),
    resolve = vi.spyOn(access, "resolveCommentRecipientAccess");
  expect(await mentionCandidatePage(context, "")).toEqual({items: [], truncated: true});
  expect(resolve).toHaveBeenCalledTimes(MENTION_CANDIDATE_LIMIT);
  expect(contains).not.toHaveBeenCalled();
});
it.each(["你好@", "请@", "看看，@", "한국어@", "こんにちは@", "Hello @", "@"])(
  "opens mention selection after %s",
  (body) => {
    expect(mentionTrigger(body, body.length)).toEqual({
      start: body.length - 1,
      end: body.length,
      query: "",
    });
  },
);
it.each(["user@example", "user.name@", "élise@", "x@@", "123@"])(
  "does not treat email or identifier %s as a mention",
  (body) => {
    expect(mentionTrigger(body, body.length)).toBeNull();
  },
);
it("preserves the query and caret range for Chinese-adjacent mentions", () => {
  expect(mentionTrigger("你好@小林 后面", 5)).toEqual({
    start: 2,
    end: 5,
    query: "小林",
  });
});

it("does not let expired share participants crowd out live mention candidates", async () => {
  const f = await fixture(true);
  for (let i = 0; i < 20; i++) {
    const stale = await person(`A${String(i).padStart(2, "0")}`);
    await replyComment(stale.request(f.token), f.site.slug, f.id, {
      body: "Joined", clientRequestId: randomUUID(),
    });
    await rbacQuery("UPDATE share_access_receipts SET expires_at=$2 WHERE user_id=$1", [stale.user.id, Date.now() - 1]);
  }
  const live = await person("Zed");
  await replyComment(live.request(f.token), f.site.slug, f.id, {
    body: "Here", clientRequestId: randomUUID(),
  });
  const context = { site: f.site, scope: f.scope, actorUserId: f.owner.user.id };
  expect(await mayMention(context, live.user.id)).toBe(true);
  expect(await mentionCandidates(context, "")).toEqual([{userId: live.user.id, label: "Zed"}]);
  expect(await mentionCandidates({...context, actorUserId: live.user.id}, "Owner")).toEqual([{userId: f.owner.user.id, label: "Owner"}]);
  await rbacQuery("UPDATE share_access_receipts SET revoked_at=$2 WHERE user_id=$1", [live.user.id, Date.now()]);
  expect(await mentionCandidates(context, "")).toEqual([]);
});

it("keeps historical mentions editable after access loss without notifying again", async () => {
  const f = await fixture(true);
  await replyComment(f.reader.request(f.token), f.site.slug, f.id, {
    body: "Joined", clientRequestId: randomUUID(),
  });
  const mentions = [mention(f.reader.user.id, "Reader")];
  const message = await replyComment(f.owner.request(), f.site.slug, f.id, {
    body: "@Reader review", mentions, clientRequestId: randomUUID(),
  });
  const before = await rbacQuery("SELECT * FROM user_notifications WHERE recipient_user_id=$1", [f.reader.user.id]);
  await rbacQuery("UPDATE share_access_receipts SET revoked_at=$2 WHERE user_id=$1", [f.reader.user.id, Date.now()]);
  expect(await mayMention({site:f.site, scope:f.scope, actorUserId:f.owner.user.id}, f.reader.user.id)).toBe(false);
  const edited = await mutateMessage(f.owner.request(), f.site.slug, f.id, message.id,
    {body:"@Reader corrected", mentions, expectedRevision:message.revision}, "edit");
  expect(await rbacQuery("SELECT * FROM user_notifications WHERE recipient_user_id=$1", [f.reader.user.id])).toEqual(before);
  const inbox = await listNotifications(f.reader.request());
  expect(inbox.items.every(item => !item.available)).toBe(true);
  const removed = await mutateMessage(f.owner.request(), f.site.slug, f.id, message.id,
    {body:"corrected", mentions:[], expectedRevision:edited.revision}, "edit");
  await expect(mutateMessage(f.owner.request(), f.site.slug, f.id, message.id,
    {body:"@Reader corrected", mentions, expectedRevision:removed.revision}, "edit")).rejects.toThrow("Mention recipient is unavailable");
});

it("reuses a concurrently inserted mention event and preserves existing inbox state", async () => {
  const f = await fixture();
  await replyComment(f.reader.request(), f.site.slug, f.id, {body:"Joined", clientRequestId:randomUUID()});
  const root = await createComment(f.owner.request(), f.site.slug, {
    scope:f.scope, anchor:{kind:"document", schemaVersion:1, filePath:"index.html"},
    body:"@Reader", mentions:[mention(f.reader.user.id,"Reader")], clientRequestId:randomUUID(),
  });
  await markNotificationsRead(f.reader.request());
  const [row] = await rbacQuery("SELECT id FROM comment_messages WHERE thread_id=$1", [root.detail.thread.id]);
  const messageId = String(row.id);
  const before = await rbacQuery("SELECT * FROM user_notifications WHERE recipient_user_id=$1", [f.reader.user.id]);
  const {syncMentions} = await import("@/lib/comments/mentions");
  await db.rbacTransaction(async q => {
    await q("DELETE FROM comment_mentions WHERE message_id=$1", [messageId]);
    // Simulate the initial lookup missing an event committed before the INSERT.
    await syncMentions((sql, params) => sql.startsWith("SELECT id FROM notification_events") ? Promise.resolve([]) : q(sql, params),
      {site:f.site, scope:f.scope, actorUserId:f.owner.user.id}, messageId, "@Reader",
      [mention(f.reader.user.id,"Reader")], false, Date.now());
  });
  expect(await rbacQuery("SELECT * FROM user_notifications WHERE recipient_user_id=$1", [f.reader.user.id])).toEqual(before);
  expect(await rbacQuery("SELECT id FROM notification_events WHERE message_id=$1", [messageId])).toHaveLength(1);
});
