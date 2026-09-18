import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import CommentSignIn from "@/components/comments/comment-sign-in";

it("opens sign-in separately and provides a non-submitting access refresh", () => {
  const refresh = vi.fn();
  const html = renderToStaticMarkup(createElement(CommentSignIn, { onRefresh: refresh, returnTo: "/v/example" }));
  expect(html).toContain('href="/api/auth/login?return_to=%2Fv%2Fexample"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain('type="button"');
  expect(html).toContain("Refresh access");
  expect(html).toContain("Your draft stays here.");
  expect(refresh).not.toHaveBeenCalled();
});
