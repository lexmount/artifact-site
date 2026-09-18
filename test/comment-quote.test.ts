import { expect, it } from "vitest";
import { commentQuote, commentAnchorLabel } from "@/lib/comments/presentation";
const t = (key: string) => key;
it("limits quotes to 30 characters and adds an ellipsis only when needed", () => {
  expect(commentQuote("文".repeat(30))).toBe("文".repeat(30));
  expect(commentQuote("文".repeat(31))).toBe("文".repeat(30) + "…");
  expect(commentQuote("👨‍👩‍👧‍👦".repeat(31))).toBe("👨‍👩‍👧‍👦".repeat(30) + "…");
});
it("labels whole-file comments even when stored evidence contains the entire page", () => {
  expect(commentAnchorLabel({ kind: "document", schemaVersion: 1, filePath: "index.html" }, "a".repeat(2000), t))
    .toBe("Comment on the whole file · " + "a".repeat(30) + "…");
  expect(commentAnchorLabel({ kind: "document", schemaVersion: 1, filePath: "index.html" }, null, t)).toBe("Comment on the whole file");
});
