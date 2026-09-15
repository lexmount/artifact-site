import { describe, expect, it } from "vitest";
import { commentAggregateQuerySchema, commentListQuerySchema, commentPaginationSchema, createCommentSchema, editCommentSchema, previewCommentEventSchema } from "@/lib/comments/contracts";
import { parseCreateComment } from "@/lib/comments/validation";
import { canActOnComment, describeCommentPermissions, sameCommentScope, type CommentAccessFacts } from "@/lib/comments/permissions";

const scope = { siteId: "s1", versionId: "v1", entry: { kind: "main" as const } };
const input = { scope, clientRequestId: "39dd477b-3025-4e3b-8fe9-61d0162950e5", anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" }, body: " Review this " };
const facts: CommentAccessFacts = { scope, userId: "u1", canReadArtifact: true, canReadMainArtifact: true, canWriteArtifactDiscussion: true, accountRole: null, managementRole: null, mainPolicy: "login", shareMode: null };
const shareScope = { ...scope, entry: { kind: "share" as const, shareId: "sh1" } };

describe("comment input and preview contracts", () => {
  it("shares list query validation and rejects ambiguous filters/coercions", () => {
    expect(commentListQuerySchema.parse({ versionId: "v1", limit: "10" }).limit).toBe(10);
    expect(commentListQuerySchema.safeParse({}).success).toBe(false);
    expect(commentAggregateQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(commentAggregateQuerySchema.safeParse({ shareId: "sh1", entry: "main" }).success).toBe(false);
    for (const limit of ["", null, true, "1.5", "1e2", "101"]) expect(commentPaginationSchema.safeParse({ limit }).success).toBe(false);
    expect(commentListQuerySchema.safeParse({ versionId: "v1", status: "other" }).success).toBe(false);
  });
  it("bounds pagination and defaults to a small response", () => {
    expect(commentPaginationSchema.parse({})).toEqual({ limit: 30 });
    for (const value of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "x".repeat(2049) }]) {
      expect(commentPaginationSchema.safeParse(value).success).toBe(false);
    }
  });
  it("accepts whole-document feedback and normalizes paths through the storage guard", () => {
    expect(parseCreateComment({ ...input, anchor: { ...input.anchor, filePath: "./nested\\index.html" } })).toMatchObject({ body: "Review this", anchor: { filePath: "nested/index.html" } });
  });
  it.each(["../secret", "/secret", "a/../../secret", "a\u0000b", ".git/config", "node_modules/a", "a//b", "x".repeat(256)])("rejects unsafe path %j", filePath => {
    expect(() => parseCreateComment({ ...input, anchor: { ...input.anchor, filePath } })).toThrow();
  });
  it("rejects credential/author injection, blank or oversized bodies and missing exact versions", () => {
    for (const value of [
      { ...input, authorUserId: "other" }, { ...input, token: "secret" },
      { ...input, body: "  " }, { ...input, body: "a".repeat(10_001) },
      { ...input, scope: { ...scope, versionId: "" } },
      { ...input, clientRequestId: "not-a-uuid" },
      { ...input, context: { html: "<script>" } },
    ]) expect(createCommentSchema.safeParse(value).success).toBe(false);
    expect(editCommentSchema.safeParse({ body: "ok", expectedRevision: 0 }).success).toBe(false);
  });
  it("supports HTML, image and PDF coordinates while rejecting invalid bounds", () => {
    const anchors = [
      { kind: "html", selector: "#summary", viewport: { width: 1280, height: 720 }, quote: { exact: "Summary" } },
      { kind: "image", region: { kind: "point", point: { x: 0, y: 1 } } },
      { kind: "pdf", page: 1, region: { kind: "rect", rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } } },
    ];
    for (const anchor of anchors) expect(parseCreateComment({ ...input, anchor: { schemaVersion: 1, filePath: "file", ...anchor } }).anchor.kind).toBe(anchor.kind);
    for (const rect of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0.9, y: 0, width: 0.2, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
      expect(createCommentSchema.safeParse({ ...input, anchor: { kind: "pdf", schemaVersion: 1, filePath: "a.pdf", page: 1, region: { kind: "rect", rect } } }).success).toBe(false);
    }
    expect(createCommentSchema.safeParse({ ...input, anchor: { ...anchors[2], schemaVersion: 1, filePath: "a.pdf", page: 0 } }).success).toBe(false);
  });
  it("rejects unsupported preview protocols, versions and payloads", () => {
    const event = { protocol: "artifact-comments", schemaVersion: 1, channelId: input.clientRequestId, scope, event: { type: "selected", anchor: input.anchor } };
    expect(previewCommentEventSchema.parse(event).event.type).toBe("selected");
    for (const invalid of [{ ...event, schemaVersion: 2 }, { ...event, protocol: "other" }, { ...event, event: { type: "selected", anchor: input.anchor, body: "injected" } }]) expect(() => previewCommentEventSchema.parse(invalid)).toThrow();
    expect(previewCommentEventSchema.safeParse({ ...event, event: { type: "located", threadId: "t1", outcome: "missing" } }).success).toBe(true);
  });
});

