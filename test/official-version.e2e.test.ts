// Real Chromium acceptance against a disposable server; never runs against an implicit deployment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page, HTTPRequest } from "puppeteer-core";

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


const base = process.env.VIEWER_E2E_URL;
describe.skipIf(!base)("official version browser acceptance", () => {
  let browser: Browser, page: Page, dir: string;
  beforeAll(async () => {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    dir = await mkdtemp(path.join(tmpdir(), "official-browser-"));
    await writeFile(path.join(dir, "report.html"), "<!doctype html><html><head><title>Official acceptance</title></head><body><h1>First report</h1><p>The first immutable snapshot.</p></body></html>");
    await mkdir("test-results/official", { recursive: true });
  });
  afterAll(async () => { await browser?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
  async function shot(name: string) { await page.screenshot({ path: `test-results/official/${name}.png`, fullPage: true }); }
  async function clickText(text: string) {
    await page.waitForFunction(value => [...document.querySelectorAll("button")].some(b => b.textContent?.trim() === value && !b.disabled), {}, text);
    await page.evaluate(value => { const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === value && !b.disabled); button!.click(); }, text);
  }
  async function frameText(expected: string) {
    await page.waitForFunction(() => !!document.querySelector("iframe.fs-frame"));
    const el = await page.$("iframe.fs-frame");
    const frame = await el!.contentFrame();
    await frame!.waitForFunction(value => document.body.textContent?.includes(value), {}, expected);
  }
  it("keeps upload geometry, cancels without a write, and preserves formal history while latest advances", async () => {
    await page.goto(base!, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[type=file]");
    const box = await page.$(".hero-upload, .dropzone");
    const before = await box!.boundingBox();
    let writes = 0;
    page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/sites") writes++; });
    const input = await page.$("input[type=file]:not([webkitdirectory])");
    await input!.uploadFile(path.join(dir, "report.html"));
    await page.waitForSelector("dialog[open]");
    const during = await box!.boundingBox();
    expect(during!.width).toBe(before!.width);
    expect(during!.height).toBe(before!.height);
    await shot("upload-confirmation");
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog[open]", { hidden: true });
    expect(writes).toBe(0);
    await input!.uploadFile(path.join(dir, "report.html"));
    await page.waitForSelector("dialog[open]");
    await page.click("dialog input[type=checkbox]");
    await Promise.all([page.waitForFunction(() => location.pathname.startsWith("/s/")), page.click("dialog .solid")]);
    const slug = new URL(page.url()).pathname.split("/")[2];
    await page.waitForFunction(() => document.querySelector(".official-bar")?.textContent?.includes("Official version"));
    await frameText("First report");
    await shot("official-reader");
    const result = await page.evaluate(async slug => {
      const old = await (await fetch(`/api/sites/${slug}/official`)).json();
      const response = await fetch(`/api/sites/${slug}/versions?expected_version=${old.currentVersionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<h1>Second report</h1>" }) });
      return { old, status: response.status, latest: await response.json() };
    }, slug);
    expect(result.status).toBe(200);
    await page.goto(`${base}/s/${slug}`, { waitUntil: "networkidle2" });
    await frameText("Second report");
    await page.waitForSelector('.official-bar a[href*="version="]');
    await shot("latest-reader");
    // Metadata failures must still remount the known snapshot on an explicit refresh.
    for (const failure of ["http", "network"]) {
      const frame = await page.$("iframe.fs-frame");
      await page.setRequestInterception(true);
      const intercept = (request: HTTPRequest) => {
        if (request.interceptResolutionState().action === "disabled") return;
        if (new URL(request.url()).pathname === `/api/sites/${slug}/versions`) {
          return failure === "http" ? request.respond({ status: 503, body: "unavailable" }) : request.abort();
        } else return request.continue();
      };
      page.on("request", intercept);
      try {
        await page.evaluate(() => window.dispatchEvent(new Event("artifact:refresh")));
        await page.waitForFunction(el => !el.isConnected, {}, frame!);
        // Keep interception active until the replacement iframe has loaded. Turning it
        // off while its navigation is paused can strand the request on slow CI runners.
        await frameText("Second report");
      } finally {
        page.off("request", intercept);
        await page.setRequestInterception(false);
      }
    }
    // A separate anonymous reader has no management capability and must not poll /official.
    const readerContext = await browser.createBrowserContext();
    const reader = await readerContext.newPage();
    let officialReads = 0;
    reader.on("request", request => { if (new URL(request.url()).pathname === `/api/sites/${slug}/official`) officialReads++; });
    try {
      await reader.goto(`${base}/s/${slug}`, { waitUntil: "networkidle2" });
      await reader.waitForSelector(".official-bar");
      expect(await reader.$(".official-bar button")).toBeNull();
      const initialReads = officialReads;
      await new Promise(resolve => setTimeout(resolve, 11_000));
      expect(officialReads).toBe(initialReads);
      await Promise.all([reader.waitForResponse(res => new URL(res.url()).pathname === `/api/sites/${slug}/official`), reader.evaluate(() => window.dispatchEvent(new Event("focus")))]);
      expect(officialReads).toBeGreaterThan(initialReads);
    } finally { await readerContext.close(); }

    await page.bringToFront();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.fs-handle[aria-expanded="false"]')?.click());
    await page.waitForFunction(() => document.querySelector(".fs-bar")!.getBoundingClientRect().top >= 0);
    await page.click('.official-bar a[href*="version="]');
    await page.waitForFunction(id => location.search.includes(id), {}, result.old.officialVersionId);
    await frameText("First report");
    expect(await page.$eval("iframe.fs-frame", el => el.getAttribute("sandbox"))).not.toContain("allow-same-origin");
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const header = document.querySelector(".fs-bar")!.getBoundingClientRect();
      const frame = document.querySelector(".fs-stage-wrap")!.getBoundingClientRect();
      return frame.top >= header.bottom - 1;
    });
    await shot("mobile-official");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(`${base}/s/${slug}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".official-bar button");
    await clickText("Set this version as official");
    await page.waitForFunction(() => document.querySelector(".official-bar")?.textContent?.includes("Official version updated"));
    const changed = await page.evaluate(async slug => (await fetch(`/api/sites/${slug}/official`)).json(), slug);
    expect(changed.officialVersionId).toBe(result.latest.versionId);
    expect(changed.versions.filter((v: { official: boolean }) => v.official)).toHaveLength(1);
    await page.goto(`${base}/s/${slug}/edit?version=${result.old.officialVersionId}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".editor-bar");
    await shot("historical-editor");
    const downloadSelected = async (expected: string) => {
      await page.click('.editor-bar-right button[aria-label="More"]');
      await clickText("Download this version (ZIP)");
      await page.waitForSelector("dialog[open] button[type=submit]");
      const download = page.waitForResponse(res => res.url().includes(`/api/sites/${slug}/export`));
      await page.click("dialog[open] button[type=submit]");
      const response = await download;
      expect(response.status()).toBe(200);
      expect(new URL(response.url()).searchParams.get("version")).toBe(expected);
      await page.waitForFunction(() => document.querySelector("dialog[open] [role=status]")?.textContent?.includes("Download started"));
      await clickText("Close");
    };
    await downloadSelected(result.old.officialVersionId);

    await clickText("Edit source");
    await page.waitForSelector("textarea.editor-textarea");
    await page.click("textarea.editor-textarea");
    await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.press("A");
    await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.type("<h1>Third report from historical base</h1>");
    const saved = page.waitForResponse(res => res.url().includes(`/api/sites/${slug}/edit`) && res.request().method() === "POST");
    await clickText("Save new version");
    expect((await saved).status()).toBe(200);
    const afterSave = await page.evaluate(async slug => (await fetch(`/api/sites/${slug}/official`)).json(), slug);
    expect(afterSave.officialVersionId).toBe(result.latest.versionId);
    expect(afterSave.currentVersionId).not.toBe(result.latest.versionId);
    await downloadSelected(afterSave.currentVersionId);
    await page.evaluate(async slug => {
      const res = await fetch(`/api/sites/${slug}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<h1>Concurrent edit</h1>" }) });
      if (!res.ok) throw new Error("Concurrent fixture failed");
    }, slug);
    await page.type("textarea.editor-textarea", "<p>Keep my draft</p>");
    const conflict = page.waitForResponse(res => res.url().includes(`/api/sites/${slug}/edit`) && res.request().method() === "POST");
    await clickText("Save new version");
    expect((await conflict).status()).toBe(409);
    await page.waitForFunction(() => document.body.textContent?.includes("Your edits are still here"));
    expect(await page.$eval("textarea.editor-textarea", el => (el as HTMLTextAreaElement).value)).toContain("Keep my draft");
    page.once("dialog", dialog => { void dialog.accept(); });

    await page.goto(`${base}/s/${slug}`, { waitUntil: "networkidle2" });
    const more = await page.$('button[aria-label="More"]');
    expect(more).not.toBeNull();
    { await more!.click(); await clickText("Version history"); await page.waitForSelector(".drawer"); await shot("version-history"); }
    await page.evaluate(async slug => fetch(`/api/sites/${slug}`, { method: "DELETE" }), slug);
  }, 90000);
  it("uses server-provided latest when replacing from history before official metadata loads", async () => {
    const pdf = buildPdf(1);
    const filename = path.join(dir, "report.pdf");
    await writeFile(filename, pdf);
    await page.goto(base!, { waitUntil: "networkidle2" });
    const fixture = await page.evaluate(async bytes => {
      const form = new FormData();
      form.set("mode", "file");
      form.set("file", new File([new Uint8Array(bytes)], "report.pdf"));
      const created = await fetch("/api/sites", { method: "POST", body: form });
      if (!created.ok) throw new Error(await created.text());
      const first = await created.json();
      if (!first.slug) throw new Error(`Fixture publication failed: ${first.error}`);
      localStorage.setItem(`sites:editToken:${first.slug}`, first.editToken);
      const next = await fetch(`/api/sites/${first.slug}/versions?expected_version=${first.versionId}`, { method: "POST", body: form });
      return { first, next: await next.json(), status: next.status };
    }, Array.from(pdf));
    expect(fixture.status).toBe(200);
    await page.setRequestInterception(true);
    const intercept = (request: HTTPRequest) => {
        if (request.interceptResolutionState().action === "disabled") return;
      if (new URL(request.url()).pathname.endsWith("/official")) return request.respond({ status: 503, body: "metadata unavailable" });
      else return request.continue();
    };
    page.on("request", intercept);
    try {
      await page.goto(`${base}/s/${fixture.first.slug}?version=${fixture.first.versionId}`, { waitUntil: "networkidle2" });
      let expected = fixture.next.versionId;
      for (let i = 0; i < 2; i++) {
        const input = await page.waitForSelector("input[type=file]");
        await input!.uploadFile(filename);
        await page.waitForSelector("dialog[open]");
        const replaced = page.waitForResponse(res => res.url().includes(`/api/sites/${fixture.first.slug}/versions`) && res.request().method() === "POST");
        await page.click("dialog .solid");
        const response = await replaced;
        expect(new URL(response.url()).searchParams.get("expected_version")).toBe(expected);
        expect(response.status()).toBe(200);
        expected = (await response.json()).versionId;
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent?.trim() === "Upload new version" && !b.disabled));
      }
    } finally {
      page.off("request", intercept);
      await page.setRequestInterception(false);
      await page.evaluate(async slug => fetch(`/api/sites/${slug}`, { method: "DELETE" }), fixture.first.slug);
    }
  }, 30000);

  it("manages official versions from My sites and shows total views on desktop and mobile", async () => {
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(base!, { waitUntil: "networkidle2" });
    const fixture = await page.evaluate(async () => {
      const first = await (await fetch("/api/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", title: "My sites version controls", html: "<h1>First</h1>", official: true }) })).json();
      if (!first.slug) throw new Error(`Fixture publication failed: ${first.error}`);
      localStorage.setItem(`sites:editToken:${first.slug}`, first.editToken);
      const second = await (await fetch(`/api/sites/${first.slug}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<h1>Second</h1>" }) })).json();
      return { first, second };
    });
    const slug = fixture.first.slug;
    const row = `.site-row[data-slug="${slug}"]`;
    await page.goto(`${base}/s/${slug}`, { waitUntil: "networkidle2" });
    await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
    await page.waitForSelector(`${row} .version-choice`);
    expect(await page.$eval(`${row} .row-views`, el => el.textContent)).toBe("1");
    expect(await page.$eval(`${row} .row-versions`, el => el.textContent)).toContain("2 versions total");
    const selectSecond = async () => {
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === `/api/sites/${slug}/official` && response.request().method() === "GET"), page.click(`${row} .version-choice`)]);
      await page.locator('.more-menu:not([hidden]) .version-option:not(:disabled)').click();
      await page.waitForSelector('dialog[open]');
    };
    await selectSecond();
    expect(await page.$eval('dialog[open]', el => el.textContent)).toContain("replaces official v1");
    await shot("my-sites-confirm");
    await page.keyboard.press("Escape");
    expect(await page.$eval(`${row} .version-choice`, el => el.textContent)).toContain("Official v1");
    await selectSecond();
    // Another manager changes the designation after the menu snapshot was read.
    await page.evaluate(async slug => { await fetch(`/api/sites/${slug}/official`, { method: "DELETE" }); }, slug);
    await page.click('dialog[open] .solid');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("Choose again"), {}, `${row} [role=alert]`);
    await selectSecond();
    await page.click('dialog[open] .solid');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("Official v2"), {}, `${row} .version-choice`);
    expect(new URL(page.url()).pathname).toBe("/me");
    await shot("my-sites-desktop");
    await page.click(`${row} .version-choice`);
    await page.waitForFunction(() => [...document.querySelectorAll('.more-menu:not([hidden]) a')].some(el => el.textContent === "View official version"));
    expect(await page.$eval('.more-menu:not([hidden]) a', el => el.getAttribute("href"))).toContain(fixture.second.versionId);
    await clickText("Remove official designation");
    await page.waitForSelector('dialog[open]');
    await page.click('dialog[open] .solid');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("No official version"), {}, `${row} .version-choice`);
    const state = await page.evaluate(async slug => (await fetch(`/api/sites/${slug}/official`)).json(), slug);
    expect(state.currentVersionId).toBe(fixture.second.versionId);
    for (const width of [1024, 800, 390]) {
      await page.setViewport({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.evaluate(() => { document.cookie = "ah_locale=zh-CN; Path=/"; });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(`${row} .version-choice`);
    expect(await page.$eval(`${row} .row-versions`, el => el.textContent)).toContain("共 2 版");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot("my-sites-mobile");
    await page.click(`${row} .version-choice`);
    await page.waitForSelector('.more-menu:not([hidden]) .version-option');
    await shot("my-sites-mobile-menu");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { document.cookie = "ah_locale=en; Path=/"; });
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(`${base}/me?tab=recent`, { waitUntil: "networkidle2" });
    await page.waitForSelector('.site-list:not(.my-sites-list) .site-row');
    expect(await page.$eval('.site-list .list-header', el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(5);
    await page.setViewport({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewport({ width: 1440, height: 960 });
  }, 60000);

});
