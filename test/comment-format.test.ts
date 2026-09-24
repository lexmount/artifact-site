import { describe, expect, it } from "vitest";
import { commentTextParts, safeCommentLink } from "@/lib/comments/format";
describe("lightweight comment formatting", () => {
  it("preserves line breaks and renders only code and safe links", () => {
    expect(commentTextParts("Before\n`hello()` [guide](https://example.com) after")).toEqual([
      {kind:"text",text:"Before\n"},{kind:"code",text:"hello()"},{kind:"text",text:" "},
      {kind:"link",text:"guide",href:"https://example.com/"},{kind:"text",text:" after"},
    ]);
  });
  it("does not interpret HTML or dangerous links", () => {
    expect(commentTextParts('<img src=x onerror=alert(1)> [click](javascript:alert)')).toEqual([
      {kind:"text",text:'<img src=x onerror=alert(1)> '},{kind:"text",text:"[click](javascript:alert)"},
    ]);
    for (const value of ["javascript:alert(1)","data:text/html,x","//example.com","https://user:pass@example.com","https://example.com\n"]) expect(safeCommentLink(value)).toBeNull();
  });
  it("keeps punctuation outside auto-links and URLs inside code inert", () => {
    expect(commentTextParts("https://example.com。 `https://example.com`")).toEqual([
      {kind:"link",text:"https://example.com",href:"https://example.com/"},{kind:"text",text:"。"},
      {kind:"text",text:" "},{kind:"code",text:"https://example.com"},
    ]);
  });
});
