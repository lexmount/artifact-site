import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Frame, Page } from "puppeteer-core";
import { injectPreviewBootstrap, injectVisualEditor, PREVIEW_SANDBOX_CSP } from "@/lib/preview";

describe.skipIf(!process.env.E2E_CHROME)("native fragment navigation in opaque previews", () => {
  let browser: Browser, server: Server, origin: string;
  let requests = 0;
  function html(editor = false) {
    const source = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin:0 } nav { position:fixed; top:0 } section { height:900px }
    </style></head><body><nav><a id="link" href="#安装">jump</a></nav>
    <input id="draft"><section>start</section>
    <input name="安装"><section>middle</section>
    <a name="安装" id="named"></a><section>end</section>
    <script>window.marker=Math.random(); window.hashEvents=0;
    addEventListener('hashchange',()=>window.hashEvents++);</script></body></html>`;
    const base = `${origin}/api/preview/site~credential/`;
    return editor ? injectVisualEditor(source, base, "test-nonce") : injectPreviewBootstrap(source, base);
  }
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url?.startsWith("/api/preview/")) {
        requests++;
        res.setHeader("content-security-policy", PREVIEW_SANDBOX_CSP);
        res.end(html());
      } else res.end('<!doctype html><title>Preview test</title>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function open(srcdoc = false, editor = false): Promise<{ page: Page; frame: Frame }> {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.evaluate(({ html, srcdoc }) => {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "width:800px;height:500px";
      if (srcdoc) f.srcdoc = html;
      else f.src = "/api/preview/site/nested/page.html?v=old&r=1";
      document.body.append(f);
    }, { html: html(editor), srcdoc });
    const element = await page.waitForSelector("iframe");
    const frame = (await element!.contentFrame())!;
    await frame.waitForSelector("#link");
    return { page, frame };
  }
  async function settled(frame: Frame) {
    await frame.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  }
  it.each([false, true])("preserves document state and repeat targeting (srcdoc=%s)", async srcdoc => {
    const { page, frame } = await open(srcdoc);
    try {
      const initial = await frame.evaluate(() => {
        (document.querySelector("#draft") as HTMLInputElement).value = "unsaved";
        return { time: performance.timeOrigin, url: location.href };
      });
      const before = requests;
      await frame.click("#link");
      await settled(frame);
      expect(await frame.$eval("#named", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
      await frame.evaluate(() => scrollTo(0, 300));
      await frame.click("#link");
      await settled(frame);
      expect(await frame.$eval("#named", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
      expect(await frame.evaluate(() => performance.timeOrigin)).toBe(initial.time);
      expect(await frame.$eval("#draft", el => (el as HTMLInputElement).value)).toBe("unsaved");
      expect(frame.url().split("#")[0]).toBe(initial.url);
      expect(requests).toBe(before);
    } finally { await page.close(); }
  });
  it("allows a later window listener to cancel navigation", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => window.addEventListener("click", e => {
        if ((e.target as Element).closest('a[href^="#"]')) e.preventDefault();
      }));
      await frame.click("#link"); await settled(frame);
      expect(await frame.evaluate(() => location.hash)).toBe("");
      expect(await frame.evaluate(() => scrollY)).toBe(0);
    } finally { await page.close(); }
  });
  it("restores authored href before native history handlers update the TOC", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => {
        document.querySelector("#named")!.id = "target";
        document.querySelector("#link")!.setAttribute("href", "#target");
        for (const type of ["popstate", "hashchange"]) {
          window.addEventListener(type, () => {
            const link = document.querySelector("#link")!;
            link.classList.toggle(type, link.getAttribute("href") === location.hash);
            link.setAttribute(`data-${type}`, link.getAttribute("href")!);
          }, true);
        }
      });
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#link", el => el.getAttribute("data-popstate"))).toBe("#target");
      expect(await frame.$eval("#link", el => el.getAttribute("data-hashchange"))).toBe("#target");
      expect(await frame.$eval("#link", el => el.classList.contains("popstate") && el.classList.contains("hashchange"))).toBe(true);
      expect(await frame.$eval("#target", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
    } finally { await page.close(); }
  });
  it("survives stopPropagation without reloading", async () => {
    const { page, frame } = await open();
    try {
      await frame.$eval("#link", el => el.addEventListener("click", e => e.stopPropagation()));
      const before = requests;
      await frame.click("#link"); await settled(frame);
      expect(requests).toBe(before);
      expect(frame.url()).toContain("nested/page.html?v=old&r=1#");
    } finally { await page.close(); }
  });
  it("does not restore again over an intentional history-handler href change", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => window.addEventListener("popstate", () => {
        document.querySelector("#link")!.setAttribute("href", location.href);
      }));
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#link", el => el.getAttribute("href"))).toBe(frame.url());
    } finally { await page.close(); }
  });
  it("supports the actual visual editor srcDoc while blocking navigation away", async () => {
    const { page, frame } = await open(true, true);
    try {
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#named", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
      const url = frame.url();
      await frame.$eval("#link", el => el.setAttribute("href", "/elsewhere"));
      await frame.click("#link"); await settled(frame);
      expect(frame.url()).toBe(url);
    } finally { await page.close(); }
  });
  it.each(["#", "#top", "#TOP", "#%74op"])("preserves native top navigation for %s", async href => {
    const { page, frame } = await open();
    try {
      await frame.$eval("#link", (el, href) => el.setAttribute("href", href), href);
      for (let i = 0; i < 2; i++) {
        await frame.evaluate(() => scrollTo(0, 500));
        await frame.click("#link"); await settled(frame);
        expect(await frame.evaluate(() => scrollY)).toBe(0);
      }
    } finally { await page.close(); }
  });
  it("reveals collapsed content and preserves keyboard focus and :target", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => {
        const d = document.createElement("details");
        d.innerHTML = '<summary>Hidden</summary><button id="target">Target</button>';
        document.body.append(d);
        document.querySelector("#link")!.setAttribute("href", "#target");
      });
      await frame.focus("#link"); await page.keyboard.press("Enter"); await settled(frame);
      expect(await frame.$eval("details", el => el.open)).toBe(true);
      expect(await frame.evaluate(() => document.activeElement?.id)).toBe("target");
      expect(await frame.$eval(":target", el => el.id)).toBe("target");
    } finally { await page.close(); }
  });
  it("preserves artifact href changes and restores temporary URLs after cancellation", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => {
        window.addEventListener("click", e => e.preventDefault());
      });
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#link", el => el.getAttribute("href"))).toBe("#安装");
      await frame.$eval("#link", el => el.addEventListener("click", () => el.setAttribute("href", "#changed")));
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#link", el => el.getAttribute("href"))).toBe("#changed");
    } finally { await page.close(); }
  });
  it.each([
    ["#安装", "安装"], ["#some text", "some text"], ["#%zz", "%zz"],
    ["##second", "#second"], [" \t#space \n", "space"],
  ])("activates and repeats %s using native URL parsing", async (href, id) => {
    const { page, frame } = await open();
    try {
      await frame.$eval("#named", (el, id) => el.id = id, id);
      await frame.$eval("#link", (el, href) => el.setAttribute("href", href), href);
      for (let i = 0; i < 2; i++) {
        await frame.evaluate(() => scrollTo(0, 100));
        await frame.click("#link"); await settled(frame);
        expect(await frame.evaluate(id => Math.abs(document.getElementById(id)!.getBoundingClientRect().top), id)).toBeLessThan(2);
      }
    } finally { await page.close(); }
  });
  it.each(["target", "ancestor", "document-capture"])("respects stopped propagation at %s", async level => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(level => {
        const node = level === "target" ? document.querySelector("#link")! : level === "ancestor" ? document.querySelector("nav")! : document;
        node.addEventListener("click", event => event.stopPropagation(), level === "document-capture");
      }, level);
      const before = requests;
      await frame.click("#link"); await settled(frame);
      expect(await frame.$eval("#named", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
      expect(requests).toBe(before);
    } finally { await page.close(); }
  });
  it("preserves back/forward navigation and direct preview state", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/api/preview/site~credential/nested.html?v=old`);
      const before = requests;
      const time = await page.evaluate(() => performance.timeOrigin);
      await page.click("#link"); await settled(page.mainFrame());
      await page.$eval("#link", el => el.setAttribute("href", "#top"));
      await page.click("#link"); await settled(page.mainFrame());
      await page.goBack();
      expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe("#安装");
      await page.goForward();
      expect(await page.evaluate(() => location.hash)).toBe("#top");
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(time);
      expect(requests).toBe(before);
    } finally { await page.close(); }
  });
  it("keeps canceled stopped events canceled", async () => {
    const { page, frame } = await open();
    try {
      await frame.$eval("#link", el => el.addEventListener("click", e => {
        e.stopImmediatePropagation(); e.preventDefault();
      }));
      await frame.click("#link"); await settled(frame);
      expect(await frame.evaluate(() => location.hash)).toBe("");
      expect(await frame.$eval("#link", el => el.getAttribute("href"))).toBe("#安装");
    } finally { await page.close(); }
  });
  it("uses identical native target priority on first and repeated encoded links", async () => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(() => {
        document.querySelector("#named")!.id = "a";
        const raw = document.createElement("section"); raw.id = "%61";
        document.body.append(raw, document.createElement("section"));
        document.querySelector("#link")!.setAttribute("href", "#%61");
      });
      await frame.click("#link"); await settled(frame);
      const first = await frame.evaluate(() => scrollY);
      expect(first).toBeGreaterThan(900);
      await frame.evaluate(() => scrollTo(0, 100));
      await frame.click("#link"); await settled(frame);
      expect(await frame.evaluate(() => scrollY)).toBe(first);
    } finally { await page.close(); }
  });
  it.each(["svg", "area"])("handles native %s activation", async kind => {
    const { page, frame } = await open();
    try {
      await frame.evaluate(kind => {
        document.querySelector("nav")!.innerHTML = kind === "svg"
          ? '<svg width="100" height="40"><a href="#安装"><rect id="shape" width="100" height="40" fill="blue"/></a></svg>'
          : '<map name="m"><area shape="rect" coords="0,0,100,40" href="#安装"></map><img id="shape" width="100" height="40" usemap="#m" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'40\'/%3E">';
      }, kind);
      const before = requests;
      await frame.click("#shape"); await settled(frame);
      expect(await frame.$eval("#named", el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(2);
      expect(requests).toBe(before);
    } finally { await page.close(); }
  });
});
