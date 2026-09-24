import { createElement } from "react";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentHighlight } from "@/components/comments/comment-highlight";
it("highlights literal, case-insensitive matches without interpreting markup", () => {
  const html = renderToStaticMarkup(createElement(CommentHighlight,{text:"<script>A+B a+b</script>",query:"a+b"}));
  expect(html).toBe('&lt;script&gt;<mark class="comment-match">A+B</mark> <mark class="comment-match">a+b</mark>&lt;/script&gt;');
  expect(renderToStaticMarkup(createElement(CommentHighlight,{text:"😀中文",query:"😀"}))).toContain('>😀</mark>中文');
  expect(renderToStaticMarkup(createElement(CommentHighlight,{text:"unchanged",query:" "}))).toBe("unchanged");
});

it("renders lone surrogate queries without throwing", () => {
  for(const query of ["\uD800","\uDFFF","a\uD800b"]) {
    expect(()=>new RegExp(`(${query})`,"giu")).not.toThrow();
    expect(()=>renderToStaticMarkup(createElement(CommentHighlight,{text:query,query}))).not.toThrow();
  }
});
