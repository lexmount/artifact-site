import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_NOTE_MS } from "@/components/site-version-watcher";
import { injectPreviewBootstrap, PREVIEW_SANDBOX_CSP } from "@/lib/preview";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!process.env.E2E_CHROME)("version notice lifecycle and dismissal", () => {
  let browser: Browser, page: Page, server: Server, base: string;
  beforeAll(async () => {
    const output = await build({ configFile: false, logLevel: "silent",
      resolve: { alias: { "@": path.resolve("src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": "{}" },
      build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/site-version-watcher.tsx"), name: "VersionWatcherFixture", formats: ["iife"] } },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    server = createServer((req, res) => {
      if (req.url === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(code); }
      else if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/app/globals.css")); }
      else if (req.url?.startsWith("/api/preview/")) {
        res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", PREVIEW_SANDBOX_CSP);
        res.end(injectPreviewBootstrap('<html><head></head><body><button id="artifact" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Read the artifact</button></body></html>', `${base}/api/preview/fixture/`));
      } else if (req.url?.endsWith("/versions")) { res.setHeader("content-type", "application/json"); res.end('{"currentVersionId":"v2"}'); }
      else { res.setHeader("content-type", "text/html"); res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  }, 60_000);
  beforeEach(async () => {
    page = await browser.newPage(); page.setDefaultTimeout(2000);
    await page.setViewport({ width: 1280, height: 800 });
    await open();
  });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function open(query = "") {
    await page.goto(`${base}/${query}`);
    await page.waitForFunction(() => Boolean(window.watcherFixture));
  }
  async function announce(id = "v2") {
    await page.evaluate(id => window.watcherFixture.announce(id), id);
    await page.waitForSelector(".version-toast");
  }
  async function dismissed() { await page.waitForSelector(".version-toast", { hidden: true }); }

  it("expires even when refreshed server props replace the version subscription", async () => {
    await announce();
    await page.evaluate(() => window.watcherFixture.renderVersion("v2"));
    await pause(AUTO_NOTE_MS + 200);
    expect(await page.$(".version-toast")).toBeNull();
  });
  it("dismisses on an outside click without reappearing for the same update", async () => {
    await announce(); await page.click("#outside"); await dismissed();
    await page.evaluate(() => window.watcherFixture.setAutomatic(false));
    await pause(50);
    await page.evaluate(() => window.watcherFixture.announce("v2"));
    await pause(50);
    expect(await page.$(".version-toast")).toBeNull();
    await announce("v3");
  });
  it.each([false, true])("dismisses on a preview click, including existing iframe focus (%s)", async focused => {
    const frame = (await (await page.$("iframe"))!.contentFrame())!;
    await frame.waitForSelector("#artifact");
    if (focused) await frame.click("#artifact");
    await announce(); await frame.click("#artifact"); await dismissed();
    expect(await frame.$eval("#artifact", el => el.getAttribute("data-clicks"))).toBe(focused ? "2" : "1");
  });
  it("dismisses on a mobile preview tap without consuming the artifact action", async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await open("?reader");
    const frame = (await (await page.$("iframe"))!.contentFrame())!;
    await frame.waitForSelector("#artifact");
    await frame.tap("#artifact");
    await announce(); await frame.tap("#artifact"); await dismissed();
    expect(await frame.$eval("#artifact", el => el.getAttribute("data-clicks"))).toBe("2");
  });
  it("dismisses on Escape while keyboard focus remains inside the preview", async () => {
    const frame = (await (await page.$("iframe"))!.contentFrame())!;
    await frame.waitForSelector("#artifact"); await frame.click("#artifact");
    await announce(); await page.keyboard.press("Escape"); await dismissed();
  });
  it("keeps inside clicks and a blocked refresh usable, with explicit and keyboard dismissal", async () => {
    await open("?reader"); await announce();
    await page.click(".version-toast span");
    expect(await page.$(".version-toast")).not.toBeNull();
    await page.evaluate(() => { window.watcherFixture.blocked = true; });
    await page.click(".version-toast .solid");
    expect(await page.evaluate(() => window.watcherFixture.refreshes)).toBe(1);
    expect(await page.$(".version-toast")).not.toBeNull();
    await page.evaluate(() => { window.watcherFixture.blocked = false; });
    await page.click(".version-toast .solid"); await dismissed();
    await announce("v3"); await page.keyboard.press("Escape"); await dismissed();
    await announce("v4"); await page.click('.version-toast [aria-label="Dismiss"]'); await dismissed();
  });
  it("does not expire a deferred update with an earlier success timer", async () => {
    await announce();
    await page.evaluate(() => { window.watcherFixture.blocked = true; });
    await announce("v3"); await pause(AUTO_NOTE_MS + 200);
    expect(await page.$(".version-toast .solid")).not.toBeNull();
    await page.evaluate(() => window.dispatchEvent(new Event("artifact:refresh-applied")));
    await dismissed();
  });
  it("ignores preview messages from unrelated windows", async () => {
    await announce();
    await page.evaluate(() => window.postMessage({ type: "artifact:preview-interaction" }, location.origin));
    await pause(50);
    expect(await page.$(".version-toast")).not.toBeNull();
  });
  it("fits desktop and narrow mobile notices in both languages", async () => {
    const output = process.env.VERSION_NOTICE_SCREENSHOTS;
    if (output) mkdirSync(output, { recursive: true });
    for (const [width, query] of [[1280, "?zh"], [320, "?reader"]] as const) {
      await page.setViewport({ width, height: 800 }); await open(query); await announce();
      const box = await page.$eval(".version-toast", el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
      if (output) await page.screenshot({ path: path.join(output, `version-notice-${width}.png`) });
    }
  });
});
