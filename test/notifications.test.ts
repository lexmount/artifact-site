import * as sessions from "@/lib/session";
import * as db from "@/lib/db";
import * as access from "@/lib/comments/access";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  closeDbForTests,
  createId,
  upsertUser,
  createShare,
  rbacQuery,
  revokeShare,
} from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { hashToken } from "@/lib/share";
import {
  createComment,
  replyComment,
  getCommentDetail,
} from "@/lib/comments/service";
import {
  pruneNotifications,
  subscription,
  listNotifications,
  hasUnreadNotifications,
  markNotificationsRead,
  notificationTarget,
} from "@/lib/notifications/service";
import { authorizePreview } from "@/lib/preview-access";
const origin = "https://notifications.example";
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDbForTests();
});
async function identity() {
  const user = await upsertUser({
    authProvider: "notifications",
    providerSubject: createId("subject"),
    email: `${createId("mail")}@example.com`,
    emailVerified: true,
  });
  const { cookie } = await mintSession(new Request(origin), user.id);
  return { user, cookie: cookie.split(";")[0] };
}
function req(cookie: string, token?: string) {
  return new Request(origin, {
    headers: {
      cookie,
      origin,
      ...(token ? { "x-artifact-share": token } : {}),
    },
  });
}
async function fixture(shared = false) {
  const owner = await identity(),
    reader = await identity();
  const { site } = await createSite(
    { mode: "paste", html: "<html><body>Review me</body></html>" },
    { ownerId: owner.user.id },
  );
  if (shared) {
    await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1", [
      site.id,
    ]);
    site.visibility = "private";
  }
  const token = createId("token");
  const share = shared
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
  const root = await createComment(req(owner.cookie), site.slug, {
    scope: {
      siteId: site.id,
      versionId: site.currentVersionId,
      entry: share ? { kind: "share", shareId: share.id } : { kind: "main" },
    },
    anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" },
    body: "Review this",
    clientRequestId: randomUUID(),
  });
  return { owner, reader, site, token, share, threadId: root.detail.thread.id };
}
describe("collaboration notifications", () => {
  it("atomically subscribes participants and deduplicates replies without notifying the actor", async () => {
    const f = await fixture();
    const input = { body: "A reply", clientRequestId: randomUUID() };
    await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, input);
    await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, input);
    expect((await listNotifications(req(f.owner.cookie))).items).toHaveLength(
      1,
    );
    expect((await listNotifications(req(f.reader.cookie))).items).toHaveLength(
      0,
    );
    expect(
      await subscription(req(f.reader.cookie), f.site.slug, f.threadId),
    ).toEqual({ following: true });
    expect(await hasUnreadNotifications(req(f.owner.cookie))).toEqual({
      hasUnread: true,
    });
    await markNotificationsRead(req(f.owner.cookie));
    expect(await hasUnreadNotifications(req(f.owner.cookie))).toEqual({
      hasUnread: false,
    });
    expect(await rbacQuery("SELECT * FROM comment_read_messages")).toHaveLength(
      0,
    );
  });
  it("preserves explicit unfollow across another reply", async () => {
    const f = await fixture();
    await subscription(req(f.owner.cookie), f.site.slug, f.threadId, false);
    await replyComment(req(f.owner.cookie), f.site.slug, f.threadId, {
      body: "Still muted",
      clientRequestId: randomUUID(),
    });
    await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, {
      body: "Reply",
      clientRequestId: randomUUID(),
    });
    expect((await listNotifications(req(f.owner.cookie))).items).toHaveLength(
      0,
    );
    expect(
      await subscription(req(f.owner.cookie), f.site.slug, f.threadId),
    ).toEqual({ following: false });
  });
  it("remembers only verified share access and rechecks revocation including preview subresources", async () => {
    const f = await fixture(true);
    await expect(
      subscription(req(f.reader.cookie), f.site.slug, f.threadId, true),
    ).rejects.toThrow();
    await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
      body: "Visitor",
      clientRequestId: randomUUID(),
    });
    await replyComment(req(f.owner.cookie), f.site.slug, f.threadId, {
      body: "Owner reply",
      clientRequestId: randomUUID(),
    });
    const page = await listNotifications(req(f.reader.cookie));
    expect(page.items[0].available).toBe(true);
    expect(
      await notificationTarget(req(f.reader.cookie), page.items[0].id),
    ).not.toBeNull();
    const preview = await authorizePreview(
      new Request(`${origin}?v=${f.site.currentVersionId}`, {
        headers: { cookie: f.reader.cookie },
      }),
      f.site,
      null,
    );
    expect(preview?.key).toBeTruthy();
    await revokeShare(f.share!.id);
    const hidden = (await listNotifications(req(f.reader.cookie))).items[0];
    expect(hidden).toEqual({
      id: page.items[0].id,
      createdAt: page.items[0].createdAt,
      readAt: null,
      available: false,
    });
    expect(await hasUnreadNotifications(req(f.reader.cookie))).toEqual({
      hasUnread: false,
    });
    expect(
      await authorizePreview(req(f.reader.cookie), f.site, preview!.key),
    ).toBeNull();
    // Owner's historical share aggregation remains readable.
    expect(
      (await getCommentDetail(req(f.owner.cookie), f.site.slug, f.threadId))
        .thread.id,
    ).toBe(f.threadId);
  });
  it("does not expose or mark another user's notification and rejects unsafe origins", async () => {
    const f = await fixture();
    await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, {
      body: "Hi",
      clientRequestId: randomUUID(),
    });
    const item = (await listNotifications(req(f.owner.cookie))).items[0];
    expect(await notificationTarget(req(f.reader.cookie), item.id)).toBeNull();
    await markNotificationsRead(req(f.reader.cookie), item.id);
    expect(
      (await listNotifications(req(f.owner.cookie))).items[0].readAt,
    ).toBeNull();
    await expect(
      markNotificationsRead(
        new Request(origin, {
          headers: { cookie: f.owner.cookie, origin: "https://evil.example" },
        }),
      ),
    ).rejects.toThrow();
  });
  it("invalidates receipts on expiry, authorization revision and tenant transfer", async () => {
    const f = await fixture(true);
    await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
      body: "Visit",
      clientRequestId: randomUUID(),
    });
    await rbacQuery("UPDATE share_access_receipts SET expires_at=0");
    await expect(
      getCommentDetail(req(f.reader.cookie), f.site.slug, f.threadId),
    ).rejects.toThrow();
    await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
      body: "Revalidate",
      clientRequestId: randomUUID(),
    });
    await rbacQuery(
      "UPDATE site_shares SET access_revision=access_revision+1 WHERE id=$1",
      [f.share!.id],
    );
    await expect(
      getCommentDetail(req(f.reader.cookie), f.site.slug, f.threadId),
    ).rejects.toThrow();
    await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
      body: "Verify again",
      clientRequestId: randomUUID(),
    });
    const tenant = createId("tenant");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Other')", [
      tenant,
    ]);
    await rbacQuery("UPDATE sites SET tenant_id=$1 WHERE id=$2", [
      tenant,
      f.site.id,
    ]);
    await expect(
      getCommentDetail(req(f.reader.cookie), f.site.slug, f.threadId),
    ).rejects.toThrow();
  });
});

