import { describe, expect, it } from "vitest";
import { canShowCommentScope, shouldAggregateComments } from "@/components/comments/comment-view";
import type { CommentScope } from "@/lib/comments/contracts";
const main: CommentScope = { siteId: "site", versionId: "version", entry: { kind: "main" } };
const share: CommentScope = { ...main, entry: { kind: "share", shareId: "share" } };
describe("owner comment overview", () => {
  it("defaults managers to aggregation only on the main viewer", () => {
    expect(shouldAggregateComments(main, true, "all", false)).toBe(true);
    expect(shouldAggregateComments(main, false, "all", false)).toBe(false);
    expect(shouldAggregateComments(share, true, "all", false)).toBe(false);
    expect(shouldAggregateComments(main, true, "main", false)).toBe(false);
    expect(shouldAggregateComments(main, true, "all", true)).toBe(false);
  });
  it("allows current-version share locations without crossing site/version boundaries", () => {
    expect(canShowCommentScope(share, main, true)).toBe(true);
    expect(canShowCommentScope(share, main, false)).toBe(false);
    expect(canShowCommentScope({ ...share, versionId: "old" }, main, true)).toBe(false);
    expect(canShowCommentScope({ ...share, siteId: "other" }, main, true)).toBe(false);
    expect(canShowCommentScope(main, share, true)).toBe(false);
  });
});
