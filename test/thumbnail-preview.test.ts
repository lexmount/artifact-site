import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { bundledPdfViewer, refreshDocumentWrapper } from "@/lib/document-site";
import { staticThumbnail } from "@/lib/thumbnail-preview";
import { closeDbForTests } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { GET } from "@/app/api/preview/[slug]/[[...path]]/route";

const thumbnailFixture = `<!doctype html><html><head><style>h1{color:rgb(255, 0, 0)}</style><script>localStorage.getItem('x')</script><script src="app.js"></script><link rel="modulepreload" href="app.js"></head><body onload="throw Error('event')"><h1>Static preview</h1><noscript>&lt;script&gt;probe()&lt;/script&gt;</noscript><svg onload="alert(1)"><script>alert(1)</script></svg><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="child.html"></object><meta http-equiv="refresh" content="0;url=child.html"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onerror="alert(1)"></body></html>`;
afterEach(async () => { await closeDbForTests(); delete process.env.ARTIFACT_DEFAULT_VISIBILITY; });
it("serves script-free thumbnails while retaining the full viewer and sandbox CSP", async () => {
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
  const { site } = await createSite({ mode: "paste", html: thumbnailFixture }, {});
  const get = (query: string) => GET(new Request(`https://preview.test/api/preview/${site.slug}${query}`), { params: Promise.resolve({ slug: site.slug }) });
  const normal = await get("");
  const thumb = await get("?thumb=1");
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("content-security-policy")).toBe(normal.headers.get("content-security-policy"));
  const html = await thumb.text();
  expect(html).toContain("Static preview");
  expect(html).toContain("<style>");
  expect(html).toContain("<base href=");
  expect(html).not.toMatch(/<script|onload=|onerror=|<iframe|<object|http-equiv|modulepreload/i);
  expect(await normal.text()).toContain("localStorage.getItem");
});

it("removes executable markup from malformed HTML, templates, and noscript", () => {
  const html = staticThumbnail('<noscript><script>alert(1)</script><b>Fallback</b></noscript><template><SCRIPT src="x"></SCRIPT></template><a href="java&#x09;script:alert(1)" onclick="alert(1)">link</a>');
  expect(html).not.toMatch(/<script|onclick|javascript/i);
  expect(html).toContain("Fallback");
  expect(html).toContain(">link</a>");
});

it.skipIf(process.env.THUMBNAIL_BROWSER !== "1")("renders the route response in Chrome without sandbox console errors", async () => {
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
  const { site } = await createSite({ mode: "paste", html: thumbnailFixture }, {});
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/preview/")) {
      const response = await GET(new Request(`http://127.0.0.1${req.url}`), { params: Promise.resolve({ slug: site.slug }) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } else {
      res.setHeader("content-type", "text/html");
      res.end(`<iframe sandbox="" src="/api/preview/${site.slug}?__artifact_thumb=1"></iframe>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const session = await page.createCDPSession();
    await session.send("Log.enable");
    session.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error") errors.push(entry.text); });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });
    const frame = page.frames().find(f => f.url().includes("/api/preview/"))!;
    expect(await frame.$eval("h1", el => el.textContent)).toBe("Static preview");
    expect(await frame.$eval("h1", el => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
    expect(await page.$eval("iframe", el => el.getAttribute("sandbox"))).toBe("");
    expect(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
    expect(await frame.$eval("noscript", el => el.textContent)).toBe("<script>probe()</script>");
    expect(await frame.$$("script")).toHaveLength(0);
    expect(errors).toEqual([]);
    // Verify the same browser instrumentation detects the original regression.
    await page.$eval("iframe", el => { el.src = el.src.split("?")[0]; });
    await page.waitForNetworkIdle();
    expect(errors.some(error => error.includes("Blocked script execution"))).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("preserves escaped noscript text across a static round trip", () => {
  const html = staticThumbnail('<body><noscript>&lt;script&gt;probe()&lt;/script&gt;</noscript></body>');
  expect(html).toContain("&lt;script&gt;probe()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

it("renders a document poster on the server before scripts are removed", () => {
  const html = staticThumbnail(refreshDocumentWrapper(bundledPdfViewer('report<&.pdf'), true)!);
  expect(html).toContain('id="stage"><div');
  expect(html).toContain('report&lt;&amp;.pdf');
  expect(html).toContain('.bar{display:none}');
  expect(html).not.toContain('<script');
});

it.each(["thumb=1", "__artifact_thumb=1"])("serves the PDF poster through the route for %s", async query => {
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
  const { site } = await createSite({ mode: "file", filename: "report.pdf", bytes: new TextEncoder().encode("%PDF-1.7 fake") }, {});
  const response = await GET(new Request(`https://preview.test/api/preview/${site.slug}?${query}`), { params: Promise.resolve({ slug: site.slug }) });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('id="stage"><div');
  expect(html).toContain('report.pdf');
  expect(html).toContain('.bar{display:none}');
  expect(html).not.toContain('<script');
});
