import { describe, it, expect } from "vitest";
import { chooseUploadRoute, zipTooLargeMessage, INLINE_UPLOAD_MAX_BYTES } from "@/lib/upload-route";
import { translatorFor } from "@/lib/i18n";

const MiB = 1024 * 1024;
const t = translatorFor("en");
const f = (path: string, mb: number) => ({ path, size: Math.round(mb * MiB) });

describe("chooseUploadRoute — which path a browser drop takes", () => {
  const LIM = 20 * MiB;

  it("a single small HTML → one-shot file", () => {
    expect(chooseUploadRoute([f("page.html", 1)], LIM, t)).toEqual({ kind: "file" });
  });
  it("a single large HTML (over the limit) → automatically chunked; this is the core regression of the fix", () => {
    expect(chooseUploadRoute([f("page.html", 30)], LIM, t)).toEqual({ kind: "chunked" });
  });
  it("a single small PDF → one-shot file; a single large PDF → automatically chunked", () => {
    expect(chooseUploadRoute([f("a.pdf", 5)], LIM, t)).toEqual({ kind: "file" });
    expect(chooseUploadRoute([f("报告.pdf", 120)], LIM, t)).toEqual({ kind: "chunked" });
  });
  it(".htm is never chunked (the server entry only recognises .html) — a large .htm stays file and lets the server report the limit", () => {
    expect(chooseUploadRoute([f("legacy.htm", 30)], LIM, t)).toEqual({ kind: "file" });
  });
  it("a single Office document is never chunked: file regardless of size (conversion is an in-memory path; raise the one-shot limit instead of chunking)", () => {
    expect(chooseUploadRoute([f("deck.pptx", 5)], LIM, t)).toEqual({ kind: "file" });
    expect(chooseUploadRoute([f("deck.pptx", 40)], LIM, t)).toEqual({ kind: "file" });
    expect(chooseUploadRoute([f("报告.docx", 40)], LIM, t)).toEqual({ kind: "file" });
  });
  it("a single zip: within the limit → zip; over it → error (zips are not unpacked or chunked)", () => {
    expect(chooseUploadRoute([f("site.zip", 5)], LIM, t)).toEqual({ kind: "zip" });
    const big = chooseUploadRoute([f("site.zip", 40)], LIM, t);
    expect(big.kind).toBe("error");
    expect(big).toEqual({ kind: "error", message: zipTooLargeMessage(40 * MiB, LIM, t) });
  });
  it("a folder: with HTML and total within the limit → folder; total over → chunked", () => {
    expect(chooseUploadRoute([f("index.html", 1), f("a.css", 1)], LIM, t)).toEqual({ kind: "folder" });
    expect(chooseUploadRoute([f("index.html", 1), f("media/v.mp4", 30)], LIM, t)).toEqual({ kind: "chunked" });
  });
  it("multiple files without an HTML entry → error pointing at dropping a single document", () => {
    const r = chooseUploadRoute([f("a.png", 1), f("b.css", 1)], LIM, t);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toMatch(/No \.html entry file/);
  });
  it("a single file that is neither site, document nor zip → falls into the folder branch and reports no HTML", () => {
    const r = chooseUploadRoute([f("random.bin", 1)], LIM, t);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toMatch(/HTML/);
  });
  it("an empty selection → error, no request sent", () => {
    expect(chooseUploadRoute([], LIM, t).kind).toBe("error");
  });
  it("the threshold is the inlineMax passed in, not a hard-coded default (the same 25MB file decides differently under different thresholds)", () => {
    expect(chooseUploadRoute([f("p.html", 25)], 20 * MiB, t)).toEqual({ kind: "chunked" });
    expect(chooseUploadRoute([f("p.html", 25)], 50 * MiB, t)).toEqual({ kind: "file" });
    expect(INLINE_UPLOAD_MAX_BYTES).toBe(20 * MiB);
  });
});
