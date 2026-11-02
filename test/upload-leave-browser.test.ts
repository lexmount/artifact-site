import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

// E2E_CHROME=/path/to/chrome npx vitest run test/more-menu-browser.test.ts
// Real layout is required: a DOM shim cannot reproduce shrink-to-fit feedback on opening.
describe.skipIf(!process.env.E2E_CHROME)("Upload leave guard", () => {
  let browser: Browser;
  let server: Server;
  let page: Page;

  beforeAll(async () => {
    const output = await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@": path.resolve("src"), "next/navigation": path.resolve("test/fixtures/upload-router.ts") } },
      define: { "process.env": "{}", "process.env.NODE_ENV": JSON.stringify("development"), "process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH": JSON.stringify("") },
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve("test/fixtures/upload-leave-browser.tsx"), name: "MenuFixture", formats: ["iife"] },
      },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find((item) => item.type === "chunk")!.code!;
    const css = readFileSync("src/app/globals.css", "utf8");
    server = createServer((req, res) => {
      if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(code); }
      else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
      else { res.setHeader("Content-Type", "text/html"); res.end('<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error));
    await page.setViewport({ width: 800, height: 600 });
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForSelector('#start');
  }, 60_000);

  beforeEach(async () => {
    const home = new URL("/", page.url()).href;
    await page.close(); page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(home);
    await page.waitForSelector('#start');
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });


  it.each([["queued", "new"], ["completed", "new"], ["queued", "recover"], ["completed", "dismiss"]])("requires explicit recovery of a size-only %s job (%s)", async (status, action) => {
    await page.goto(new URL(`/uploader?status=${status}`, page.url()).href);
    await page.waitForSelector('input[type="file"]');
    await page.evaluate(() => {
      localStorage.setItem('archive-upload::test:server-verified:3:["",false,"report.zip"]', "old");
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const data = new DataTransfer(); data.items.add(new File(["new"], "report.zip")); input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForSelector(".upload-confirmation[open]");
    await page.click(".upload-confirmation .solid");
    await page.waitForSelector(".action-confirmation[open]");
    expect(await page.$eval(".action-confirmation", el => el.textContent)).toContain("无法确认");
    expect(await page.evaluate(() => document.body.dataset.newUpload)).toBeUndefined();
    if (action === "new") {
      await page.click('.action-confirmation button[type="button"]');
      await page.waitForFunction(() => document.body.dataset.newUpload === "true");
    } else {
      if (action === "recover") await page.click('.action-confirmation button[type="submit"]');
      else await page.keyboard.press("Escape");
      await page.waitForSelector(".action-confirmation", { hidden: true });
      await page.waitForSelector(".upload-leave-hint", { hidden: true });
      expect(await page.evaluate(() => document.body.dataset.newUpload)).toBeUndefined();
      expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("archive-upload:")))).toBe(action === "dismiss");
    }
  });
  it("confirms same-tab links, preserves uploads on Escape, and fits desktop/mobile", async () => {
    await page.click("#start");
    await page.click("#navigate");
    await page.waitForSelector("dialog[open]");
    expect(await page.$eval("dialog button", el => document.activeElement === el)).toBe(true);
    for (const width of [1100, 390]) {
      await page.setViewport({ width, height: 800 });
      expect(await page.$eval("dialog", el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/upload-leave-${width}.png` });
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog", { hidden: true });
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.$(".upload-leave-hint")).toBeTruthy();
    await page.click("#background");
    await page.click("#navigate");
    await page.waitForFunction(() => location.pathname === "/next");
  });
  it("clears a pending leave dialog when processing starts", async () => {
    await page.click("#start"); await page.click("#navigate");
    await page.waitForSelector("dialog[open]");
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#background")!.click());
    await page.waitForSelector("dialog", { hidden: true });
    await page.click("#start");
    expect(await page.$("dialog[open]")).toBeNull();
    await page.click("#failed");
  });
  it("warns on refresh only while transferring and releases after failure", async () => {
    await page.click("#start");
    const warning = new Promise<string>(resolve => page.once("dialog", async dialog => { resolve(dialog.type()); await dialog.dismiss(); }));
    void page.reload().catch(() => {});
    expect(await warning).toBe("beforeunload");
    await page.click("#failed");
    await page.reload();
    await page.waitForSelector("#start");
  });
  it.each(["back", "forward"] as const)("preserves history when confirming %s", async direction => {
    const snapshot = () => page.evaluate(() => {
      const navigation = (window as unknown as { navigation: { currentEntry: { index: number }; entries(): { key: string; url: string }[] } }).navigation;
      return { index: navigation.currentEntry.index, entries: navigation.entries().map(({ key, url }) => ({ key, url })) };
    });
    await page.evaluate(() => { history.pushState({}, "", "/upload"); history.pushState({}, "", "/later"); history.back(); });
    await page.waitForFunction(() => location.pathname === "/upload");
    const before = await snapshot();
    await page.click("#start");
    await page.evaluate(direction => history[direction](), direction);
    await page.waitForSelector("dialog[open]");
    expect(await snapshot()).toEqual(before);
    await page.click('dialog button[type="submit"]');
    const target = direction === "back" ? "/" : "/later";
    await page.waitForFunction(target => location.pathname === target, {}, target);
    expect(await snapshot()).toEqual({ entries: before.entries, index: before.index + (direction === "back" ? -1 : 1) });
    await page.evaluate(direction => history[direction === "back" ? "forward" : "back"](), direction);
    await page.waitForFunction(() => location.pathname === "/upload");
    expect(await snapshot()).toEqual(before);
    await page.evaluate(direction => history[direction](), direction);
    await page.waitForFunction(target => location.pathname === target, {}, target);
    expect((await snapshot()).entries).toEqual(before.entries);
  });
});
