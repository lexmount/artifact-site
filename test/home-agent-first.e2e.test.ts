import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";

const base = process.env.VIEWER_E2E_URL;
let browser: Browser;
let files: string;

describe.skipIf(!base)("agent-first home", () => {
  beforeAll(async () => {
    files = await mkdtemp(join(tmpdir(), "home-upload-"));
    await writeFile(join(files, "report.html"), "<h1>Direct picker acceptance</h1>");
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  });
  afterAll(async () => { await browser?.close(); if (files) await rm(files, { recursive: true, force: true }); });

  it("copies the same localized, deployment-aware prompt as the guide, with a manual fallback", async () => {
    for (const locale of ["en", "zh-CN"]) {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text; } } }));
      await page.goto(`${base}/?lang=${locale}`, { waitUntil: "networkidle0" });
      const button = await page.$(".home-copy-prompt");
      expect(button).not.toBeNull();
      await button!.scrollIntoView();
      const before = await button!.boundingBox();
      await button!.click();
      await page.waitForFunction(() => !!document.documentElement.dataset.copied);
      const prompt = await page.evaluate(() => document.documentElement.dataset.copied);
      expect(prompt).toContain(`${base}/for-agents.md`);
      expect(await button!.boundingBox()).toEqual(before);
      expect(await page.$eval(".home-copy-status", el => el.textContent)).toBe(locale === "en" ? "Copied" : "已复制");
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
      await button!.click();
      await page.waitForSelector("#agent-prompt-fallback");
      expect(await page.$eval("#agent-prompt-fallback", el => (el as HTMLTextAreaElement).value)).toBe(prompt);
      expect(await page.$eval("#agent-prompt-fallback", el => (el as HTMLTextAreaElement).selectionEnd - (el as HTMLTextAreaElement).selectionStart)).toBe(prompt!.length);
      await page.click('a[href$="/for-agents#cli"]');
      await page.waitForSelector('#tab-cli[aria-selected="true"]');
      await page.click("#tab-agent");
      expect(await page.$eval("#agent code", el => el.textContent)).toBe(prompt);
      await page.close();
    }
  });

  it.each([["en", 1440], ["zh-CN", 390]] as const)("opens the native file chooser directly by mouse and keyboard without expanding the page (%s, %i)", async (locale, width) => {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    await page.goto(`${base}/?lang=${locale}`, { waitUntil: "networkidle0" });
    let writes = 0;
    page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/sites") writes++; });
    const entry = 'button:has(.home-upload-label)';
    const before = await page.$eval(".hero", el => el.getBoundingClientRect().height);
    const [mouseChooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), page.click(entry)]);
    await mouseChooser.cancel();
    expect(await page.$(".hero-drop")).toBeNull();
    expect(await page.$eval(".hero", el => el.getBoundingClientRect().height)).toBe(before);
    await page.focus(entry);
    const [keyboardChooser] = await Promise.all([page.waitForFileChooser(), page.keyboard.press("Enter")]);
    await keyboardChooser.accept([join(files, "report.html")]);
    await page.waitForSelector("dialog.upload-confirmation[open]");
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.upload-confirmation", { hidden: true });
    expect(writes).toBe(0);
    expect(await page.$eval(".hero", el => el.getBoundingClientRect().height)).toBe(before);
    await page.close();
  });

  it("keeps secondary upload options and paste drafts available without the old drop zone", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/?lang=en`, { waitUntil: "networkidle0" });
    expect(await page.$('input[webkitdirectory]')).not.toBeNull();
    expect(await page.$('input[accept*=".tar.gz"]')).not.toBeNull();
    await page.click('button[aria-label="More upload options"]');
    expect(await page.$('.more-menu a[href$="/me?intent=update"]')).not.toBeNull();
    expect(await page.$('.more-menu a[draggable="true"]')).not.toBeNull();
    await page.click('::-p-text(Paste HTML)');
    await page.waitForSelector("#paste-html", { visible: true });
    await page.type("#paste-html", "<h1>Keep this draft</h1>");
    await page.click(".paste-panel .btn.ghost");
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["<h1>Hello</h1>"], "index.html", { type: "text/html" }));
      document.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
    });
    await page.waitForSelector(".page-drop", { visible: true });
    expect(await page.$(".hero-drop")).toBeNull();
    await page.evaluate(() => document.dispatchEvent(new DragEvent("dragleave", { bubbles: true })));
    await page.waitForSelector(".page-drop", { hidden: true });
    await page.click('button[aria-label="More upload options"]');
    await page.click('::-p-text(Paste HTML)');
    expect(await page.$eval("#paste-html", el => (el as HTMLTextAreaElement).value)).toBe("<h1>Keep this draft</h1>");
    await page.close();
  });

  it("shows upload failures inline and allows picking the same file again", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/?lang=en`, { waitUntil: "networkidle0" });
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/sites") {
        void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
      } else void req.continue();
    });
    const entry = 'button:has(.home-upload-label)';
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(entry)]);
    await chooser.accept([join(files, "report.html")]);
    await page.waitForSelector("dialog.upload-confirmation[open]");
    await page.click("dialog.upload-confirmation .btn.solid");
    await page.waitForSelector(".upload-error", { visible: true });
    expect(await page.$eval(".upload-error", el => el.textContent)).toContain("Temporarily unavailable");
    expect(await page.$eval(entry, el => (el as HTMLButtonElement).disabled)).toBe(false);
    const [retryChooser] = await Promise.all([page.waitForFileChooser(), page.click(entry)]);
    await retryChooser.accept([join(files, "report.html")]);
    await page.waitForSelector("dialog.upload-confirmation[open]");
    await page.keyboard.press("Escape");
    await page.close();
  });

  it("publishes pasted HTML through confirmation with the configured default visibility", async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.goto(`${base}/?lang=en`, { waitUntil: "networkidle0" });
    await page.click('button[aria-label="More upload options"]');
    await page.click('::-p-text(Paste HTML)');
    await page.type("#paste-title", "Homepage upload acceptance");
    await page.type("#paste-html", "<!doctype html><title>Homepage upload acceptance</title><h1>Hosted from the homepage</h1>");
    await page.click(".paste-panel .btn.solid");
    await page.waitForSelector("dialog.upload-confirmation[open]");
    const published = page.waitForResponse(response => response.url().endsWith("/api/sites") && response.request().method() === "POST");
    await page.click("dialog.upload-confirmation .btn.solid");
    const response = await published;
    expect(response.ok()).toBe(true);
    const artifact = await response.json();
    expect(artifact.visibility).toBe(process.env.HOME_E2E_DEFAULT_VISIBILITY || "private");
    await page.waitForSelector("iframe.fs-frame");
    expect(page.url()).toContain(`/s/${artifact.slug}`);
    const frame = await (await page.$("iframe.fs-frame"))!.contentFrame();
    await frame!.waitForSelector("h1");
    expect(await frame!.$eval("h1", el => el.textContent)).toBe("Hosted from the homepage");
    await context.close();
  });

  it("fits both languages and keeps navigation selection, hover and focus distinct", async () => {
    for (const locale of ["en", "zh-CN"]) {
      const page = await browser.newPage();
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewport({ width, height: 900 });
        await page.goto(`${base}/?lang=${locale}`, { waitUntil: "networkidle0" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const selected = '.site-header nav a[aria-current="page"]';
        const styles = await page.$eval(selected, el => ({ bg: getComputedStyle(el).backgroundColor, line: getComputedStyle(el).textDecorationLine, after: getComputedStyle(el, "::after").content }));
        expect(styles.bg).toBe("rgb(228, 237, 200)");
        expect(styles.line).toBe("none");
        expect(styles.after).toBe("none");
        await page.hover(selected);
        expect(await page.$eval(selected, el => getComputedStyle(el).textDecorationLine)).toBe("none");
        await page.hover('.site-header nav a[href$="/explore"]');
        await page.waitForFunction(() => {
          const link = document.querySelector('.site-header nav a[href$="/explore"]');
          return link && getComputedStyle(link).backgroundColor === "rgb(243, 245, 239)";
        });
        await page.keyboard.press("Tab");
        await page.focus(selected);
        expect(await page.$eval(selected, el => getComputedStyle(el).outlineStyle)).toBe("solid");
        expect(await page.$('a[href$="/for-agents#cli"]')).not.toBeNull();
        if (process.env.E2E_ARTIFACT_DIR && [1440, 390].includes(width)) {
          await page.click("h1");
          mkdirSync(process.env.E2E_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.E2E_ARTIFACT_DIR, `home-${locale}-${width}.png`), fullPage: true });
        }
      }
      await page.close();
    }
  });
});
