import { afterEach, describe, expect, it } from "vitest";
import { applyDocumentConversion, ConversionError, type Converter } from "@/lib/convert";
import { normalizeUpload } from "@/lib/upload";
import { u8 } from "./helpers";

// Cases below set limits and conversion knobs through process.env; put back whatever the shell
// had (a `delete` in a finally block would drop a developer's own value, and a failed assertion
// before the finally would leak the case's value into the next file).
const ENV_KEYS = ["ARTIFACT_MAX_BYTES", "ARTIFACT_MAX_FILE_BYTES", "ARTIFACT_CONVERT_CONCURRENCY", "ARTIFACT_CONVERT_TIMEOUT_MS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const PPTX_BYTES = u8("PK\x03\x04 fake pptx bytes"); // real OPC magic — normalizeUpload sniffs content

function normalizedOffice() {
  return normalizeUpload({ mode: "file", filename: "路演.pptx", bytes: PPTX_BYTES });
}

const okConverter: Converter = { toPdf: async () => u8("%PDF-1.7 converted preview") };
const deadConverter: Converter = { toPdf: async () => { throw new ConversionError("Conversion failed (HTTP 500)"); } };

describe("applyDocumentConversion — the office→pdf seam", () => {
  it("office + working converter → viewer wrapper + preview.pdf + untouched original", async () => {
    const out = await applyDocumentConversion(normalizedOffice(), okConverter);
    expect(out.files.map((f) => f.relpath)).toEqual(["index.html", "preview.pdf", "original/路演.pptx"]);
    expect(Buffer.from(out.files[1].bytes).toString("utf8")).toContain("%PDF-1.7 converted");
    const wrapper = Buffer.from(out.files[0].bytes).toString("utf8");
    expect(wrapper).toContain("/vendor/pdfjs/pdf.min.mjs");
    expect(wrapper).toContain("preview.pdf");
    // The original rode through byte-identical.
    expect(Buffer.from(out.files[2].bytes).equals(Buffer.from(PPTX_BYTES))).toBe(true);
  });

  it("conversion failure degrades to the download card carrying the reason — publish never fails", async () => {
    const out = await applyDocumentConversion(normalizedOffice(), deadConverter);
    expect(out.files.map((f) => f.relpath)).toEqual(["index.html", "original/路演.pptx"]);
    const wrapper = Buffer.from(out.files[0].bytes).toString("utf8");
    expect(wrapper).toContain("Download file");
    expect(wrapper).toContain("Conversion failed (HTTP 500)");
    expect(wrapper).not.toContain("/vendor/pdfjs/");
  });

  it("converter off (null) → the plain card normalizeUpload already built", async () => {
    const before = normalizedOffice();
    const out = await applyDocumentConversion(before, null);
    expect(out).toBe(before);
  });

  it("pdf documents and non-document uploads pass through untouched", async () => {
    const pdf = normalizeUpload({ mode: "file", filename: "报告.pdf", bytes: u8("%PDF-1.7 x") });
    expect(await applyDocumentConversion(pdf, okConverter)).toBe(pdf);
    const html = normalizeUpload({ mode: "paste", html: "<html><head><title>t</title></head><body>x</body></html>" });
    expect(await applyDocumentConversion(html, okConverter)).toBe(html);
  });

  it("legacy formats (.doc/.ppt) go through the same conversion", async () => {
    const oleBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    const doc = normalizeUpload({ mode: "file", filename: "老文档.doc", bytes: oleBytes });
    const out = await applyDocumentConversion(doc, okConverter);
    expect(out.files.map((f) => f.relpath)).toContain("preview.pdf");
  });

  // A 25MB deck often converts to a >25MB pdf: the user's file is LEGAL, and our own generated
  // preview must never be what pushes their publish over the site cap — drop it, keep the card.
  it("a conversion result that would blow the size limits degrades to the card, publish survives", async () => {
    process.env.ARTIFACT_MAX_BYTES = String(64 * 1024);
    process.env.ARTIFACT_MAX_FILE_BYTES = String(48 * 1024);
    try {
      const bigPdf: Converter = { toPdf: async () => { const b = new Uint8Array(60 * 1024); b.set([0x25, 0x50, 0x44, 0x46]); return b; } };
      const out = await applyDocumentConversion(normalizedOffice(), bigPdf);
      expect(out.files.map((f) => f.relpath)).toEqual(["index.html", "original/路演.pptx"]);
      const wrapper = Buffer.from(out.files[0].bytes).toString("utf8");
      expect(wrapper).toContain("Download file");
      expect(wrapper).toContain("preview is too large");
    } finally {
      delete process.env.ARTIFACT_MAX_BYTES;
      delete process.env.ARTIFACT_MAX_FILE_BYTES;
    }
  });

  // Handoff fairness: a released slot must go to the EARLIEST living waiter, never to a newcomer
  // and never send a woken waiter back to the tail (which starved early arrivals under pressure).
  it("the queue is strict FIFO: a released slot goes to the earliest waiter", async () => {
    process.env.ARTIFACT_CONVERT_CONCURRENCY = "1";
    process.env.ARTIFACT_CONVERT_TIMEOUT_MS = "5000";
    try {
      const order: string[] = [];
      let releaseA!: () => void;
      const mk = (name: string): Converter => ({
        toPdf: () => new Promise((resolve) => {
          order.push(name);
          if (name === "A") releaseA = () => resolve(u8("%PDF a"));
          else resolve(u8("%PDF " + name));
        }),
      });
      const a = applyDocumentConversion(normalizedOffice(), mk("A")); // takes the slot, holds it
      await new Promise((r) => setTimeout(r, 10));
      const b = applyDocumentConversion(normalizedOffice(), mk("B")); // queue position 1
      await new Promise((r) => setTimeout(r, 10));
      const c = applyDocumentConversion(normalizedOffice(), mk("C")); // queue position 2
      await new Promise((r) => setTimeout(r, 10));
      releaseA();
      await Promise.all([a, b, c]);
      expect(order).toEqual(["A", "B", "C"]);
    } finally {
      delete process.env.ARTIFACT_CONVERT_CONCURRENCY;
      delete process.env.ARTIFACT_CONVERT_TIMEOUT_MS;
    }
  });

  // A timed-out waiter must leave the queue ENTIRELY: corpses counting toward the queue-full
  // backstop would misclassify the next upload as "queue full" (wrong triage row — the truth is
  // "budget/concurrency too small", a different knob).
  it("timed-out waiters leave no corpses: the next upload is \"queue timeout\", never \"queue full\"", async () => {
    process.env.ARTIFACT_CONVERT_CONCURRENCY = "1"; // queue-full backstop = 10
    process.env.ARTIFACT_CONVERT_TIMEOUT_MS = "200";
    try {
      let release!: () => void;
      const holder: Converter = { toPdf: () => new Promise((resolve) => { release = () => resolve(u8("%PDF hold")); }) };
      const first = applyDocumentConversion(normalizedOffice(), holder); // pins the only slot
      await new Promise((r) => setTimeout(r, 20));
      // Fill the queue to its hard cap and let every waiter time out in place.
      const waiters = Array.from({ length: 10 }, () => applyDocumentConversion(normalizedOffice(), holder));
      await Promise.all(waiters);
      // The slot is still held; a fresh upload must be judged by the (now empty) queue, not corpses.
      const fresh = await applyDocumentConversion(normalizedOffice(), holder);
      const wrapper = Buffer.from(fresh.files[0].bytes).toString("utf8");
      expect(wrapper).toContain("Timed out waiting in the conversion queue");
      expect(wrapper).not.toContain("queue is full");
      release();
      await first;
    } finally {
      delete process.env.ARTIFACT_CONVERT_CONCURRENCY;
      delete process.env.ARTIFACT_CONVERT_TIMEOUT_MS;
    }
  });

  // The timeout is a TOTAL budget: queue wait counts too, so a burst can never hold an upload
  // past the gateway's patience — the tail requests degrade to the card instead of hanging.
  it("queue wait beyond the budget degrades to the card instead of hanging the publish", async () => {
    process.env.ARTIFACT_CONVERT_CONCURRENCY = "1";
    process.env.ARTIFACT_CONVERT_TIMEOUT_MS = "300";
    try {
      let release!: () => void;
      const slow: Converter = { toPdf: () => new Promise((resolve) => { release = () => resolve(u8("%PDF slow")); }) };
      const first = applyDocumentConversion(normalizedOffice(), slow); // occupies the only slot
      await new Promise((r) => setTimeout(r, 20));
      const second = await applyDocumentConversion(normalizedOffice(), slow); // queued → budget expires
      const wrapper = Buffer.from(second.files[0].bytes).toString("utf8");
      expect(wrapper).toContain("Download file");
      expect(wrapper).toContain("Timed out waiting in the conversion queue");
      release();
      const firstResult = await first; // the slot holder still finishes normally
      expect(firstResult.files.map((f) => f.relpath)).toContain("preview.pdf");
    } finally {
      delete process.env.ARTIFACT_CONVERT_CONCURRENCY;
      delete process.env.ARTIFACT_CONVERT_TIMEOUT_MS;
    }
  });

  it("a converter throwing a non-ConversionError still degrades (generic reason, error logged)", async () => {
    const buggy: Converter = { toPdf: async () => { throw new TypeError("boom"); } };
    const out = await applyDocumentConversion(normalizedOffice(), buggy);
    const wrapper = Buffer.from(out.files[0].bytes).toString("utf8");
    expect(wrapper).toContain("Download file");
    expect(wrapper).toContain("Conversion failed");
  });
});
