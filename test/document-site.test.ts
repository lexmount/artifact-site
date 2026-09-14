import { afterEach, describe, expect, it } from "vitest";
import { buildDocumentFiles, documentFormatOf, documentTitleOf, looksLikeOpcPackage, refreshDocumentWrapper, buildDocumentWrapperFiles } from "@/lib/document-site";
import { normalizeUpload } from "@/lib/upload";
import { servePreviewFile } from "@/lib/preview";
import { createSite, editSite, listVersions, replaceDocument } from "@/lib/sites";
import { writeFileToVersion } from "@/lib/store";
import { makeZip, readVersionFile, testAudit, u8 } from "./helpers";

// Fixture bytes carry REAL magic numbers: normalizeUpload sniffs content before accepting, so a
// "fake" payload must still open with the right signature for its claimed format.
const PDF_BYTES = u8("%PDF-1.7 fake");
const PPTX_BYTES = u8("PK\x03\x04 fake pptx");
const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01, 0x02]);

// One case sets a per-file limit through process.env; restore the shell's value rather than
// deleting it, and do so even when the assertion inside the case fails.
const savedMaxFileBytes = process.env.ARTIFACT_MAX_FILE_BYTES;
afterEach(() => {
  if (savedMaxFileBytes === undefined) delete process.env.ARTIFACT_MAX_FILE_BYTES;
  else process.env.ARTIFACT_MAX_FILE_BYTES = savedMaxFileBytes;
});