describe("comment authorization boundaries", () => {
  it.each(["view", "comment", "edit"] as const)("denies share-only %s readers access to main", shareMode => {
    expect(describeCommentPermissions({ ...facts, shareMode, canReadMainArtifact: false })).toMatchObject({ canRead: false, canCreate: false });
    expect(describeCommentPermissions({ ...facts, shareMode }).canRead).toBe(true);
  });
  it.each([null, "view"] as const)("keeps manager inspection of %s shares separate from authoring", shareMode => {
    const manager = { ...facts, scope: shareScope, accountRole: "owner" as const, shareMode };
    expect(describeCommentPermissions(manager)).toMatchObject({ canRead: true, canCreate: false, canReply: false, canModerate: true, canResolveAny: true });
    const target = { scope: shareScope, threadCreatorId: "other", messageAuthorId: "other" };
    expect(canActOnComment(manager, "delete", target)).toBe(true);
    expect(canActOnComment(manager, "resolve", target)).toBe(true);
    expect(canActOnComment(manager, "edit", { ...target, messageAuthorId: "u1" })).toBe(false);
  });
  it.each(["platform-admin", "tenant-admin"] as const)("supports explicit %s governance but honors resource denial", managementRole => {
    expect(describeCommentPermissions({ ...facts, managementRole })).toMatchObject({ canAggregate: true, canModerate: true });
    const denied = describeCommentPermissions({ ...facts, managementRole, canReadArtifact: false });
    expect(Object.values(denied).every(value => value === false)).toBe(true);
  });
  it("requires an identity even for anonymous owners and operator credentials", () => {
    for (const overrides of [{ accountRole: "owner" as const }, { managementRole: "platform-admin" as const }, { scope: shareScope, shareMode: "edit" as const }]) {
      const anonymous = { ...facts, ...overrides, userId: null };
      expect(describeCommentPermissions(anonymous)).toMatchObject({ canCreate: false, canReply: false, canModerate: false, canResolveAny: false });
      expect(canActOnComment(anonymous, "resolve", { scope: anonymous.scope, threadCreatorId: "u1" })).toBe(false);
    }
  });
  it.each(["comment", "edit"] as const)("lets anonymous %s share readers read but never write", shareMode => {
    expect(describeCommentPermissions({ ...facts, scope: shareScope, shareMode, userId: null })).toMatchObject({ canRead: true, canCreate: false, canAggregate: false });
  });
  it("login and membership never upgrade a view share or a missing/revoked grant", () => {
    for (const shareMode of [null, "view"] as const) {
      expect(describeCommentPermissions({ ...facts, scope: shareScope, shareMode, accountRole: "editor" })).toMatchObject({ canRead: false, canCreate: false });
    }
  });
  it("separates main policy from underlying artifact access", () => {
    expect(describeCommentPermissions(facts).canCreate).toBe(true);
    for (const overrides of [{ userId: null }, { mainPolicy: "off" as const }, { mainPolicy: "members" as const }, { canReadArtifact: false, accountRole: "owner" as const }]) {
      expect(describeCommentPermissions({ ...facts, ...overrides }).canRead).toBe(false);
    }
    expect(describeCommentPermissions({ ...facts, accountRole: "editor", mainPolicy: "members" }).canCreate).toBe(true);
  });
  it("grants management aggregation but no cross-site or cross-space target actions", () => {
    const manager = { ...facts, accountRole: "owner" as const, scope: shareScope, shareMode: null };
    expect(describeCommentPermissions(manager)).toMatchObject({ canRead: true, canAggregate: true, canManageSettings: true });
    for (const targetScope of [scope, { ...shareScope, siteId: "s2" }, { ...shareScope, versionId: "v2" }, { ...shareScope, entry: { kind: "share" as const, shareId: "sh2" } }]) {
      expect(sameCommentScope(shareScope, targetScope)).toBe(false);
      expect(canActOnComment(manager, "delete", { scope: targetScope, threadCreatorId: "u1", messageAuthorId: "u2" })).toBe(false);
    }
  });
  it("only permanent editors resolve others' visible threads", () => {
    const temporary = { ...facts, scope: shareScope, shareMode: "edit" as const };
    const target = { scope: shareScope, threadCreatorId: "u2" };
    expect(canActOnComment(temporary, "resolve", target)).toBe(false);
    expect(canActOnComment(temporary, "reopen", { ...target, threadCreatorId: "u1" })).toBe(true);
    expect(canActOnComment({ ...temporary, accountRole: "editor" }, "resolve", target)).toBe(true);
    expect(describeCommentPermissions({ ...temporary, accountRole: "editor" }).canAggregate).toBe(false);
  });
  it("allows own edits, moderator deletions and blocks tombstone edits", () => {
    const target = { scope, threadCreatorId: "u2", messageAuthorId: "u2" };
    expect(canActOnComment(facts, "edit", target)).toBe(false);
    expect(canActOnComment(facts, "delete", target)).toBe(false);
    expect(canActOnComment(facts, "edit", { ...target, messageAuthorId: "u1" })).toBe(true);
    const manager = { ...facts, accountRole: "site-admin" as const };
    expect(canActOnComment(manager, "edit", target)).toBe(false);
    expect(canActOnComment(manager, "delete", target)).toBe(true);
    expect(canActOnComment(manager, "delete", { ...target, messageDeleted: true })).toBe(false);
    expect(canActOnComment({ ...facts, canWriteArtifactDiscussion: false }, "edit", { ...target, messageAuthorId: "u1" })).toBe(false);
  });
});
