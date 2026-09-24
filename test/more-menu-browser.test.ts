import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

// E2E_CHROME=/path/to/chrome npx vitest run test/more-menu-browser.test.ts
// Real layout is required: a DOM shim cannot reproduce shrink-to-fit feedback on opening.
describe.skipIf(!process.env.E2E_CHROME)("MoreMenu browser regressions", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;

  beforeAll(async () => {
    const output = await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@": path.resolve("src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve("test/fixtures/more-menu-browser.tsx"), name: "MenuFixture", formats: ["iife"] },
      },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find((item) => item.type === "chunk")!.code!;
    const css = readFileSync("src/app/globals.css", "utf8");
    server = createServer((req, res) => {
      if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(code); }
      else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
      else { res.setHeader("Content-Type", "text/html"); res.end('<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error));
    await page.setViewport({ width: 800, height: 600 });
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForSelector('[aria-label="Actions"]');
  }, 60_000);

  beforeEach(async () => {
    await page.setViewport({ width: 800, height: 600 });
    await page.reload();
    await page.waitForSelector('[aria-label="Actions"]');
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function open() {
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!;
      if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    });
    await page.waitForSelector('[role="menu"]:not([hidden])');
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
  }

  it("reaches its natural width before the first painted frame", async () => {
    const widths = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!.click();
      const menu = document.querySelector('[role="menu"]')!;
      const samples: number[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(menu.getBoundingClientRect().width);
      }
      return samples;
    });
    expect(widths[0]).toBeGreaterThan(250);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  });

  it("restores menu focus on outside scroll without scrolling the trigger into view", async () => {
    await open();
    await page.focus('[role="menuitem"]');
    await page.evaluate(() => {
      document.body.style.minHeight = "2000px";
      window.scrollTo({ top: 800, behavior: "instant" });
    });
    await page.waitForSelector('[role="menu"][hidden]');
    expect(await page.$eval('[aria-label="Actions"]', (el) => document.activeElement === el)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(800);
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, behavior: "instant" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
  });

  it("does not steal focus from outside the menu on scroll", async () => {
    await open();
    await page.focus("#outside");
    await page.evaluate(() => {
      document.body.style.minHeight = "2000px";
      window.scrollTo({ top: 800, behavior: "instant" });
    });
    await page.waitForSelector('[role="menu"][hidden]');
    expect(await page.$eval("#outside", (el) => document.activeElement === el)).toBe(true);
  });

  it("ignores a deferred scroll notification when the trigger has not moved", async () => {
    await open();
    const visible = await page.evaluate(async () => {
      // Simulate delivery of a scrollIntoView notification queued before opening.
      document.getElementById("trigger-rail")!.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return !document.querySelector<HTMLDivElement>('[role="menu"]')!.hidden;
    });
    expect(visible).toBe(true);
  });

  it("ignores scrolling in an unrelated panel", async () => {
    await open();
    const visible = await page.evaluate(async () => {
      const panel = document.createElement("div");
      panel.style.cssText = "position:fixed;top:0;left:0;width:100px;height:50px;overflow:auto";
      panel.innerHTML = '<div style="height:200px">Unrelated panel</div>';
      document.body.append(panel);
      await new Promise<void>((resolve) => {
        panel.addEventListener("scroll", () => resolve(), { once: true });
        panel.scrollTop = 40;
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return !document.querySelector<HTMLDivElement>('[role="menu"]')!.hidden;
    });
    expect(visible).toBe(true);
  });

  it("opens a horizontally off-screen trigger on mobile and closes when it moves again", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.$eval("#trigger-track", (el) => { (el as HTMLElement).style.width = "1200px"; });
    await page.click('[aria-label="Actions"]');
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(await page.$eval('[role="menu"]', (el) => !(el as HTMLElement).hidden)).toBe(true);
    expect(await page.$eval("#trigger-rail", (el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.$eval("#trigger-rail", (el) => { el.scrollLeft = 0; });
    await page.waitForSelector('[role="menu"][hidden]');
  });

  it("caps narrow menus while preserving the official-version minimum-width override", async () => {
    await page.setViewport({ width: 160, height: 600 });
    await open();
    const normal = await page.$eval('[role="menu"]', (menu) => ({
      width: menu.getBoundingClientRect().width,
      minWidth: getComputedStyle(menu).minWidth,
    }));
    expect(normal.width).toBeLessThanOrEqual(144);
    expect(normal.minWidth).toBe("144px");
    await page.$eval('[role="menuitem"]', (item) => item.classList.add("official-version-options"));
    const special = await page.$eval('[role="menu"]', (menu) => ({
      width: menu.getBoundingClientRect().width,
      minWidth: getComputedStyle(menu).minWidth,
    }));
    expect(special.width).toBeLessThanOrEqual(144);
    expect(special.minWidth).toBe("0px");
  });
});