describe("document uploads — the fifth drop shape (single pdf/office file)", () => {
  it("maps extensions to formats, case-insensitively, and only for document types", () => {
    expect(documentFormatOf("报告.PDF")).toBe("pdf");
    expect(documentFormatOf("deck.pptx")).toBe("pptx");
    expect(documentFormatOf("old.PPT")).toBe("ppt");
    expect(documentFormatOf("doc.docx")).toBe("docx");
    expect(documentFormatOf("legacy.doc")).toBe("doc");
    expect(documentFormatOf("page.html")).toBeNull();
    expect(documentFormatOf("archive.zip")).toBeNull();
    expect(documentFormatOf("noext")).toBeNull();
  });

  it("single .pdf → document site: viewer wrapper over the original, original under original/", () => {
    const normalized = normalizeUpload({ mode: "file", filename: "季度报告.pdf", bytes: PDF_BYTES });
    expect(normalized.kind).toBe("document");
    expect(normalized.entry).toBe("index.html");
    expect(normalized.title).toBe("季度报告");
    expect(normalized.document).toEqual({ format: "pdf", originalName: "季度报告.pdf", originalRelpath: "original/季度报告.pdf" });

    const paths = normalized.files.map((f) => f.relpath);
    expect(paths).toEqual(["index.html", "original/季度报告.pdf"]);
    const wrapper = Buffer.from(normalized.files[0].bytes).toString("utf8");
    // Viewer form: loads the vendored PDF.js and points at the (url-encoded) original.
    expect(wrapper).toContain("/vendor/pdfjs/pdf.min.mjs");
    expect(wrapper).toContain(`original/${encodeURIComponent("季度报告.pdf")}`);
    expect(wrapper).toContain("Download original");
  });

  it("single office file (no converter in PR1) → download-card wrapper, never the viewer", () => {
    const normalized = normalizeUpload({ mode: "file", filename: "deck.pptx", bytes: PPTX_BYTES });
    expect(normalized.kind).toBe("document");
    expect(normalized.document?.format).toBe("pptx");
    const wrapper = Buffer.from(normalized.files[0].bytes).toString("utf8");
    expect(wrapper).not.toContain("/vendor/pdfjs/");
    expect(wrapper).toContain("Download file");
    expect(wrapper).toContain("PowerPoint");
  });

  it("legacy .doc/.ppt ride the same pipeline", () => {
    for (const filename of ["老文档.doc", "旧演示.ppt"]) {
      const normalized = normalizeUpload({ mode: "file", filename, bytes: OLE_BYTES });
      expect(normalized.kind).toBe("document");
      expect(normalized.files.map((f) => f.relpath)).toContain(`original/${filename}`);
    }
  });

  // Base64 decoding silently swallows corrupt input — the sniff turns "publishes fine, viewer
  // shows an unexplained blank" into an immediate 400 that names the actual problem.
  it("content that does not match the claimed format is rejected at normalize time", () => {
    const garbage = u8("not a document at all");
    for (const filename of ["x.pdf", "x.pptx", "x.docx", "x.ppt", "x.doc"]) {
      expect(() => normalizeUpload({ mode: "file", filename, bytes: garbage })).toThrow(/is not a valid/);
    }
    // Cross-family mislabels die too: OPC bytes under a .pdf name, pdf bytes under .docx.
    expect(() => normalizeUpload({ mode: "file", filename: "假.pdf", bytes: PPTX_BYTES })).toThrow(/is not a valid/);
    expect(() => normalizeUpload({ mode: "file", filename: "假.docx", bytes: PDF_BYTES })).toThrow(/is not a valid/);
    expect(() => normalizeUpload({ mode: "file", filename: "空.pdf", bytes: new Uint8Array(0) })).toThrow(/empty file/);
  });

  // The sniff hunts corruption, not format purity: what LibreOffice converts under a legacy name
  // in the wild must keep publishing — RTF wearing .doc (old exporters, mail attachments) and
  // OOXML renamed to .doc/.ppt were publishable before the sniff existed and must stay so.
  it("legacy extensions admit RTF and renamed OOXML, not just OLE", () => {
    const rtfBytes = u8("{\\rtf1\\ansi 老稿子}");
    expect(normalizeUpload({ mode: "file", filename: "老稿.doc", bytes: rtfBytes }).kind).toBe("document");
    expect(normalizeUpload({ mode: "file", filename: "改名.doc", bytes: PPTX_BYTES }).kind).toBe("document");
    expect(normalizeUpload({ mode: "file", filename: "改名.ppt", bytes: PPTX_BYTES }).kind).toBe("document");
    // But the modern extensions stay strict, and garbage still dies on every extension.
    expect(() => normalizeUpload({ mode: "file", filename: "假.docx", bytes: rtfBytes })).toThrow(/is not a valid/);
  });

  it("oversized documents get the upload layer's per-file limit message, not the storage layer's", () => {
    process.env.ARTIFACT_MAX_FILE_BYTES = "1024";
    try {
      const big = new Uint8Array(2048);
      big.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
      expect(() => normalizeUpload({ mode: "file", filename: "大.pdf", bytes: big })).toThrow(/exceeds the per-file limit/);
    } finally {
      delete process.env.ARTIFACT_MAX_FILE_BYTES;
    }
  });

  it("an explicit title wins over the filename", () => {
    const normalized = normalizeUpload({ mode: "file", filename: "deck.pptx", bytes: PPTX_BYTES, title: "路演一稿" });
    expect(normalized.title).toBe("路演一稿");
  });

  it("documentTitleOf strips the extension only, keeping dots inside the name", () => {
    expect(documentTitleOf("v2.1 发布计划.docx")).toBe("v2.1 发布计划");
    expect(documentTitleOf("noext")).toBe("noext");
  });

  it("createSite persists the document version: kind, entry, both files on disk", async () => {
    const { site, version } = await createSite({ mode: "file", filename: "白皮书.pdf", bytes: PDF_BYTES });
    expect(site.kind).toBe("document");
    expect(site.title).toBe("白皮书");
    expect(version.entry).toBe("index.html");
    expect(version.fileCount).toBe(2);
    expect(await readVersionFile(site.id, version.id, "index.html")).toContain("/vendor/pdfjs/pdf.min.mjs");
    expect(await readVersionFile(site.id, version.id, "original/白皮书.pdf")).toContain("%PDF-1.7");
  });

  // pptx/docx ARE zip archives (OPC). The zip entry must refuse them with a message that names
  // the real fix — not inflate them into xml parts and complain about a missing HTML entry.
  it("an OPC package dropped into the zip entry gets the targeted error, not the generic 'No HTML file found'", () => {
    const opcZip = makeZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "ppt/presentation.xml": "<p:presentation/>",
    });
    expect(() => normalizeUpload({ mode: "zip", bytes: opcZip })).toThrow(/Office document/);
    expect(looksLikeOpcPackage(["[Content_Types].xml", "ppt/x.xml"])).toBe(true);
    expect(looksLikeOpcPackage(["index.html", "app.js"])).toBe(false);
  });

  it("document sites refuse online edits — updating means re-uploading", async () => {
    const { site } = await createSite({ mode: "file", filename: "spec.docx", bytes: PPTX_BYTES });
    await expect(editSite(site.slug, { content: "overwrite" }, testAudit())).rejects.toThrow(/re-upload the whole file/);
  });

  it("hostile filenames are inert in the wrapper: HTML-escaped in text, \\u003c-escaped in the JSON island", () => {
    const filename = `">评估<img src=x onerror=alert(1)>.pdf`;
    const normalized = normalizeUpload({ mode: "file", filename, bytes: PDF_BYTES });
    const wrapper = Buffer.from(normalized.files[0].bytes).toString("utf8");
    expect(wrapper).not.toContain("<img src=x");
    expect(wrapper).toContain("&lt;img");
    // The config island escapes every "<" so a filename can never close the script tag early.
    const island = wrapper.match(/<script type="application\/json" id="doc-config">(.*?)<\/script>/s)?.[1] ?? "";
    expect(island).not.toContain("<");
    expect(JSON.parse(island).name).toBe(filename);
  });
});

