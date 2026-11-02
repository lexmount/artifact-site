import { expect, it } from "vitest";
import { safeRelativePath } from "@/lib/storage";
import { canonicalPreviewPath } from "@/lib/comments/preview-path";

it.each([
  ".docs/page.html", ".assets/chart.svg", "./.docs/page.html", "folder\\image.png",
  "cafe\u0301/page.html", "a%20b.html", "", "/a", "a//b", "a/./b", "a/../b",
  ".git/a", ".GIT/a", "NODE_MODULES/a", "a\0b", "x".repeat(256),
  `${"字".repeat(86)}/a`, Array(6).fill("x".repeat(180)).join("/"),
])("matches storage's path policy for %s", input => {
  let expected: string | null;
  try { expected = safeRelativePath(input); } catch { expected = null; }
  expect(canonicalPreviewPath(input)).toBe(expected);
});

it("allows repository/dependency anchors only for package previews", () => {
  for (const name of [".git/image.png", "node_modules/lib/image.png"]) {
    expect(canonicalPreviewPath(name)).toBe(null);
    expect(canonicalPreviewPath(name, true)).toBe(name);
  }
  expect(canonicalPreviewPath("../escape.png", true)).toBe(null);
});
