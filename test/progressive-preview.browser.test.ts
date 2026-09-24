import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import path from "node:path";

describe.skipIf(!process.env.E2E_CHROME)("preview eligibility regressions", () => {
  let browser: Browser, server: Server, base: string;
  let requests = 0;
  beforeAll(async () => {
    const output = await build({configFile:false,logLevel:"silent",resolve:{alias:{"@":path.resolve("src")}},
      define:{"process.env.NODE_ENV":JSON.stringify("development")},
      build:{write:false,lib:{entry:path.resolve("test/fixtures/progressive-preview.tsx"),name:"Fixture",formats:["iife"]}}});
    const bundle = (Array.isArray(output) ? output[0] : output) as {output:{type:string;code?:string}[]};
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    server = createServer((req,res) => {
      if (req.url === "/bundle.js") { res.setHeader("content-type","text/javascript"); res.end(code); }
      else if (req.url === "/content") { requests++; res.setHeader("content-type","text/html"); res.end("<h1>Preview</h1>"); }
      else { res.setHeader("content-type","text/html"); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    browser = await puppeteer.launch({executablePath:process.env.E2E_CHROME,headless:true,args:process.env.CI?["--no-sandbox"]:[]});
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  it("restarts restored previews from cover after taking down a loaded artifact", async () => {
    const page = await browser.newPage(); requests = 0;
    try {
      await page.goto(base);
      await page.waitForSelector('[data-preview-state="ready"] iframe');
      await page.click('#remove');
      await page.waitForSelector('[data-preview-state="cover"]');
      expect(await page.$('iframe')).toBeNull();
      await new Promise(resolve => setTimeout(resolve,1800));
      expect(requests).toBe(1);
      await page.click('#restore');
      expect(await page.$('iframe')).toBeNull();
      expect(await page.$eval('.progressive-preview', e => e.getAttribute('data-preview-state'))).toBe('cover');
      await new Promise(resolve => setTimeout(resolve,500));
      expect(requests).toBe(1);
      await page.waitForSelector('[data-preview-state="ready"] iframe');
      expect(requests).toBe(2);
    } finally { await page.close(); }
  });
  it("never requests a known taken-down artifact", async () => {
    const page = await browser.newPage(); requests = 0;
    try {
      await page.goto(`${base}/?removed`);
      await page.waitForSelector('.artifact-cover');
      await new Promise(resolve => setTimeout(resolve,1800));
      expect(requests).toBe(0);
      expect(await page.$('iframe')).toBeNull();
    } finally { await page.close(); }
  });
  it("uses the newest visibility record in a batched observer callback", async () => {
    const page = await browser.newPage(); requests = 0;
    try {
      await page.evaluateOnNewDocument(() => {
        window.IntersectionObserver = class {
          constructor(private callback: IntersectionObserverCallback) {}
          observe(target: Element) {
            const emit = (values: boolean[]) => this.callback(values.map(isIntersecting => ({target,isIntersecting}) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
            window.addEventListener('enter-preview', () => emit([false,true]));
            emit([true,false]);
          }
          disconnect() {}
        } as unknown as typeof IntersectionObserver;
      });
      await page.goto(base);
      await page.waitForSelector('.artifact-cover');
      await new Promise(resolve => setTimeout(resolve,1800));
      expect(requests).toBe(0);
      await page.evaluate(() => window.dispatchEvent(new Event('enter-preview')));
      await page.waitForSelector('[data-preview-state="ready"] iframe');
      expect(requests).toBe(1);
    } finally { await page.close(); }
  });
});
