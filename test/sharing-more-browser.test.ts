import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

describe.skipIf(!process.env.E2E_CHROME)("sharing menu activation and focus", () => {
  let browser: Browser, page: Page, server: Server, base: string;
  const trigger = '.sharing-more > button';
  const items = '.sharing-more-menu [role="menuitem"]';

  beforeAll(async () => {
    const output = await build({ configFile: false, logLevel: "silent",
      resolve: { alias: { "@": path.resolve("src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH": JSON.stringify("") },
      build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/sharing-more-browser.tsx"), name: "SharingMenuFixture", formats: ["iife"] } },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    server = createServer((req, res) => {
      if (req.url === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(code); }
      else if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/app/globals.css")); }
      else { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage();
    page.setDefaultTimeout(2000);
  }, 60_000);
  beforeEach(async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(base);
    await page.waitForSelector("dialog:modal");
  });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function open() {
    await page.tap(trigger);
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, items);
  }

  it.each([
    ["members", "none"], ["links", "none"],
    ["members", "dialog"], ["links", "dialog"],
  ])("activates %s when a touch moves focus to %s before click", async (action, destination) => {
    await open();
    // WebKit buttons need not take pointer focus. Focus can fall back to the
    // modal or nowhere before the compatibility click, without leaving the menu.
    await page.evaluate(destination => {
      document.addEventListener("mousedown", event => {
        if (!(event.target as Element).closest('[role="menuitem"]')) return;
        event.preventDefault();
        if (destination === "dialog") document.querySelector("dialog")!.focus();
        else (document.activeElement as HTMLElement).blur();
      }, { capture: true, once: true });
    }, destination);
    await page.tap(`${items}:nth-child(${action === "members" ? 1 : 2}) svg`);
    expect(await page.$eval("#selected", el => el.textContent)).toBe(action);
    expect(await page.$(".sharing-more-menu")).toBeNull();
  });

  it("activates both actions with ordinary touch input", async () => {
    for (const [index, action] of [[1, "members"], [2, "links"]] as const) {
      await open();
      await page.tap(`${items}:nth-child(${index})`);
      expect(await page.$eval("#selected", el => el.textContent)).toBe(action);
      expect(await page.$(".sharing-more-menu")).toBeNull();
    }
  });

  it("dismisses on an outside tap even when it does not move focus", async () => {
    await open();
    await page.tap("#outside-text");
    expect(await page.$(".sharing-more-menu")).toBeNull();
    expect(await page.$eval("#selected", el => el.textContent)).toBe("");
  });

  it("dismisses on outside focus after a cancelled touch", async () => {
    await open();
    await page.evaluate(() => {
      const item = document.querySelector('[role="menuitem"]')!;
      item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      item.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch" }));
      document.getElementById("outside")!.focus();
    });
    expect(await page.$(".sharing-more-menu")).toBeNull();
    expect(await page.$eval("#selected", el => el.textContent)).toBe("");
  });

  it("preserves keyboard navigation, activation and dismissal", async () => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.focus(trigger);
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, items);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    expect(await page.$eval("#selected", el => el.textContent)).toBe("links");
    expect(await page.$eval(trigger, el => el === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(selector => document.activeElement === document.querySelector(`${selector}:last-child`), {}, items);
    await page.keyboard.press("Escape");
    expect(await page.$(".sharing-more-menu")).toBeNull();
    expect(await page.$("dialog:modal")).not.toBeNull();
    expect(await page.$eval(trigger, el => el === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(selector => document.activeElement === document.querySelector(`${selector}:last-child`), {}, items);
    await page.keyboard.press("Tab");
    expect(await page.$(".sharing-more-menu")).toBeNull();
    expect(await page.$eval("#outside", el => el === document.activeElement)).toBe(true);
  });
});