it("keeps read-only inbox, badge, target and follow status off the mutation lock", async () => {
  const f = await fixture();
  await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, {
    body: "reply",
    clientRequestId: randomUUID(),
  });
  const lock = vi.spyOn(db, "rbacTransaction");
  const page = await listNotifications(req(f.owner.cookie));
  await hasUnreadNotifications(req(f.owner.cookie));
  await notificationTarget(req(f.owner.cookie), page.items[0].id);
  await subscription(req(f.owner.cookie), f.site.slug, f.threadId);
  expect(lock).not.toHaveBeenCalled();
});
it("checks each unread space once, without hiding a readable older page", async () => {
  const f = await fixture(true);
  await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
    body: "Join",
    clientRequestId: randomUUID(),
  });
  const main = await createComment(req(f.reader.cookie), f.site.slug, {
    scope: {
      siteId: f.site.id,
      versionId: f.site.currentVersionId,
      entry: { kind: "share", shareId: f.share!.id },
    },
    anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" },
    body: "Earlier",
    clientRequestId: randomUUID(),
  });
  // Give the reader an older independently-readable discussion on another public site.
  const { site } = await createSite(
    { mode: "paste", html: "<p>Public</p>" },
    { ownerId: f.reader.user.id },
  );
  const root = await createComment(req(f.reader.cookie), site.slug, {
    scope: {
      siteId: site.id,
      versionId: site.currentVersionId,
      entry: { kind: "main" },
    },
    anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" },
    body: "Keep",
    clientRequestId: randomUUID(),
  });
  await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1", [
    site.id,
  ]);
  await replyComment(req(f.owner.cookie), site.slug, root.detail.thread.id, {
    body: "Readable",
    clientRequestId: randomUUID(),
  });
  for (let i = 0; i < 35; i++)
    await replyComment(
      req(f.owner.cookie),
      f.site.slug,
      main.detail.thread.id,
      { body: "Hidden" + i, clientRequestId: randomUUID() },
    );
  await revokeShare(f.share!.id);
  const resolve = vi.spyOn(access, "resolveCommentAccess"),
    query = vi.spyOn(db, "rbacQuery");
  expect(await hasUnreadNotifications(req(f.reader.cookie))).toEqual({
    hasUnread: true,
  });
  expect(resolve.mock.calls.length).toBe(2);
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.includes("AS author_display_name") ||
        sql.includes("COUNT(*) AS n FROM versions"),
    ),
  ).toBe(false);
  const first = await listNotifications(req(f.reader.cookie), true);
  expect(first.items.some((item) => item.available)).toBe(true);
});
it("caches version ordinals for a page of replies", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    await replyComment(req(f.reader.cookie), f.site.slug, f.threadId, {
      body: "reply" + i,
      clientRequestId: randomUUID(),
    });
  const query = vi.spyOn(db, "rbacQuery");
  await listNotifications(req(f.owner.cookie));
  expect(
    query.mock.calls.filter(([sql]) =>
      sql.includes("COUNT(*) AS n FROM versions"),
    ),
  ).toHaveLength(1);
});
it("does not bind an independently authorized owner's preview to an old share receipt", async () => {
  const f = await fixture(true);
  await replyComment(req(f.owner.cookie, f.token), f.site.slug, f.threadId, {
    body: "Owner using share",
    clientRequestId: randomUUID(),
  });
  expect(
    await rbacQuery("SELECT * FROM share_access_receipts WHERE user_id=$1", [
      f.owner.user.id,
    ]),
  ).toHaveLength(1);
  const preview = await authorizePreview(req(f.owner.cookie), f.site, null);
  expect(preview?.key).toBeTruthy();
  await revokeShare(f.share!.id);
  expect(
    await authorizePreview(req(f.owner.cookie), f.site, preview!.key),
  ).not.toBeNull();
});
it("prunes expired notifications and receipts while keeping comments and follows", async () => {
  const f = await fixture(true);
  await replyComment(req(f.reader.cookie, f.token), f.site.slug, f.threadId, {
    body: "Visit",
    clientRequestId: randomUUID(),
  });
  await replyComment(req(f.owner.cookie), f.site.slug, f.threadId, {
    body: "Keep",
    clientRequestId: randomUUID(),
  });
  const [event] = await rbacQuery(
    "SELECT e.id FROM notification_events e JOIN comment_messages m ON m.id=e.message_id WHERE m.thread_id=$1 ORDER BY e.created_at,e.id LIMIT 1",
    [f.threadId],
  );
  await rbacQuery("UPDATE notification_events SET created_at=1 WHERE id=$1", [
    String(event.id),
  ]);
  await rbacQuery(
    "UPDATE share_access_receipts SET expires_at=1 WHERE user_id=$1",
    [f.reader.user.id],
  );
  const messages = await rbacQuery("SELECT id FROM comment_messages"),
    follows = await rbacQuery("SELECT * FROM comment_subscriptions");
  await pruneNotifications();
  expect(
    await rbacQuery(
      "SELECT e.id FROM notification_events e JOIN comment_messages m ON m.id=e.message_id WHERE m.thread_id=$1",
      [f.threadId],
    ),
  ).toHaveLength(1);
  expect(
    await rbacQuery("SELECT * FROM user_notifications WHERE event_id=$1", [
      String(event.id),
    ]),
  ).toEqual([]);
  expect(
    await rbacQuery("SELECT * FROM share_access_receipts WHERE user_id=$1", [
      f.reader.user.id,
    ]),
  ).toEqual([]);
  expect(await rbacQuery("SELECT id FROM comment_messages")).toEqual(messages);
  expect(await rbacQuery("SELECT * FROM comment_subscriptions")).toEqual(
    follows,
  );
});
it("rejects a session revoked after resolution before changing subscription state", async () => {
  const f = await fixture();
  const request = req(f.owner.cookie),
    session = await sessions.resolveSession(request);
  expect(session).not.toBeNull();
  const before = await rbacQuery(
    "SELECT * FROM comment_subscriptions WHERE thread_id=$1 AND user_id=$2",
    [f.threadId, f.owner.user.id],
  );
  await rbacQuery("UPDATE sessions SET revoked_at=$2 WHERE id=$1", [
    session!.id,
    Date.now(),
  ]);
  vi.spyOn(sessions, "resolveSession").mockResolvedValue(session);
  await expect(
    subscription(request, f.site.slug, f.threadId, false),
  ).rejects.toThrow(/revoked|expired/);
  expect(
    await rbacQuery(
      "SELECT * FROM comment_subscriptions WHERE thread_id=$1 AND user_id=$2",
      [f.threadId, f.owner.user.id],
    ),
  ).toEqual(before);
});