describe("document replace — whole-file re-upload as the update path", () => {
  it("re-uploading lands a new current version on the SAME slug; history keeps both", async () => {
    const { site } = await createSite({ mode: "file", filename: "周报v1.pdf", bytes: u8("%PDF-1.7 v1") });
    const replaced = await replaceDocument(site.slug, { mode: "file", filename: "周报v2.pdf", bytes: u8("%PDF-1.7 v2") }, testAudit());
    expect(replaced).not.toBeNull();
    expect(replaced!.site.slug).toBe(site.slug);
    expect(replaced!.site.title).toBe("周报v1"); // the title is the share card's identity; re-upload leaves it alone (renaming goes through rename)

    const versions = await listVersions(site.slug);
    expect(versions).toHaveLength(2);
    expect(versions!.find((v) => v.current)!.id).toBe(replaced!.version.id);

    // The served site now carries the NEW file (wrapper regenerated for the new name).
    const wrapper = await servePreviewFile(site.slug, undefined);
    expect(wrapper.body.toString()).toContain(encodeURIComponent("周报v2.pdf"));
    const original = await servePreviewFile(site.slug, ["original", "周报v2.pdf"]);
    expect(original.status).toBe(200);
    expect(original.body.toString()).toContain("v2");
  });

  it("the format may change across versions (pptx card site replaced by a pdf → viewer form)", async () => {
    const { site } = await createSite({ mode: "file", filename: "deck.pptx", bytes: PPTX_BYTES });
    expect((await servePreviewFile(site.slug, undefined)).body.toString()).not.toContain("/vendor/pdfjs/");

    const replaced = await replaceDocument(site.slug, { mode: "file", filename: "deck 终稿.pdf", bytes: PDF_BYTES }, testAudit());
    expect(replaced).not.toBeNull();
    const wrapper = await servePreviewFile(site.slug, undefined);
    expect(wrapper.body.toString()).toContain("/vendor/pdfjs/pdf.min.mjs");
    expect(wrapper.body.toString()).toContain(encodeURIComponent("deck 终稿.pdf"));
  });

  it("refuses non-document sites and non-document payloads", async () => {
    const single = await createSite({ mode: "paste", html: "<html><head><title>t</title></head><body>x</body></html>" });
    await expect(replaceDocument(single.site.slug, { mode: "file", filename: "x.pdf", bytes: PDF_BYTES }, testAudit())).rejects.toThrow(/Only document sites/);

    const doc = await createSite({ mode: "file", filename: "spec.docx", bytes: PPTX_BYTES });
    await expect(replaceDocument(doc.site.slug, { mode: "file", filename: "page.html", bytes: u8("<html><head><title>x</title></head></html>") }, testAudit())).rejects.toThrow(/must still be a single/);
    await expect(replaceDocument(doc.site.slug, { mode: "paste", html: "<html><head><title>x</title></head></html>" }, testAudit())).rejects.toThrow(/must still be a single/);
  });

  it("unknown slug → null (route maps to 404)", async () => {
    expect(await replaceDocument("no-such-slug", { mode: "file", filename: "x.pdf", bytes: PDF_BYTES }, testAudit())).toBeNull();
  });
});

