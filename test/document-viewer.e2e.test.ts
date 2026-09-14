// Real-browser E2E for the document viewer wrapper. Skipped unless VIEWER_E2E_URL is set — the
// same gating precedent as the S3/PG/Gotenberg integration tests. Run manually:
//
//   npm run build
//   ARTIFACT_DATABASE_URL=postgres://... ARTIFACT_CREATE_POLICY=open \
//     ARTIFACT_DEFAULT_VISIBILITY=public ARTIFACT_DATA_DIR=/tmp/ah-e2e npx next start --port 4390 &
//   VIEWER_E2E_URL=http://localhost:4390 npx vitest run test/document-viewer.e2e.test.ts
//   (optional: E2E_CHROME=/path/to/chrome; defaults to Google Chrome on macOS)
//
// Why these exist as browser tests and not unit tests: every REAL bug this viewer has shipped —
// unbounded canvas backing stores, negative-size silent blanks in zero-width containers, the
// watchdog armed after the very awaits it was meant to guard — was invisible to jsdom-level
// assertions and only reproducible in a real renderer. String-matching the generated wrapper
// can't see any of it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";

const baseUrl = (process.env.VIEWER_E2E_URL || "").replace(/\/+$/, "");
const chromePath = process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = { executablePath: chromePath, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] };

async function englishPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
  return page;
}

/**
 * A syntactically COMPLETE n-page PDF (xref table with real byte offsets, one text line per
 * page). Hand-built so the fixture needs no converter and no binary blob in the repo; complete
 * on purpose — PDF.js will limp through a missing xref, and a fixture that depends on lenient
 * parsing would test the parser's mercy, not the viewer.
 */
function buildPdf(pages: number): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`);
  const fontRef = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    objects.push(`${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${3 + pages + i} 0 R /Resources << /Font << /F1 ${fontRef} 0 R >> >> >>\nendobj\n`);
  }
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 24 Tf 60 700 Td (Page ${i + 1} of ${pages}) Tj ET`;
    objects.push(`${3 + pages + i} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }
  objects.push(`${fontRef} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** The three-way canvas classification. width>1 alone is NOT "painted": an unpainted <canvas>
 *  defaults to a 300×150 backing store — counting those as painted hid the windowing bug twice. */
const CLASSIFY = `(() => {
  const canvases = [...document.querySelectorAll("#stage canvas")]; // the slideshow's #slide canvas is not a page
  return {
    total: canvases.length,
    released: canvases.filter((c) => c.width === 0).map((c) => c.dataset.page),
    painted: canvases.filter((c) => c.width > 0 && !(c.width === 300 && c.height === 150)).map((c) => c.dataset.page),
    err: document.getElementById("err")?.style.display || "",
    pages: document.getElementById("pages")?.textContent || "",
  };
})()`;

type Snapshot = { total: number; released: string[]; painted: string[]; err: string; pages: string };

async function until<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await probe();
  }
  return last;
}

describe.skipIf(!baseUrl)("home page — thumbnail iframes must not steal focus", () => {
  let puppeteer: typeof import("puppeteer-core");
  let browser: Browser;
  let thiefSlug: string;

  beforeAll(async () => {
    puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch(launchOptions);
    // A deliberately hostile artifact: keeps grabbing focus the way real-world artifacts do with
    // autofocus inputs. Rendered inside a directory-card thumbnail it used to yank the page down
    // to its card (the browser scrolls to whatever iframe content takes focus).
    const response = await fetch(`${baseUrl}/api/sites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "paste",
        title: "e2e-焦点小偷",
        html: `<html><head><title>steal</title></head><body><input autofocus><script>setInterval(() => document.querySelector("input").focus(), 200)</script></body></html>`,
      }),
    });
    if (!response.ok) throw new Error(`create failed: ${response.status}`);
    thiefSlug = (await response.json()).slug;
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("typing in Explore keeps focus and the draft while the hostile thumbnail remains visible", async () => {
    const page = await englishPage(browser);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/explore`, { waitUntil: "networkidle0", timeout: 30_000 });
    const thumbnail = `iframe[src="/api/preview/${thiefSlug}?thumb=1"]`;
    await page.waitForSelector(thumbnail);
    expect(await page.$eval(thumbnail, (frame) => frame.getAttribute("sandbox"))).toBe("");
    await page.click('input[type="search"]');
    await page.type('input[type="search"]', "e2e");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const state = await page.evaluate(() => ({
      focused: document.activeElement === document.querySelector('input[type="search"]'),
      value: document.querySelector<HTMLInputElement>('input[type="search"]')?.value,
    }));
    expect(state).toEqual({ focused: true, value: "e2e" });
    expect(await page.$(thumbnail)).not.toBeNull(); // do not pass just because the fixture disappeared
    await page.close();
  }, 60_000);

  it("the home thumbnail cannot focus or scroll the host, including after a re-render", async () => {
    const page = await englishPage(browser);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    const thumbnail = `iframe[src="/api/preview/${thiefSlug}?thumb=1"]`;
    await page.waitForSelector(thumbnail);
    const initialY = await page.evaluate(() => window.scrollY);
    await page.click('button[aria-label="More upload options"]');
    await page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
    expect(await page.evaluate(() => window.scrollY)).toBe(initialY);
    expect(await page.$eval(thumbnail, (frame) => ({ sandbox: frame.getAttribute("sandbox"), inert: frame.hasAttribute("inert") })))
      .toEqual({ sandbox: "", inert: true });
    await page.close();
  }, 60_000);
});

