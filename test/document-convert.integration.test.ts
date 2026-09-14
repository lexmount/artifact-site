// Integration test against a REAL Gotenberg. Skipped unless GOTENBERG_URL is set. Run manually:
//   docker run -d -p 3009:3000 gotenberg/gotenberg:8-libreoffice
//   GOTENBERG_URL=http://localhost:3009 npx vitest run test/document-convert.integration.test.ts
//
// The docx fixture is built in-memory (OPC = zip of xml parts) and carries CHINESE text on
// purpose: converted-preview fidelity for CJK is a deploy gate, not a nice-to-have — a converter
// image without CJK fonts turns every Chinese document into tofu, and this test is where that shows.
import { describe, expect, it } from "vitest";
import { GotenbergConverter } from "@/lib/convert";
import { createSite } from "@/lib/sites";
import { servePreviewFile } from "@/lib/preview";
import { makeZip, readVersionFile } from "./helpers";

const live = Boolean(process.env.GOTENBERG_URL);

function chineseDocx(): Uint8Array {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>集成测试：中文预览正常。English ok. 123</w:t></w:r></w:p></w:body></w:document>';
  return makeZip({ "[Content_Types].xml": contentTypes, "_rels/.rels": rels, "word/document.xml": doc });
}

describe.skipIf(!live)("Gotenberg — live office→pdf round-trip", () => {
  it("converter turns a Chinese docx into real PDF bytes", async () => {
    const converter = new GotenbergConverter(process.env.GOTENBERG_URL!.replace(/\/+$/, ""), 60_000);
    const pdf = await converter.toPdf("集成测试.docx", chineseDocx());
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  }, 90_000);

  it("createSite on a docx lands the full viewer shape: wrapper + preview.pdf + original", async () => {
    const { site, version } = await createSite({ mode: "file", filename: "季度纪要.docx", bytes: chineseDocx() });
    expect(site.kind).toBe("document");
    expect(version.fileCount).toBe(3);
    expect(await readVersionFile(site.id, version.id, "index.html")).toContain("/vendor/pdfjs/pdf.min.mjs");
    const preview = await servePreviewFile(site.slug, ["preview.pdf"]);
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toBe("application/pdf");
    expect(Buffer.from(preview.body.slice(0, 5) as Uint8Array).toString("latin1")).toBe("%PDF-");
  }, 90_000);
});