describe("document files — the office+preview shape (what the converter produces)", () => {
  const meta = { format: "pptx" as const, originalName: "deck.pptx", originalRelpath: "original/deck.pptx" };

  it("with a preview pdf: viewer wrapper over preview.pdf + all three files", () => {
    const files = buildDocumentFiles(meta, PPTX_BYTES, u8("%PDF preview"));
    expect(files.map((f) => f.relpath)).toEqual(["index.html", "preview.pdf", "original/deck.pptx"]);
    const wrapper = Buffer.from(files[0].bytes).toString("utf8");
    expect(wrapper).toContain("/vendor/pdfjs/pdf.min.mjs");
    expect(wrapper).toContain("preview.pdf");
    expect(wrapper).toContain("original/deck.pptx"); // the download link still targets the original
  });

  it("every viewer form carries play mode; the download card never does", () => {
    const converted = Buffer.from(buildDocumentFiles(meta, PPTX_BYTES, u8("%PDF p"))[0].bytes).toString("utf8");
    expect(converted).toContain('id="play"');
    expect(converted).toContain('id="show"');
    const pdfMeta = { format: "pdf" as const, originalName: "报告.pdf", originalRelpath: "original/报告.pdf" };
    const pdfWrapper = Buffer.from(buildDocumentFiles(pdfMeta, PDF_BYTES, null)[0].bytes).toString("utf8");
    expect(pdfWrapper).toContain('id="play"'); // exported-slides pdfs are decks too
    const card = Buffer.from(buildDocumentFiles(meta, PPTX_BYTES, null)[0].bytes).toString("utf8");
    expect(card).not.toContain('id="play"');
  });

  it("without a preview: card wrapper carries the caller's note", () => {
    const files = buildDocumentFiles(meta, PPTX_BYTES, null, "Conversion timed out; re-upload later to retry");
    const wrapper = Buffer.from(files[0].bytes).toString("utf8");
    expect(wrapper).toContain("Download file");
    expect(wrapper).toContain("Conversion timed out");
  });
});

describe("wrapper refresh — stored viewers pick up the current template on serve", () => {
  // The exact production scenario: a document uploaded BEFORE a viewer feature shipped carries a
  // frozen wrapper without it. Serving must regenerate from the doc-config island.
  const legacyWrapper = `<!doctype html><html><head><title>老包装页</title></head><body>
<div class="bar"><span class="pages" id="pages"></span><a class="dl">下载原件</a></div>
<div id="stage"></div>
<script type="application/json" id="doc-config">{"file":"preview.pdf","original":"original/%E5%AD%A6%E7%94%9F%E5%9F%B9%E8%AE%AD.pptx","name":"学生培训.pptx"}</script>
<script type="module">/* 旧版查看器：没有播放、没有缩略图模式 */</script>
</body></html>`;

  it("regenerates a legacy viewer wrapper — the frozen version gains play and thumb mode", () => {
    const refreshed = refreshDocumentWrapper(legacyWrapper);
    expect(refreshed).not.toBeNull();
    expect(refreshed!).toContain('id="play"');
    expect(refreshed!).toContain("thumb");
    expect(refreshed!).toContain(`original/${encodeURIComponent("学生培训.pptx")}`); // meta round-trips
    expect(refreshed!).toContain("preview.pdf");
    expect(refreshed!).toContain("学生培训.pptx");
  });

  it("round-trips the CURRENT template — pins matcher ↔ template coherence against reorders", () => {
    const current = Buffer.from(buildDocumentFiles(
      { format: "pptx", originalName: "学生培训.pptx", originalRelpath: "original/学生培训.pptx" }, PPTX_BYTES, u8("%PDF p"),
    )[0].bytes).toString("utf8");
    const refreshed = refreshDocumentWrapper(current);
    expect(refreshed).not.toBeNull(); // if a template change breaks extraction, this reds — no silent fallback
    expect(refreshed!).toContain(`original/${encodeURIComponent("学生培训.pptx")}`);
  });

  it("leaves anything unrecognizable alone: cards (no island) and corrupt islands", () => {
    expect(refreshDocumentWrapper("<html><body>下载卡片，没有 island</body></html>")).toBeNull();
    expect(refreshDocumentWrapper('<script type="application/json" id="doc-config">{broken</script>')).toBeNull();
    expect(refreshDocumentWrapper('<script type="application/json" id="doc-config">{"file":1}</script>')).toBeNull();
  });

  it("serving a document entry regenerates the stored wrapper (legacy site heals without re-upload)", async () => {
    const { site, version } = await createSite({ mode: "file", filename: "季度报告.pdf", bytes: PDF_BYTES });
    // Simulate a site from before play mode existed by overwriting the stored wrapper with the legacy one.
    await writeFileToVersion(site.id, version.id, "index.html", u8(legacyWrapper.replaceAll("preview.pdf", `original/${encodeURIComponent("季度报告.pdf")}`)));
    const res = await servePreviewFile(site.slug, undefined);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('id="play"'); // healed on serve, no re-upload
    expect(res.body.toString()).toContain("<base href="); // bootstrap injection still applies
  });

  it("the wrapper honors ?thumb: static poster branch exists and pdf.js boot is gated", () => {
    const wrapper = Buffer.from(buildDocumentFiles(
      { format: "pdf", originalName: "报告.pdf", originalRelpath: "original/报告.pdf" }, PDF_BYTES, null,
    )[0].bytes).toString("utf8");
    expect(wrapper).toContain('has("thumb")');
    expect(wrapper).toContain("if (!isThumb) boot()");
  });
});

