import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/components/locale-provider", () => ({ useT: () => (key: string) => key, useLocale: () => "en" }));
import { CommentConversation, CommentSummary } from "@/components/comments/comment-thread";
import type { CommentThreadDetail } from "@/lib/comments/contracts";

it("keeps whole-file evidence short in both the list and conversation", () => {
  const excerpt = "文".repeat(2000);
  const detail = {
    thread: { anchor: { kind: "document", schemaVersion: 1, filePath: "index.html" }, context: { excerpt }, resolution: { status: "open" } },
    messages: { items: [{ id: "root", isRoot: true, createdAt: 1, content: { state: "visible", body: "A comment" } }], nextCursor: null },
    permissions: { messages: {}, canReply: false },
  } as unknown as CommentThreadDetail;
  const noop = () => {};
  const views = [
    createElement(CommentSummary, { detail, source: "Main", onChoose: noop }),
    createElement(CommentConversation, { detail, source: "Main", busy: false, onReply: noop, onEdit: noop, onDelete: noop, onResolve: noop, onLocate: noop, onMore: noop, onReact: async () => {} }),
  ];
  for (const view of views) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Comment on the whole file");
    expect(html).toContain("文".repeat(30) + "…");
    expect(html).not.toContain("文".repeat(31));
  }
});