describe.skipIf(!baseUrl)("document viewer — real-browser E2E", () => {
  let puppeteer: typeof import("puppeteer-core");
  let browser: Browser;
  let slug: string;

  beforeAll(async () => {
    puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch(launchOptions);
    const form = new FormData();
    form.set("mode", "file");
    form.set("file", new File([buildPdf(120)], "e2e-120页.pdf"), "e2e-120页.pdf");
    const response = await fetch(`${baseUrl}/api/sites`, { method: "POST", body: form });
    if (!response.ok) throw new Error(`E2E site create failed: ${response.status} ${await response.text()}`);
    slug = (await response.json()).slug;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function openViewer(): Promise<Page> {
    const page = await englishPage(browser);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/api/preview/${slug}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page;
  }

  it("the deployed server extracts PDF text and indexes it for search", async () => {
    const response = await fetch(`${baseUrl}/api/sites/${slug}/text`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toContain("Page 120 of 120");
    expect(body.chars).toBeGreaterThan(0);
    const search = await fetch(`${baseUrl}/api/search?q=Page%20120`);
    expect(search.status).toBe(200);
    expect((await search.json()).results.map((site: { slug: string }) => site.slug)).toContain(slug);
  });

  it("windowed rendering: only near-viewport pages hold backing stores; scrolled-away pages release", async () => {
    const page = await openViewer();
    const top = await until<Snapshot>(
      () => page.evaluate(CLASSIFY) as Promise<Snapshot>,
      (s) => s.painted.length > 0,
      20_000,
    );
    expect(top.total).toBe(120);
    expect(top.pages).toBe("120 pages");
    expect(top.painted.length).toBeGreaterThan(0);
    expect(top.painted.length).toBeLessThanOrEqual(4); // viewport + 1.5 screens of lookahead
    expect(top.painted).toContain("1");

    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    const bottom = await until<Snapshot>(
      () => page.evaluate(CLASSIFY) as Promise<Snapshot>,
      (s) => s.painted.includes("120") && s.released.includes("1"),
      20_000,
    );
    expect(bottom.painted).toContain("120");
    expect(bottom.painted.length).toBeLessThanOrEqual(4);
    expect(bottom.released).toContain("1"); // the page that was painted at the top gave its store back
    await page.close();
  }, 60_000);

  it("watchdog: a stalled module import surfaces the fallback within 25s; a healthy load never does", async () => {
    const stalled = await englishPage(browser);
    await stalled.setViewport({ width: 1280, height: 900 });
    await stalled.setRequestInterception(true);
    stalled.on("request", (request) => {
      if (request.url().includes("pdf.min.mjs")) return; // stall: never respond, never abort
      request.continue().catch(() => {});
    });
    stalled.goto(`${baseUrl}/api/preview/${slug}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

    const healthy = await openViewer();

    const [stalledState, healthyState] = await Promise.all([
      until<Snapshot>(() => stalled.evaluate(CLASSIFY) as Promise<Snapshot>, (s) => s.err === "block", 27_000),
      until<Snapshot>(() => healthy.evaluate(CLASSIFY) as Promise<Snapshot>, (s) => s.painted.length > 0, 20_000),
    ]);
    expect(stalledState.err).toBe("block"); // the soft "download the original" notice, armed BEFORE the hung await
    expect(stalledState.painted.length).toBe(0);
    expect(healthyState.painted.length).toBeGreaterThan(0);
    expect(healthyState.err).not.toBe("block"); // no false alarm on the healthy path
    await stalled.close();
    await healthy.close();
  }, 70_000);

  it("Play mode: one page per screen, arrows page through, Esc returns to the scroll view", async () => {
    const page = await openViewer();
    await until<Snapshot>(() => page.evaluate(CLASSIFY) as Promise<Snapshot>, (s) => s.painted.length > 0, 20_000);

    await page.click("#play");
    const opened = await until(
      () => page.evaluate(`({
        hidden: document.getElementById("show").hidden,
        pg: document.getElementById("shpg").textContent,
        painted: (() => { const c = document.getElementById("slide"); if (!c.width) return false;
          const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 200)).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; })(),
      })`) as Promise<{ hidden: boolean; pg: string; painted: boolean }>,
      (s) => !s.hidden && s.painted && s.pg === "1 / 120",
      15_000,
    );
    expect(opened.pg).toBe("1 / 120");
    expect(opened.painted).toBe(true);

    await page.keyboard.press("ArrowRight");
    const advanced = await until(
      () => page.evaluate('document.getElementById("shpg").textContent') as Promise<string>,
      (pg) => pg === "2 / 120",
      10_000,
    );
    expect(advanced).toBe("2 / 120");

    await page.keyboard.press("Escape");
    const closed = await until(
      () => page.evaluate('document.getElementById("show").hidden') as Promise<boolean>,
      (hidden) => hidden === true,
      5_000,
    );
    expect(closed).toBe(true);
    await page.close();
  }, 60_000);

  it("?thumb renders a static poster — no PDF.js boot, no page canvases", async () => {
    const page = await englishPage(browser);
    await page.setViewport({ width: 400, height: 300 });
    const requests: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", (request) => { requests.push(request.url()); request.continue().catch(() => {}); });
    await page.goto(`${baseUrl}/api/preview/${slug}?thumb=1`, { waitUntil: "networkidle0", timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const state = (await page.evaluate(`({
      canvases: document.querySelectorAll("#stage canvas").length,
      poster: document.getElementById("stage").textContent.includes("e2e-120页.pdf"),
      barHidden: getComputedStyle(document.querySelector(".bar")).display === "none",
    })`)) as { canvases: number; poster: boolean; barHidden: boolean };
    expect(state.canvases).toBe(0); // the expensive path never started
    expect(state.poster).toBe(true);
    expect(state.barHidden).toBe(true);
    expect(requests.some((u) => u.includes("pdf.min.mjs"))).toBe(false); // zero library weight per thumbnail
    await page.close();
  }, 60_000);

  it("zero-width container: no oversized/negative canvases, and a later resize revives rendering", async () => {
    const page = await englishPage(browser);
    await page.setViewport({ width: 1280, height: 900 });
    // Reproduce the product embedding exactly: sandboxed iframe, no allow-same-origin.
    await page.setContent(`<iframe id="f" style="width:0;height:600px;border:0"
      sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads"
      src="${baseUrl}/api/preview/${slug}"></iframe>`, { waitUntil: "domcontentloaded" });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const frame = page.frames().find((f) => f.url().includes(slug));
    expect(frame).toBeTruthy();
    const collapsed = (await frame!.evaluate(CLASSIFY)) as Snapshot;
    expect(collapsed.painted.length).toBe(0); // nothing painted at width 0 — and nothing exploded
    expect(collapsed.err).not.toBe("block");

    await page.evaluate('document.getElementById("f").style.width = "900px"');
    const revived = await until<Snapshot>(
      () => frame!.evaluate(CLASSIFY) as Promise<Snapshot>,
      (s) => s.painted.length > 0,
      15_000,
    );
    expect(revived.painted.length).toBeGreaterThan(0); // the resize listener re-rendered
    await page.close();
  }, 60_000);
});
