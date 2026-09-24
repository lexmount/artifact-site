import * as authorization from "@/lib/authz";
import * as shareAccess from "@/lib/share";
import { putUserSiteRole } from "@/lib/role-bindings";
import { getAgentContext } from "@/lib/comments/agent-context";
import * as commentAccess from "@/lib/comments/access";
import { createFingerprintCache, fingerprint } from "@/lib/comments/store";
import * as metadata from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { commentBody } from "@/lib/comments/http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDbForTests,
  createId,
  createShare,
  revokeShare,
  rbacQuery,
  rbacTransaction,
  upsertUser,
  setSitePurged,
} from "@/lib/db";
import { testAudit } from "./helpers";
import { createSite, replaceSiteContent } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { hashToken } from "@/lib/share";
import {
  associateCommentResult,
  commentResultOptions,
  commentUnread,
  setCommentReaction,
  getCommentPermissions,
  createComment,
  replyComment,
  mutateMessage,
  resolveComment,
  getCommentDetail,
  listComments,
  getMessages,
  commentSettings,
} from "@/lib/comments/service";
import { migrateNumbered } from "@/lib/migrations";
import { up as migrateReview } from "@/lib/migrations/0002-comment-review-indexes";
import { siteLikes } from "@/lib/comments/likes";
import { POST, GET } from "@/app/api/sites/[slug]/comments/route";
import { GET as commentOptions } from "@/app/api/sites/[slug]/comments/options/route";
import { PATCH as updateCommentStatus } from "@/app/api/sites/[slug]/comments/[threadId]/status/route";
const migrationDialect = process.env.ARTIFACT_DB_DRIVER === "postgres" ? "postgres" : "sqlite";
const origin = "https://comments.example";
afterEach(closeDbForTests);
async function identity() {
  const user = await upsertUser({
    authProvider: "comment-service",
    providerSubject: createId("subject"),
    email: `${createId("mail")}@example.com`,
    emailVerified: true,
  });
  const { cookie } = await mintSession(new Request(origin), user.id);
  return { user, cookie: cookie.split(";")[0] };
}
function req(cookie = "", body?: unknown, token?: string) {
  return new Request(`${origin}/api/comments`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      ...(token ? { "x-artifact-share": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture() {
  const owner = await identity(),
    reader = await identity();
  const { site } = await createSite(
    { mode: "paste", html: "<html><body>Comment</body></html>" },
    { ownerId: owner.user.id },
  );
  return {
    site,
    owner,
    reader,
    input: {
      scope: {
        siteId: site.id,
        versionId: site.currentVersionId,
        entry: { kind: "main" as const },
      },
      anchor: {
        kind: "document" as const,
        schemaVersion: 1 as const,
        filePath: "index.html",
      },
      body: "First comment",
      clientRequestId: randomUUID(),
    },
  };
}
describe("comment persistence and real routes", () => {
  it("creates one atomic root, replays after edits without retaining deleted plaintext", async () => {
    const { site, owner, input } = await fixture();
    const first = await createComment(req(owner.cookie), site.slug, input);
    const root = first.detail.messages.items[0];
    expect(first.replayed).toBe(false);
    expect(
      (await createComment(req(owner.cookie), site.slug, input)).replayed,
    ).toBe(true);
    await mutateMessage(
      req(owner.cookie),
      site.slug,
      first.detail.thread.id,
      root.id,
      { expectedRevision: 1, body: "edited" },
      "edit",
    );
    expect(
      (await createComment(req(owner.cookie), site.slug, input)).replayed,
    ).toBe(true);
    await mutateMessage(
      req(owner.cookie),
      site.slug,
      first.detail.thread.id,
      root.id,
      { expectedRevision: 2 },
      "delete",
    );
    const deleted = await getCommentDetail(
      req(owner.cookie),
      site.slug,
      first.detail.thread.id,
    );
    expect(deleted.messages.items[0].content.state).toBe("deleted");
    expect(deleted.thread.context.excerpt).toBeNull();
    expect(
      (
        await rbacQuery(
          "SELECT body,request_fingerprint FROM comment_messages WHERE id=$1",
          [root.id],
        )
      )[0],
    ).toMatchObject({ body: null });
    await expect(
      createComment(req(owner.cookie), site.slug, {
        ...input,
        body: "different",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await rbacQuery("SELECT id FROM comment_threads WHERE id=$1", [
          first.detail.thread.id,
        ])
      ).length,
    ).toBe(1);
  });
  it("serializes competing revision edits and restricts edits to author", async () => {
    const { site, owner, reader, input } = await fixture();
    const { detail } = await createComment(req(owner.cookie), site.slug, input);
    const root = detail.messages.items[0];
    await expect(
      mutateMessage(
        req(reader.cookie),
        site.slug,
        detail.thread.id,
        root.id,
        { expectedRevision: 1, body: "hijack" },
        "edit",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const results = await Promise.allSettled(
      ["a", "b"].map((body) =>
        mutateMessage(
          req(owner.cookie),
          site.slug,
          detail.thread.id,
          root.id,
          { expectedRevision: 1, body },
          "edit",
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("preserves replies after root deletion and paginates with scoped cursors", async () => {
    const { site, owner, reader, input } = await fixture();
    const { detail } = await createComment(req(owner.cookie), site.slug, input);
    for (let i = 0; i < 3; i++)
      await replyComment(req(reader.cookie), site.slug, detail.thread.id, {
        body: `reply ${i}`,
        clientRequestId: randomUUID(),
      });
    const page = await getMessages(
      req(owner.cookie),
      site.slug,
      detail.thread.id,
      undefined,
      2,
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    expect(
      (
        await getMessages(
          req(owner.cookie),
          site.slug,
          detail.thread.id,
          page.nextCursor!,
          2,
        )
      ).items,
    ).toHaveLength(2);
    await mutateMessage(
      req(owner.cookie),
      site.slug,
      detail.thread.id,
      detail.messages.items[0].id,
      { expectedRevision: 1 },
      "delete",
    );
    expect(
      (await getCommentDetail(req(owner.cookie), site.slug, detail.thread.id))
        .messages.items,
    ).toHaveLength(4);
    await expect(
      getMessages(req(owner.cookie), site.slug, detail.thread.id, "bad", 2),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("isolates main/share spaces and rejects anonymous writes", async () => {
    const { site, owner, reader, input } = await fixture();
    const token = createId("token");
    const share = await createShare({
      id: createId("shr"),
      siteId: site.id,
      tokenHash: hashToken(token),
      policy: "public",
      passcodeHash: null,
      label: null,
      createdBy: owner.user.id,
      createdAnonId: null,
      expiresAt: null,
      mode: "comment",
      versionId: null,
    });
    const scope = {
      ...input.scope,
      entry: { kind: "share" as const, shareId: share.id },
    };
    const created = await createComment(
      req(reader.cookie, undefined, token),
      site.slug,
      { ...input, scope },
    );
    expect(
      (
        await listComments(req(owner.cookie), site.slug, {
          kind: "space",
          scope: input.scope,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await getCommentDetail(
          req("", undefined, token),
          site.slug,
          created.detail.thread.id,
        )
      ).thread.id,
    ).toBe(created.detail.thread.id);
    await expect(
      replyComment(
        req("", undefined, token),
        site.slug,
        created.detail.thread.id,
        { body: "anonymous", clientRequestId: randomUUID() },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("checks status revision and permanent ownership", async () => {
    const { site, owner, reader, input } = await fixture();
    const { detail } = await createComment(req(owner.cookie), site.slug, input);
    await expect(
      resolveComment(req(reader.cookie), site.slug, detail.thread.id, {
        expectedRevision: 1,
        status: "resolved",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await rbacQuery("UPDATE users SET display_name=$1 WHERE id=$2", ["Review owner", owner.user.id]);
    const changed = await resolveComment(req(owner.cookie), site.slug, detail.thread.id, {
      expectedRevision: 1,
      status: "resolved",
    });
    expect((await getAgentContext(req(owner.cookie), site.slug, detail.thread.id)).threads[0].thread.resolution).not.toHaveProperty("resolvedByDisplayName");
    expect(changed).toMatchObject({ resolution: { status: "resolved", resolvedByDisplayName: "Review owner" } });
    const queries = vi.spyOn(metadata, "rbacQuery");
    try {
      const resolved = await getCommentDetail(req(owner.cookie), site.slug, detail.thread.id);
      expect(resolved.thread.resolution).toMatchObject({
        status: "resolved", resolvedBy: owner.user.id, resolvedByDisplayName: "Review owner",
      });
      expect(queries.mock.calls.some(([sql]) => /^SELECT display_name FROM users/.test(sql))).toBe(false);
    } finally { queries.mockRestore(); }
    await expect(
      resolveComment(req(owner.cookie), site.slug, detail.thread.id, {
        expectedRevision: 1,
        status: "open",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("repeats the review migration and recovers its lost ledger without losing comments", async () => {
    const { site, owner, input } = await fixture();
    const created = await createComment(req(owner.cookie), site.slug, input);
    await rbacTransaction(q => migrateReview(q, migrationDialect));
    await rbacTransaction(q => migrateReview(q, migrationDialect));
    await rbacQuery("DELETE FROM schema_migrations WHERE id='0002-comment-review-indexes'");
    await rbacTransaction(q => migrateNumbered(q, migrationDialect));
    expect(await rbacQuery("SELECT id FROM schema_migrations WHERE id='0002-comment-review-indexes'")).toHaveLength(1);
    const [row] = await rbacQuery("SELECT result_version_id FROM comment_threads WHERE id=$1", [created.detail.thread.id]);
    expect(row.result_version_id).toBeNull();
  });
  it("records migration once and rejects modified history", async () => {
    await fixture();
    await rbacTransaction(q => migrateNumbered(q, migrationDialect));
    expect(await rbacQuery("SELECT id FROM schema_migrations")).toHaveLength(13);
    const [saved] = await rbacQuery(
      "SELECT checksum FROM schema_migrations WHERE id='0001-comments'",
    );
    await rbacQuery("UPDATE schema_migrations SET checksum='tampered' WHERE id='0001-comments'");
    try {
      await expect(rbacTransaction(q => migrateNumbered(q, migrationDialect))).rejects.toThrow(
        "was modified",
      );
    } finally {
      await rbacQuery(
        "UPDATE schema_migrations SET checksum=$1 WHERE id='0001-comments'",
        [String(saved.checksum)],
      );
    }
  });
  it("keeps likes at site scope and makes desired state idempotent", async () => {
    const { site, owner } = await fixture();
    expect(await siteLikes(req(owner.cookie), site.slug, true)).toMatchObject({
      count: 1,
      liked: true,
    });
    expect(await siteLikes(req(owner.cookie), site.slug, true)).toMatchObject({
      count: 1,
      liked: true,
    });
    expect(await siteLikes(req(owner.cookie), site.slug, false)).toMatchObject({
      count: 0,
      liked: false,
    });
    const anonymous = await siteLikes(req(), site.slug, true);
    expect(anonymous.cookie).toBeTruthy();
    expect(anonymous.count).toBe(1);
  });
  it("maps malformed/duplicate/oversize requests and caches privately", async () => {
    const { site, owner, input } = await fixture();
    const ctx = {
      params: Promise.resolve({
        slug: site.slug,
        threadId: "",
        messageId: "",
        assetId: "",
      }),
    };
    const first = await POST(req(owner.cookie, input), ctx);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect((await POST(req(owner.cookie, input), ctx)).status).toBe(200);
    expect(
      (
        await POST(
          req(owner.cookie, {
            ...input,
            anchor: { ...input.anchor, filePath: "../secret" },
          }),
          ctx,
        )
      ).status,
    ).toBe(400);
    const query = new Request(
      `${origin}/api/comments?versionId=${site.currentVersionId}&versionId=x`,
      { headers: { cookie: owner.cookie } },
    );
    expect((await GET(query, ctx)).status).toBe(400);
  });
  it("rejects cross-site cookie writes, unknown queries, and streamed oversized bodies", async () => {
    const { site, owner, input } = await fixture();
    const ctx = { params: Promise.resolve({ slug: site.slug }) };
    const cross = new Request(`${origin}/api/comments`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    expect((await POST(cross, ctx)).status).toBe(401);
    const large = new Request(`${origin}/api/comments`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin },
      body: JSON.stringify({ ...input, body: "x".repeat(70_000) }),
    });
    expect((await POST(large, ctx)).status).toBe(413);
    expect(
      (
        await GET(
          new Request(
            `${origin}/api/comments?versionId=${site.currentVersionId}&tracking=1`,
            { headers: { cookie: owner.cookie } },
          ),
          ctx,
        )
      ).status,
    ).toBe(400);
  });
  it("creates exactly one thread for concurrent identical retries", async () => {
    const { site, owner, input } = await fixture();
    const results = await Promise.all([
      createComment(req(owner.cookie), site.slug, input),
      createComment(req(owner.cookie), site.slug, input),
    ]);
    expect(new Set(results.map((r) => r.detail.thread.id)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
  });
  it("applies main policy without granting artifact access and purges discussion rows", async () => {
    const { site, owner, reader, input } = await fixture();
    const { detail } = await createComment(req(owner.cookie), site.slug, input);
    await expect(
      commentSettings(req(reader.cookie), site.slug, { mainPolicy: "off" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await commentSettings(req(owner.cookie), site.slug, { mainPolicy: "off" });
    await expect(
      getCommentDetail(req(reader.cookie), site.slug, detail.thread.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await getCommentDetail(req(owner.cookie), site.slug, detail.thread.id))
        .thread.id,
    ).toBe(detail.thread.id);
    await commentUnread(req(owner.cookie,{}),site.slug,{versionId:site.currentVersionId});
    await rbacQuery("UPDATE sites SET deleted_at=$1 WHERE id=$2", [
      Date.now(),
      site.id,
    ]);
    await setSitePurged(site.id, Date.now());
    expect(await rbacQuery("SELECT * FROM comment_read_scopes WHERE site_id=$1",[site.id])).toEqual([]);
    expect(
      await rbacQuery("SELECT id FROM comment_threads WHERE id=$1", [
        detail.thread.id,
      ]),
    ).toEqual([]);
    expect(
      await rbacQuery(
        "SELECT site_id FROM site_comment_settings WHERE site_id=$1",
        [site.id],
      ),
    ).toEqual([]);
  });
  it("verifies anonymous like cookies and merges the browser like at login", async () => {
    const { site, owner } = await fixture();
    const first = await siteLikes(req(), site.slug, true);
    const browserCookie = first.cookie!.split(";")[0];
    expect((await siteLikes(req(browserCookie), site.slug, true)).count).toBe(
      1,
    );
    const forged = browserCookie.replace(
      /.$/,
      browserCookie.endsWith("0") ? "1" : "0",
    );
    expect((await siteLikes(req(forged), site.slug)).liked).toBe(false);
    expect(
      (await siteLikes(req(`${browserCookie}; ${browserCookie}`), site.slug))
        .liked,
    ).toBe(false);
    await siteLikes(req(owner.cookie), site.slug, true);
    expect(
      await siteLikes(req(`${owner.cookie}; ${browserCookie}`), site.slug),
    ).toMatchObject({ count: 1, liked: true });
    expect(
      (
        await siteLikes(
          req(`${owner.cookie}; ${browserCookie}`),
          site.slug,
          false,
        )
      ).count,
    ).toBe(0);
  });
  it("rejects prototype-shaped unknown query keys", async () => {
    const { site, owner } = await fixture();
    const request = new Request(
      `${origin}/api/comments?versionId=${site.currentVersionId}&__proto__=x`,
      { headers: { cookie: owner.cookie } },
    );
    expect(
      (await GET(request, { params: Promise.resolve({ slug: site.slug }) }))
        .status,
    ).toBe(400);
  });
  it("audits exact thread and message targets without retaining comment text", async () => {
    const { site, owner, input } = await fixture();
    const created = await createComment(req(owner.cookie), site.slug, input);
    const reply = (await replyComment(
      req(owner.cookie),
      site.slug,
      created.detail.thread.id,
      { body: "private reply text", clientRequestId: randomUUID() },
    )) as { id: string };
    const rows = await rbacQuery(
      "SELECT target_id,reason FROM rbac_audit WHERE actor_id=$1 AND action='comment.mutation'",
      [owner.user.id],
    );
    expect(rows.map((r) => r.target_id)).toContain(created.detail.thread.id);
    expect(rows.map((r) => r.target_id)).toContain(reply.id);
    expect(JSON.stringify(rows)).not.toContain(input.body);
    expect(JSON.stringify(rows)).not.toContain("private reply text");
  });
  it("reads only the requested message page after authorizing the thread", async () => {
    const { site, owner, input } = await fixture();
    const { detail } = await createComment(req(owner.cookie), site.slug, input);
    await replyComment(req(owner.cookie), site.slug, detail.thread.id, {
      body: "next",
      clientRequestId: randomUUID(),
    });
    const first = await getMessages(
      req(owner.cookie),
      site.slug,
      detail.thread.id,
      undefined,
      1,
    );
    const query = vi.spyOn(metadata, "rbacQuery");
    try {
      const second = await getMessages(
        req(owner.cookie),
        site.slug,
        detail.thread.id,
        first.nextCursor!,
        1,
      );
      expect(second.items).toHaveLength(1);
      expect(
        query.mock.calls.filter(([sql]) =>
          sql.includes("SELECT m.*,u.display_name"),
        ),
      ).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
  });
  it("rechecks site deletion after the immutable file check and before comment creation", async () => {
    const { site, owner, input } = await fixture();
    const storage = getStorage();
    const sizeOf = storage.sizeOf.bind(storage);
    const check = vi
      .spyOn(storage, "sizeOf")
      .mockImplementation(async (...args) => {
        const value = await sizeOf(...args);
        await metadata.softDeleteSite(site.id);
        return value;
      });
    try {
      await expect(
        createComment(req(owner.cookie), site.slug, input),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(
        await rbacQuery("SELECT id FROM comment_spaces WHERE site_id=$1", [
          site.id,
        ]),
      ).toEqual([]);
    } finally {
      check.mockRestore();
    }
  });
  it.each([undefined, "invalid"])(
    "enforces streamed body size with Content-Length=%s",
    async (length) => {
      const request = new Request(origin, {
        method: "POST",
        headers: length ? { "content-length": length } : {},
        body: "x".repeat(70_000),
      });
      await expect(commentBody(request)).rejects.toMatchObject({
        statusCode: 413,
      });
    },
  );
});

it("reuses scope authorization only within one list call", async () => {
  const { site, owner, reader, input } = await fixture();
  for (let i = 0; i < 3; i++)
    await createComment(req(owner.cookie), site.slug, {
      ...input,
      clientRequestId: randomUUID(),
    });
  const request = req(reader.cookie);
  const spy = vi.spyOn(commentAccess, "resolveCommentAccess");
  try {
    const filter = { kind: "space" as const, scope: input.scope };
    expect((await listComments(request, site.slug, filter)).items).toHaveLength(
      3,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1", [
      site.id,
    ]);
    await expect(
      listComments(request, site.slug, filter),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});
it("memoizes fingerprint secrets per operation without retaining replaced database keys", async () => {
  await rbacTransaction(async (q) => {
    const cache = createFingerprintCache();
    const spy = vi.fn(q);
    const first = await fingerprint(spy, { sample: 1 }, cache);
    const calls = spy.mock.calls.length;
    expect(await fingerprint(spy, { sample: 1 }, cache)).toBe(first);
    expect(spy.mock.calls).toHaveLength(calls);
    await q("UPDATE comment_secrets SET secret=$1 WHERE id='fingerprint'", [
      randomUUID(),
    ]);
    expect(
      await fingerprint(q, { sample: 1 }, createFingerprintCache()),
    ).not.toBe(first);
  });
});

it("reports editor history access separately from share aggregation", async () => {
  const {site, reader, input} = await fixture();
  expect(await getCommentPermissions(req(reader.cookie), site.slug, input.scope)).toMatchObject({canReadVersions:false,canAggregate:false});
  await putUserSiteRole(rbacQuery, site.id, reader.user.id, 'editor', null);
  expect(await getCommentPermissions(req(reader.cookie), site.slug, input.scope)).toMatchObject({canReadVersions:true,canAggregate:false});
});

describe("comment engagement", () => {
  it("counts per-message emoji, makes retries idempotent and rejects deleted/anonymous targets", async () => {
    const {site,owner,reader,input}=await fixture();
    const {detail}=await createComment(req(owner.cookie),site.slug,input);
    const id=detail.messages.items[0].id, thread=detail.thread.id;
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",true);
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",true);
    expect(await setCommentReaction(req(reader.cookie,{}),site.slug,thread,id,"👍",true)).toEqual([{emoji:"👍",count:2,reacted:true}]);
    await setCommentReaction(req(reader.cookie,{}),site.slug,thread,id,"❤️",true);
    expect(await rbacQuery("SELECT target_id FROM rbac_audit WHERE actor_id=$1 AND action='comment.mutation'",[reader.user.id])).toEqual(expect.arrayContaining([{target_id:id}]));
    expect((await getCommentDetail(req(owner.cookie),site.slug,thread)).messages.items[0].reactions).toEqual(expect.arrayContaining([{emoji:"👍",count:2,reacted:true},{emoji:"❤️",count:1,reacted:false}]));
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",false);
    expect(await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",false)).toEqual(expect.arrayContaining([{emoji:"👍",count:1,reacted:false}]));
    await expect(setCommentReaction(req("",{}),site.slug,thread,id,"👍",true)).rejects.toMatchObject({statusCode:401});
    await mutateMessage(req(owner.cookie),site.slug,thread,id,{expectedRevision:1},"delete");
    await expect(setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",true)).rejects.toMatchObject({statusCode:404});
    expect((await getCommentDetail(req(owner.cookie),site.slug,thread)).messages.items[0].reactions).toEqual([]);
  });
  it("supports full Unicode reactions without duplicates", async () => {
    const {site,owner,input}=await fixture();
    const {detail}=await createComment(req(owner.cookie),site.slug,input);
    const id=detail.messages.items[0].id, thread=detail.thread.id;
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍",true);
    for (const emoji of ["🦦","👩🏽‍💻","🇨🇳","👨‍👩‍👧‍👦","1️⃣"]) {
      await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,emoji,true);
      await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,emoji,true);
    }
    const reactions=(await getCommentDetail(req(owner.cookie),site.slug,thread)).messages.items[0].reactions!;
    expect(reactions).toHaveLength(6);
    expect(reactions.every(reaction=>reaction.count===1 && reaction.reacted)).toBe(true);
    expect(reactions).toContainEqual({emoji:"👍",count:1,reacted:true});
    await expect(setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👍👍",true)).rejects.toMatchObject({statusCode:400});
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"👩🏽‍💻",false);
    expect((await getCommentDetail(req(owner.cookie),site.slug,thread)).messages.items[0].reactions).toHaveLength(5);
  });
  it("canonicalizes reaction buckets and enforces a per-author cap", async()=>{
    const {site,owner,input}=await fixture();
    const {detail}=await createComment(req(owner.cookie),site.slug,input);
    const id=detail.messages.items[0].id, thread=detail.thread.id;
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"❤",true);
    expect(await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"❤️",true)).toEqual([{emoji:"❤️",count:1,reacted:true}]);
    for(const emoji of ["👍","🎉","👀","🙏","😄","🦦","🐱","🐶","🐸","🌈","🚀"]) await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,emoji,true);
    await expect(setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"🍎",true)).rejects.toMatchObject({statusCode:409});
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"❤",false);
    await setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"🍎",true);
    await expect(setCommentReaction(req(owner.cookie,{}),site.slug,thread,id,"🏻",true)).rejects.toMatchObject({statusCode:400});
  });
  it("reads unread progress without the write lock or a baseline write",async()=>{
    const {site,owner}=await fixture();
    const transaction=vi.spyOn(metadata,"rbacTransaction");
    try {
      const result=await commentUnread(req(owner.cookie),site.slug,{versionId:site.currentVersionId});
      expect(result.initialized).toBe(false);
      expect(transaction).not.toHaveBeenCalled();
      expect(await rbacQuery("SELECT * FROM comment_read_scopes WHERE site_id=$1",[site.id])).toEqual([]);
    } finally {transaction.mockRestore();}
  });
  it("limits progress independently of the reply bucket",async()=>{
    const {site,owner}=await fixture();
    const {checkRateLimit,__resetRateLimitForTests}=await import("@/lib/ratelimit");
    __resetRateLimitForTests();
    vi.stubEnv("ARTIFACT_RATE_LIMIT","on");
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now());
    try {
      const scope={versionId:site.currentVersionId};
      for(let i=0;i<60;i++) await commentUnread(req(owner.cookie),site.slug,scope);
      await expect(commentUnread(req(owner.cookie),site.slug,scope)).rejects.toMatchObject({statusCode:429});
      expect(()=>checkRateLimit(req(owner.cookie,{}))).not.toThrow();
      await commentUnread(req(owner.cookie,{}),site.slug,scope);
    } finally {clock.mockRestore();vi.unstubAllEnvs();__resetRateLimitForTests();}
  });
  it("baselines history, excludes own messages and acknowledges only viewed messages", async () => {
    const {site,owner,reader,input}=await fixture();
    const {detail}=await createComment(req(owner.cookie),site.slug,input);
    const scope={versionId:site.currentVersionId,aggregate:true};
    expect((await commentUnread(req(owner.cookie),site.slug,scope)).messages).toEqual([]);
    expect(await rbacQuery("SELECT * FROM comment_read_scopes WHERE site_id=$1",[site.id])).toEqual([]);
    await commentUnread(req(owner.cookie,{}),site.slug,scope);
    // An explicit clock separation also covers databases with millisecond timestamps.
    await new Promise(resolve=>setTimeout(resolve,5));
    const first=await replyComment(req(reader.cookie),site.slug,detail.thread.id,{body:"first",clientRequestId:randomUUID()}) as {id:string};
    const second=await replyComment(req(reader.cookie),site.slug,detail.thread.id,{body:"second",clientRequestId:randomUUID()}) as {id:string};
    await replyComment(req(owner.cookie),site.slug,detail.thread.id,{body:"my reply",clientRequestId:randomUUID()});
    const unread=await commentUnread(req(owner.cookie),site.slug,scope);
    expect(unread.messages.map(m=>m.id).sort()).toEqual([first.id,second.id].sort());
    expect((await listComments(req(owner.cookie),site.slug,{kind:"aggregate",siteId:site.id,unread:true})).items.map(item=>item.thread.id)).toEqual([detail.thread.id]);
    const remaining=await commentUnread(req(owner.cookie,{}),site.slug,{...scope,messageIds:[first.id]});
    expect(remaining.messages.map(m=>m.id)).toEqual([second.id]);
    expect((await commentUnread(req(owner.cookie),site.slug,scope)).messages.map(m=>m.id)).toEqual([second.id]);
    expect((await commentUnread(req(owner.cookie,{}),site.slug,{...scope,through:remaining.snapshotAt})).messages).toEqual([]);
    expect((await listComments(req(owner.cookie),site.slug,{kind:"aggregate",siteId:site.id,unread:true})).items).toEqual([]);
    expect(await rbacQuery("SELECT * FROM comment_read_messages WHERE user_id=$1",[owner.user.id])).toEqual([]);
    await expect(commentUnread(req(reader.cookie),site.slug,scope)).rejects.toMatchObject({statusCode:404});
  });
  it("isolates reactions and reading receipts between share links and rechecks revocation", async () => {
    const {site,owner,reader,input}=await fixture();
    const tokens=[createId("token"),createId("token")];
    const shares=[];
    for(const token of tokens) shares.push(await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),policy:"public",passcodeHash:null,label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null,mode:"comment",versionId:null}));
    const scope={...input.scope,entry:{kind:"share" as const,shareId:shares[0].id}};
    const {detail}=await createComment(req(reader.cookie,undefined,tokens[0]),site.slug,{...input,scope});
    const read={versionId:site.currentVersionId,shareId:shares[0].id};
    await commentUnread(req(owner.cookie,{},tokens[0]),site.slug,read);
    await new Promise(resolve=>setTimeout(resolve,5));
    const reply=await replyComment(req(reader.cookie,undefined,tokens[0]),site.slug,detail.thread.id,{body:"Unread on first link",clientRequestId:randomUUID()}) as {id:string};
    await expect(setCommentReaction(req(reader.cookie,{},tokens[1]),site.slug,detail.thread.id,reply.id,"👀",true)).rejects.toMatchObject({statusCode:404});
    await expect(commentUnread(req(reader.cookie,undefined,tokens[1]),site.slug,read)).rejects.toMatchObject({statusCode:404});
    const otherRead={...read,shareId:shares[1].id};
    await commentUnread(req(owner.cookie,{},tokens[1]),site.slug,{...otherRead,messageIds:[reply.id]});
    expect((await commentUnread(req(owner.cookie,undefined,tokens[0]),site.slug,read)).messages.map(m=>m.id)).toEqual([reply.id]);
    await setCommentReaction(req(reader.cookie,{},tokens[0]),site.slug,detail.thread.id,reply.id,"👀",true);
    expect((await getCommentDetail(req("",undefined,tokens[0]),site.slug,detail.thread.id)).messages.items.find(m=>m.id===reply.id)?.reactions).toEqual([{emoji:"👀",count:1,reacted:false}]);
    await revokeShare(shares[0].id);
    await expect(setCommentReaction(req(reader.cookie,{},tokens[0]),site.slug,detail.thread.id,reply.id,"👍",true)).rejects.toMatchObject({statusCode:404});
    await expect(commentUnread(req(reader.cookie,undefined,tokens[0]),site.slug,read)).rejects.toMatchObject({statusCode:404});
  });

});

it("projects Agent summaries without widening share access or acknowledging unread", async () => {
  const { listAgentComments, agentCommentListSchema } = await import("@/lib/comments/agent-list");
  const { site, owner, reader, input } = await fixture();
  const token = randomUUID();
  const share = await createShare({ id: createId("shr"), siteId: site.id, tokenHash: hashToken(token), policy: "public", passcodeHash: null, label: null, createdBy: owner.user.id, createdAnonId: null, expiresAt: null, mode: "comment", versionId: site.currentVersionId });
  const created = await createComment(req(reader.cookie, undefined, token), site.slug, {
    ...input, scope: { ...input.scope, entry: { kind: "share", shareId: share.id } }, body: "a".repeat(499) + "😀" + "tail",
  });
  const query = agentCommentListSchema.parse({});
  const result = await listAgentComments(req(reader.cookie, undefined, token), site.slug, query);
  expect(result.scope.versionId).toBe(site.currentVersionId);
  const { agentThread } = await import("@/lib/comments/agent-context");
  const detail = created.detail;
  detail.thread.context.excerpt = "a".repeat(1999) + "😀tail";
  expect(agentThread(detail).thread.context.excerpt).toBe("a".repeat(1999) + "😀");
  expect(result.items[0]).toMatchObject({ threadId: created.detail.thread.id, summaryTruncated: true, summary: "a".repeat(499) + "😀" });
  expect((await listAgentComments(req(owner.cookie), site.slug, query)).items).toHaveLength(0);
  expect((await listAgentComments(req(owner.cookie), site.slug, { ...query, aggregate: "true", allVersions: "true" })).items).toHaveLength(1);
  await expect(listAgentComments(req(reader.cookie), site.slug, { ...query, aggregate: "true" })).rejects.toBeTruthy();
  await expect(listAgentComments(req(owner.cookie, undefined, token), site.slug, { ...query, aggregate: "true" })).rejects.toMatchObject({ statusCode: 404 });
  await expect(listAgentComments(req(owner.cookie), site.slug, { ...query, shareId: share.id })).rejects.toMatchObject({ statusCode: 400 });
  expect(agentCommentListSchema.safeParse({ allVersions: "true" }).success).toBe(false);
  expect(await rbacQuery("SELECT * FROM comment_read_scopes WHERE site_id=$1", [site.id])).toHaveLength(0);
  await revokeShare(share.id);
  await expect(listAgentComments(req(owner.cookie, undefined, token), site.slug, query)).rejects.toMatchObject({ statusCode: 404 });
});

it("keeps Agent aggregate share filters scoped to the authorized site", async () => {
  const { listAgentComments, agentCommentListSchema } = await import("@/lib/comments/agent-list");
  const local = await fixture();
  const foreign = await fixture();
  const token = randomUUID();
  const share = await createShare({ id: createId("shr"), siteId: foreign.site.id, tokenHash: hashToken(token), policy: "public", passcodeHash: null, label: null, createdBy: foreign.owner.user.id, createdAnonId: null, expiresAt: null, mode: "comment", versionId: foreign.site.currentVersionId });
  const { detail } = await createComment(req(foreign.owner.cookie, undefined, token), foreign.site.slug, {
    ...foreign.input, scope: { ...foreign.input.scope, entry: { kind: "share", shareId: share.id } }, body: "Foreign site feedback",
  });
  const query = agentCommentListSchema.parse({ aggregate: "true", allVersions: "true", shareId: share.id });
  const authorized = await listAgentComments(req(foreign.owner.cookie), foreign.site.slug, query);
  expect(authorized.items.map(item => item.threadId)).toEqual([detail.thread.id]);
  const isolated = await listAgentComments(req(local.owner.cookie), local.site.slug, query);
  expect(isolated.items).toEqual([]);
  expect(isolated.nextCursor).toBeNull();
  expect(isolated.hasMore).toBe(false);
  await expect(listAgentComments(req(local.owner.cookie), foreign.site.slug, query)).rejects.toMatchObject({ statusCode: 404 });
});

it("offers only version-safe live share destinations without exposing tokens", async () => {
  const {site,owner,reader,input}=await fixture();
  const ids:string[]=[];
  for(const [label,mode,expiresAt] of [["live","comment",null],["expired","comment",Date.now()-1000],["read-only","view",null]] as const) {
    const id=createId("share");ids.push(id);
    await createShare({id,siteId:site.id,tokenHash:hashToken("private-"+id),token:"private-"+id,policy:"public",mode,passcodeHash:null,label,createdBy:owner.user.id,createdAnonId:null,expiresAt,versionId:null});
  }
  const context={params:Promise.resolve({slug:site.slug})};
  const response=await commentOptions(new Request(`${origin}/api/sites/${site.slug}/comments/options`,{headers:{cookie:owner.cookie}}),context);
  expect(response.status).toBe(200);
  const options=await response.json();
  expect(options.shares).toEqual(expect.arrayContaining([
    expect.objectContaining({id:ids[0],active:true,mode:"comment",versionIds:[site.currentVersionId]}),
    expect.objectContaining({id:ids[1],active:false}),
    expect.objectContaining({id:ids[2],mode:"view"}),
  ]));
  expect(JSON.stringify(options)).not.toContain("tokenHash");
  expect(JSON.stringify(options)).not.toContain("private-");
  expect(options.shares.find((s: {id:string})=>s.id===ids[0])).toMatchObject({id:ids[0],createdAt:expect.any(Number)});
  expect((await commentOptions(new Request(`${origin}/api/sites/${site.slug}/comments/options`,{headers:{cookie:reader.cookie}}),context)).status).toBe(404);
  // Options are advisory: revocation between choosing and sending is rechecked by the write.
  await revokeShare(ids[0]);
  await expect(createComment(req(owner.cookie),site.slug,{...input,scope:{...input.scope,entry:{kind:"share",shareId:ids[0]}}})).rejects.toThrow();
});


describe("comment discovery and result associations", () => {
  it("searches replies literally and binds search/participation to cursors", async () => {
    const {site,owner,reader,input}=await fixture();
    const first=await createComment(req(owner.cookie),site.slug,input);
    const second=await createComment(req(owner.cookie),site.slug,{...input,clientRequestId:randomUUID(),body:"Another root"});
    for(const thread of [first,second]) await replyComment(req(reader.cookie),site.slug,thread.detail.thread.id,{body:"Precise 50%_finding",clientRequestId:randomUUID()});
    const filter={kind:"space" as const,scope:input.scope,q:"50%_",participated:true,limit:1};
    const page=await listComments(req(reader.cookie),site.slug,filter);
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTruthy();
    await expect(listComments(req(reader.cookie),site.slug,{...filter,q:"different",cursor:page.nextCursor!})).rejects.toMatchObject({statusCode:400});
    expect((await listComments(req(reader.cookie),site.slug,{...filter,q:"50%X"})).items).toHaveLength(0);
    expect((await listComments(req(owner.cookie),site.slug,{...filter,limit:30})).items).toHaveLength(2);
    await expect(listComments(req(),site.slug,filter)).rejects.toBeDefined();
  });
  it("isolates search across share links and omits deleted text", async () => {
    const {site,owner,reader,input}=await fixture();
    const tokens=[createId("token"),createId("token")];
    const shares=[];
    for(const token of tokens) shares.push(await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),policy:"public",passcodeHash:null,label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null,mode:"comment",versionId:null}));
    const a={...input.scope,entry:{kind:"share" as const,shareId:shares[0].id}};
    const b={...input.scope,entry:{kind:"share" as const,shareId:shares[1].id}};
    const created=await createComment(req(owner.cookie,undefined,tokens[0]),site.slug,{...input,scope:a,body:"secret phrase"});
    expect((await listComments(req(reader.cookie,undefined,tokens[1]),site.slug,{kind:"space",scope:b,q:"secret"})).items).toHaveLength(0);
    await expect(listComments(req(reader.cookie,undefined,tokens[1]),site.slug,{kind:"space",scope:a,q:"secret"})).rejects.toBeDefined();
    expect((await listComments(req(owner.cookie),site.slug,{kind:"aggregate",siteId:site.id,q:"secret"})).items).toHaveLength(1);
    const message=created.detail.messages.items[0];
    await mutateMessage(req(owner.cookie),site.slug,created.detail.thread.id,message.id,{expectedRevision:message.revision},"delete");
    expect((await listComments(req(owner.cookie),site.slug,{kind:"aggregate",siteId:site.id,q:"secret"})).items).toHaveLength(0);
  });
  it("associates editorial results with revision control and audit without resolving or moving", async () => {
    const {site,owner,reader,input}=await fixture();
    const created=await createComment(req(owner.cookie),site.slug,input);
    const id=created.detail.thread.id;
    await expect(associateCommentResult(req(reader.cookie,{}),site.slug,id,{expectedRevision:1,versionId:site.currentVersionId})).rejects.toMatchObject({statusCode:403});
    const foreign=await fixture();
    await expect(associateCommentResult(req(owner.cookie,{}),site.slug,id,{expectedRevision:1,versionId:foreign.site.currentVersionId})).rejects.toMatchObject({statusCode:404});
    await associateCommentResult(req(owner.cookie,{}),site.slug,id,{expectedRevision:1,versionId:site.currentVersionId});
    const current=await getCommentDetail(req(owner.cookie),site.slug,id);
    expect(current.space).toEqual(created.detail.space);
    expect(current.thread.resolution.status).toBe("open");
    expect(current.thread.resultVersionId).toBe(site.currentVersionId);
    expect(current.thread.resultAssociation).toMatchObject({userId:owner.user.id,actorKind:"user"});
    expect((await getAgentContext(req(owner.cookie),site.slug,id)).threads[0].thread.resultAssociation).toEqual(current.thread.resultAssociation);
    expect((await commentResultOptions(req(owner.cookie),site.slug,id)).versions).toHaveLength(1);
    await expect(associateCommentResult(req(owner.cookie,{}),site.slug,id,{expectedRevision:1,versionId:null})).rejects.toMatchObject({statusCode:409});
    const audit=await rbacQuery("SELECT * FROM rbac_audit WHERE action='comment.result.associate' AND target_id=$1",[id]);
    expect(audit).toHaveLength(1);expect(audit[0].actor_id).toBe(owner.user.id);
    await associateCommentResult(req(owner.cookie,{}),site.slug,id,{expectedRevision:current.thread.revision,versionId:null});
    expect((await getCommentDetail(req(owner.cookie),site.slug,id)).thread.resultVersionId).toBeNull();
  });
});

it("redacts inaccessible result versions and permits live edit-link editorial actions", async () => {
  const {site,owner,reader,input}=await fixture();
  await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1",[site.id]);
  const fixedToken=createId("fixed"), editToken=createId("edit");
  const fixed=await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(fixedToken),policy:"public",mode:"comment",passcodeHash:null,label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null,versionId:site.currentVersionId});
  const created=await createComment(req(reader.cookie,undefined,fixedToken),site.slug,{...input,scope:{...input.scope,entry:{kind:"share",shareId:fixed.id}}});
  const replacement=await replaceSiteContent(site.slug,{mode:"paste",html:"<h1>Updated result</h1>"},testAudit());
  if(!replacement || "conflict" in replacement) throw new Error("Fixture version failed");
  await associateCommentResult(req(owner.cookie,{}),site.slug,created.detail.thread.id,{expectedRevision:1,versionId:replacement.site.currentVersionId});
  const hidden=await getCommentDetail(req(reader.cookie,undefined,fixedToken),site.slug,created.detail.thread.id);
  expect(hidden.thread.resultVersionId).toBeNull();expect(hidden.thread.resultAssociation).toBeNull();expect(hidden.thread.resultVersionNumber).toBeUndefined();
  let revision=hidden.thread.revision;
  for (const status of ["resolved", "open"] as const) {
    const request=new Request(`${origin}/api/sites/${site.slug}/comments/${created.detail.thread.id}/status`,{method:"PATCH",headers:{cookie:reader.cookie,origin,"content-type":"application/json","x-artifact-share":fixedToken},body:JSON.stringify({expectedRevision:revision,status})});
    const response=await updateCommentStatus(request,{params:Promise.resolve({slug:site.slug,threadId:created.detail.thread.id})});
    expect(response.status).toBe(200);
    const thread=await response.json();
    expect(thread.resultVersionId).toBeNull();expect(thread.resultAssociation).toBeNull();expect(thread.resultVersionNumber).toBeUndefined();
    expect(JSON.stringify(thread)).not.toContain(replacement.site.currentVersionId);
    expect(thread.resolution.status).toBe(status);expect(thread.revision).toBe(++revision);
  }
  const edit=await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(editToken),policy:"public",mode:"edit",passcodeHash:null,label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null,versionId:null});
  const editable=await createComment(req(reader.cookie,undefined,editToken),site.slug,{...input,clientRequestId:randomUUID(),scope:{...input.scope,versionId:replacement.site.currentVersionId,entry:{kind:"share",shareId:edit.id}}});
  expect(editable.detail.permissions.canAssociateResult).toBe(true);
  await associateCommentResult(req(reader.cookie,{},editToken),site.slug,editable.detail.thread.id,{expectedRevision:1,versionId:replacement.site.currentVersionId});
  const options=await commentResultOptions(req(reader.cookie,undefined,editToken),site.slug,editable.detail.thread.id);
  expect(options.versions).toEqual([{id:replacement.site.currentVersionId,createdAt:replacement.version.createdAt,number:2}]);
});

it("loads result ordinals once per list and lazily for standalone readable results", async () => {
  const {site,owner,input}=await fixture();
  const created=[];
  for(let index=0;index<3;index++) created.push(await createComment(req(owner.cookie),site.slug,{...input,clientRequestId:randomUUID()}));
  const versions=vi.spyOn(metadata,"listVersions");
  try {
    await listComments(req(owner.cookie),site.slug,{kind:"space",scope:input.scope});
    expect(versions).not.toHaveBeenCalled();
    for(const item of created) await associateCommentResult(req(owner.cookie,{}),site.slug,item.detail.thread.id,{expectedRevision:1,versionId:site.currentVersionId});
    versions.mockClear();
    const editGate=vi.spyOn(authorization,"requirePermission");
    const readGate=vi.spyOn(shareAccess,"readableVersionFilter");
    const page=await listComments(req(owner.cookie),site.slug,{kind:"space",scope:input.scope});
    expect(editGate).toHaveBeenCalledTimes(1);
    expect(readGate).toHaveBeenCalledTimes(1);
    editGate.mockRestore(); readGate.mockRestore();
    expect(page.items).toHaveLength(3);
    expect(page.items.every(item=>item.thread.resultVersionNumber===1)).toBe(true);
    expect(versions).toHaveBeenCalledTimes(1);
    versions.mockClear();
    expect((await getCommentDetail(req(owner.cookie),site.slug,created[0].detail.thread.id)).thread.resultVersionNumber).toBe(1);
    expect(versions).toHaveBeenCalledTimes(1);
  } finally {versions.mockRestore();}
});

it("retains historical participation after deleting one's message", async () => {
  const {site,owner,reader,input}=await fixture();
  const root=await createComment(req(owner.cookie),site.slug,input);
  await replyComment(req(reader.cookie),site.slug,root.detail.thread.id,{body:"A historical contribution",clientRequestId:randomUUID()});
  const reply=(await getCommentDetail(req(reader.cookie),site.slug,root.detail.thread.id)).messages.items.find(message=>message.authorUserId===reader.user.id)!;
  await mutateMessage(req(reader.cookie),site.slug,root.detail.thread.id,reply.id,{expectedRevision:reply.revision},"delete");
  expect((await listComments(req(reader.cookie),site.slug,{kind:"space",scope:input.scope,participated:true})).items.map(item=>item.thread.id)).toEqual([root.detail.thread.id]);
  expect((await listComments(req(reader.cookie),site.slug,{kind:"space",scope:input.scope,q:"historical"})).items).toHaveLength(0);
});

it("filters aggregate version choices by effective history permission without renumbering", async () => {
  const {site,owner}=await fixture();
  const updated=await replaceSiteContent(site.slug,{mode:"paste",html:"<h1>Latest visible</h1>"},testAudit());
  if(!updated || "conflict" in updated) throw new Error("Fixture version failed");
  await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(createId("token")),policy:"public",mode:"comment",passcodeHash:null,label:null,createdBy:owner.user.id,createdAnonId:null,expiresAt:null,versionId:site.currentVersionId});
  await rbacQuery("DELETE FROM role_permissions WHERE role_id='owner' AND permission_code='site.history.read'");
  try {
    const response=await commentOptions(req(owner.cookie),{params:Promise.resolve({slug:site.slug})});
    expect(response.status).toBe(200);
    const options=await response.json();
    expect(options.versions).toEqual([expect.objectContaining({id:updated.site.currentVersionId,number:2})]);
    expect(options.shares[0].versionIds).toEqual([]);
    expect(JSON.stringify(options)).not.toContain(site.currentVersionId);
  } finally { await rbacQuery("INSERT INTO role_permissions(role_id,permission_code) VALUES('owner','site.history.read') ON CONFLICT DO NOTHING"); }
});
