import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ files: {} as Record<string, Uint8Array> }));
vi.mock("@/lib/storage", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  getStorage: () => ({
    sizeOf: async (_site: string, _version: string, file: string) => state.files[file]?.length ?? null,
    read: async (_site: string, _version: string, file: string) => state.files[file],
    readRange: async (_site: string, _version: string, file: string, start: number, end: number) => ({ bytes: state.files[file]?.slice(start, end + 1) }),
  }),
}));
import { prepareCommentEvidence, commentHtmlText } from "@/lib/comments/evidence";
import { buildCommentPdf } from "./fixtures/comment-pdf";
import type { Site, Version } from "@/lib/types";
const site = { id: "site", kind: "single" } as Site;
const version = { id: "version", siteId: "site", entry: "index.html" } as Version;
beforeEach(() => { state.files = {}; });
describe("server-derived comment evidence", () => {
  it("excludes executable HTML and form values from bounded text", async () => {
    const html = '<html><body><h1>Public heading</h1><script>SECRET_SCRIPT</script><form><textarea>SECRET_FORM</textarea><input value="SECRET_INPUT"></form></body></html>';
    state.files["index.html"] = new TextEncoder().encode(html);
    const result = await prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "document", filePath: "index.html" });
    expect(result.excerpt).toBe("Public heading");
    expect(commentHtmlText(html)).not.toMatch(/SECRET|<script>/);
    const dynamic = await prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "html", filePath: "index.html", selector: "h1", quote: { exact: "client invented text" }, viewport: { width: 100, height: 100 } });
    expect(dynamic.excerpt).toBeNull();
  });
  it("rejects foreign versions, nonexistent paths, wrong kinds and misleading image extensions", async () => {
    state.files["picture.png"] = new TextEncoder().encode("<html>not an image</html>");
    await expect(prepareCommentEvidence(site, { ...version, siteId: "other" }, { schemaVersion: 1, kind: "document", filePath: "index.html" })).rejects.toThrow("Version");
    await expect(prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "document", filePath: "../secret" })).rejects.toThrow();
    await expect(prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "document", filePath: "missing" })).rejects.toThrow("does not exist");
    await expect(prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "html", filePath: "picture.png", selector: "body", viewport: { width: 1, height: 1 } })).rejects.toThrow("HTML file");
    await expect(prepareCommentEvidence(site, version, { schemaVersion: 1, kind: "image", filePath: "picture.png", region: { kind: "point", point: { x: .5, y: .5 } } })).rejects.toThrow("format");
  });
  it("accepts SVG exports with a long generator prolog without weakening binary checks", async () => {
    state.files["export.svg"] = new TextEncoder().encode('<?xml version="1.0"?><!--' + "generator ".repeat(150) + '--><svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const anchor = { schemaVersion: 1 as const, kind: "image" as const, filePath: "export.svg", region: { kind: "point" as const, point: { x: .5, y: .5 } } };
    await expect(prepareCommentEvidence(site, version, anchor)).resolves.toMatchObject({ excerpt: null });
    state.files["export.png"] = state.files["export.svg"];
    await expect(prepareCommentEvidence(site, version, { ...anchor, filePath: "export.png" })).rejects.toThrow("format");
  });
  it("validates actual PDF page count and records the immutable Office rendition", async () => {
    state.files["preview.pdf"] = buildCommentPdf(2);
    state.files["original/report.docx"] = new Uint8Array([1]);
    state.files["index.html"] = new TextEncoder().encode('<script type="application/json" id="doc-config">{"file":"preview.pdf","original":"original/report.docx"}</script>');
    const anchor = { schemaVersion: 1 as const, kind: "pdf" as const, filePath: "preview.pdf", page: 2, region: { kind: "rect" as const, rect: { x: 0, y: 0, width: 1, height: 1 } } };
    const result = await prepareCommentEvidence({ ...site, kind: "document" }, version, anchor);
    expect(result.excerpt).toContain("Page 2 of 2");
    expect((await prepareCommentEvidence(site, version, {...anchor,quote:{exact:"Page 2"}})).excerpt).toBe("Page 2");
    expect((await prepareCommentEvidence(site, version, {...anchor,quote:{exact:"invented text"}})).excerpt).toBe("Page 2 of 2");
    expect(result.originalFilePath).toBe("original/report.docx");
    expect(result.rendition?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(prepareCommentEvidence(site, version, { ...anchor, page: 3 })).rejects.toThrow("page does not exist");
  });
});