describe("document serving — MIME + forced download on original/", () => {
  it("serves the original with its real MIME and an RFC5987 attachment disposition", async () => {
    const { site } = await createSite({ mode: "file", filename: "季度报告.pdf", bytes: PDF_BYTES });
    const res = await servePreviewFile(site.slug, ["original", "季度报告.pdf"]);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("季度报告.pdf")}`);
  });

  it("office originals carry their office MIME", async () => {
    const { site } = await createSite({ mode: "file", filename: "deck.pptx", bytes: PPTX_BYTES });
    const res = await servePreviewFile(site.slug, ["original", "deck.pptx"]);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("an HTML site's own original/ dir keeps today's behaviour — no forced download", async () => {
    const { site } = await createSite({
      mode: "folder",
      files: [
        { relpath: "index.html", bytes: u8("<html><head><title>t</title></head><body>x</body></html>") },
        { relpath: "original/data.pdf", bytes: PDF_BYTES },
      ],
    });
    const res = await servePreviewFile(site.slug, ["original", "data.pdf"]);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("the wrapper entry itself serves as normal sandboxed HTML", async () => {
    const { site } = await createSite({ mode: "file", filename: "白皮书.pdf", bytes: PDF_BYTES });
    const res = await servePreviewFile(site.slug, undefined);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body.toString()).toContain("doc-config");
  });
});

describe("buildDocumentWrapperFiles — generates only the wrapper page, never the original file (chunked-upload streaming path)", () => {
  const pdfMeta = { format: "pdf" as const, originalName: "a.pdf", originalRelpath: "a.pdf" };
  const pptMeta = { format: "pptx" as const, originalName: "d.pptx", originalRelpath: "original/d.pptx" };

  it("PDF: index.html only, pointing at the original's relative path, without the original itself", () => {
    const files = buildDocumentWrapperFiles(pdfMeta, 4096, null);
    expect(files.map((f) => f.relpath)).toEqual(["index.html"]);
    expect(new TextDecoder().decode(files[0].bytes)).toContain("a.pdf");
  });
  it("Office with a preview: index.html + preview.pdf, still without the original", () => {
    const files = buildDocumentWrapperFiles(pptMeta, 4096, new Uint8Array([1, 2, 3]));
    expect(files.map((f) => f.relpath).sort()).toEqual(["index.html", "preview.pdf"].sort());
    expect(files.some((f) => f.relpath === "original/d.pptx")).toBe(false);
  });
  it("Office without a preview: degrades to a download-card index.html, without the original", () => {
    const files = buildDocumentWrapperFiles(pptMeta, 4096, null, "转换失败");
    expect(files.map((f) => f.relpath)).toEqual(["index.html"]);
  });
  it("buildDocumentFiles = wrapper page + original (the whole-file in-memory path), ordered entry first, original second", () => {
    const original = new Uint8Array([9, 9, 9, 9]);
    const files = buildDocumentFiles(pdfMeta, original, null);
    expect(files.map((f) => f.relpath)).toEqual(["index.html", "a.pdf"]);
    expect(files[1].bytes).toEqual(original);
  });
});
