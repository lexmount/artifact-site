import { describe, it, expect } from "vitest";
import {
  canRecoverCommentDraft,
  draftBucket,
  draftIdentity,
  writeDrafts,
  readDrafts,
  type CommentDraft,
} from "@/components/comments/comment-drafts";
function saveDraft(storage: Storage, bucket: string, draft: CommentDraft) {
  writeDrafts(storage, bucket, { ...readDrafts(storage, bucket), [draftIdentity(draft)]: draft });
}
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
  } as unknown as Storage;
}
const draft: CommentDraft = {
  kind: "reply",
  body: "Keep this",
  requestId: "dc41869c-e1dd-46a2-93e1-7c58217737ae",
  scope: { siteId: "s", versionId: "v", entry: { kind: "main" } },
  threadId: "t",
  updatedAt: Date.now(),
};
describe("comment drafts", () => {
  it("survives reload without leaking to another account or thread", () => {
    const s = storage(),
      key = draftBucket("u", "s");
    saveDraft(s, key, draft);
    expect(readDrafts(s, key)[draftIdentity(draft)].requestId).toBe("dc41869c-e1dd-46a2-93e1-7c58217737ae");
    expect(readDrafts(s, draftBucket("other", "s"))).toEqual({});
    saveDraft(s, key, { ...draft, threadId: "other" });
    saveDraft(s, key, { ...draft, body: "" });
    expect(Object.values(readDrafts(s, key))).toHaveLength(1);
  });
  it("expires old drafts and tolerates broken storage", () => {
    const s = storage(),
      key = "test";
    saveDraft(s, key, { ...draft, updatedAt: 0 });
    expect(readDrafts(s, key)).toEqual({});
    s.setItem(key, "bad");
    expect(readDrafts(s, key)).toEqual({});
  });
  it("normalizes thread-space metadata and isolates versions and share discussions", () => {
    const s = storage(),
      key = draftBucket("u", "s");
    const space = { ...draft.scope, id: "space", createdAt: Date.now() };
    saveDraft(s, key, { ...draft, scope: space });
    saveDraft(s, key, { ...draft, scope: { ...draft.scope, versionId: "old" } });
    saveDraft(s, key, { ...draft, scope: { ...draft.scope, entry: { kind: "share", shareId: "share" } } });
    const saved = Object.values(readDrafts(s, key));
    expect(saved).toHaveLength(3);
    expect(saved[0].scope).not.toHaveProperty("createdAt");
  });
  it("rejects mismatched identities, malformed scopes and future timestamps", () => {
    const s = storage(),
      key = "test",
      id = draftIdentity(draft);
    for (const value of [
      { wrong: draft },
      { [id]: { ...draft, scope: { bad: true } } },
      { [id]: { ...draft, requestId: "------------------------------------" } },
      { [id]: { ...draft, updatedAt: Date.now() + 100000 } },
    ]) {
      s.setItem(key, JSON.stringify(value));
      expect(readDrafts(s, key)).toEqual({});
    }
  });
  it("bounds retained drafts and removes a deliberately emptied draft", () => {
    const s = storage(),
      key = "test";
    for (let i = 0; i < 40; i++) saveDraft(s, key, { ...draft, threadId: `thread${i}` });
    expect(Object.values(readDrafts(s, key))).toHaveLength(32);
    const first = Object.values(readDrafts(s, key))[0];
    saveDraft(s, key, { ...first, body: " " });
    expect(Object.values(readDrafts(s, key))).toHaveLength(31);
  });
});

it("offers editors historical main drafts without exposing other share discussions", () => {
  const scope = { ...draft.scope, versionId: "latest" };
  expect(canRecoverCommentDraft(draft, scope, false, true)).toBe(true);
  expect(canRecoverCommentDraft(draft, scope, false, false)).toBe(false);
  const shared = { ...draft, scope: { ...draft.scope, entry: { kind: "share" as const, shareId: "link" } } };
  expect(canRecoverCommentDraft(shared, scope, false, true)).toBe(false);
  expect(canRecoverCommentDraft(shared, scope, true, true)).toBe(true);
  expect(canRecoverCommentDraft({ ...shared, kind: "create" }, scope, true, true)).toBe(false);
});
