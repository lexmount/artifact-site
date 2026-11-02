import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tarFixture } from "./tar-fixture";
import { zipSync } from "fflate";
import type { Browser, HTTPRequest } from "puppeteer-core";
const base = process.env.VIEWER_E2E_URL || "";
const token = process.env.PUBLISH_E2E_TOKEN || "";
const headers = { authorization: `Bearer ${token}` };
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
}
async function publish(name: string, bytes: Uint8Array) {
  const { versionId } = await (await api("/api/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Package acceptance", package: { source: "archive", name } }) })).json();
  await api(`/api/uploads/${versionId}/files/original`, { method: "PUT", body: Buffer.from(bytes) });
  return (await api(`/api/uploads/${versionId}/commit`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `package-e2e-${versionId}` }, body: "{}" })).json();
}
describe.skipIf(!base || !token)("package preview in final image", () => {
  let browser: Browser;
  let downloads: string;
  beforeAll(async () => {
    downloads = await mkdtemp(path.join(tmpdir(), "package-downloads-"));
    browser = await (await import("puppeteer-core")).launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  });
  afterAll(async () => { await browser?.close(); if (downloads) await rm(downloads, { recursive: true, force: true }); });
  it("renders directory, nested HTML and root CSS, returns to directory, and preserves original bytes", async () => {
    const zip = zipSync({
      "reports/index.html": Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body><h1 id="report">Nested report</h1><a href="other.htm">Next page</a></body></html>'),
      "reports/other.htm": Buffer.from("<h1>Second page</h1>"),
      "assets/style.css": Buffer.from("#report{color:rgb(12,34,56)}"),
      "empty/": new Uint8Array(), "资料/说明.txt": Buffer.from("notes"), "data.xlsx": Buffer.from("unpreviewable"),
    });
    const result = await publish("original.zip", zip);
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 }); await page.setExtraHTTPHeaders({ "accept-language": "en" });
    try {
      await page.goto(`${base}/s/${result.slug}`, { waitUntil: "networkidle2" });
      await page.waitForSelector("iframe.fs-frame");
      const element = await page.$("iframe.fs-frame"); let frame = (await element!.contentFrame())!;
      await frame.waitForSelector('a[href="reports/index.html"]');
      expect(await frame.evaluate(() => document.body.textContent)).toContain("data.xlsx");
      await page.waitForSelector(".package-navigation", { hidden: true });
      expect(await frame.$$eval("details[open]", nodes => nodes.length)).toBe(0);
      await page.screenshot({ path: "test-results/package-directory-collapsed.png", fullPage: true });
      await frame.click('[data-expand="false"]');
      expect(await frame.$$eval("details[open]", nodes => nodes.length)).toBe(0);
      await frame.focus('[data-expand="true"]'); await page.keyboard.press("Enter");
      expect(await frame.$$eval("details:not([open])", nodes => nodes.length)).toBe(0);
      expect(await frame.$$eval("svg[data-file-type]", nodes => nodes.length)).toBeGreaterThan(5);
      await page.screenshot({ path: "test-results/package-directory.png", fullPage: true });
      await page.setViewport({ width: 390, height: 844 });
      expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: "test-results/package-directory-mobile.png", fullPage: true });
      await page.setViewport({ width: 1280, height: 900 });
      await Promise.all([
        frame.waitForNavigation({ waitUntil: "load" }),
        frame.click('a[href="reports/index.html"]'),
      ]);
      await frame.waitForSelector("#report");
      await page.waitForSelector(".package-navigation:not([hidden])");
      expect(await frame.$eval("#report", e => getComputedStyle(e).color)).toBe("rgb(12, 34, 56)");
      await page.screenshot({ path: "test-results/package-html.png", fullPage: true });
      await frame.click("a"); await frame.waitForFunction(() => document.body.textContent?.includes("Second page"));
      await page.evaluate(() => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === "Back to file directory"); button?.click(); });
      await page.waitForFunction(() => document.querySelector("iframe.fs-frame") !== null);
      frame = (await (await page.$("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href="reports/index.html"]');
      await page.waitForSelector(".package-navigation", { hidden: true });
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show action bar"]')?.click());
      await page.locator('.fs-bar button[aria-label="More"]').click();
      expect(await page.$('[data-analytics-button="download"]')).toBeNull();
      await page.setExtraHTTPHeaders({ "accept-language": "en", ...headers });
      await page.reload({ waitUntil: "networkidle2" });
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show action bar"]')?.click());
      await page.locator('.fs-bar button[aria-label="More"]').click();
      await page.waitForSelector('[data-analytics-button="download"]');
      await page.screenshot({ path: "test-results/package-download-menu.png", fullPage: true });
      await page.click('[data-analytics-button="download"]');
      await page.waitForSelector('dialog[open]');
      expect(await page.$eval('dialog[open]', el => el.textContent)).toContain("original format");
      const receipt = page.waitForResponse(res => res.url().includes(`/api/sites/${result.slug}/download?version=${result.versionId}`));
      await page.click('dialog[open] button[type="submit"]');
      const downloaded = await receipt; expect(downloaded.status()).toBe(200);
      await expect.poll(() => readFile(path.join(downloads, "original.zip")).then(bytes => bytes.length).catch(() => 0)).toBe(zip.length);
      expect(await readFile(path.join(downloads, "original.zip"))).toEqual(Buffer.from(zip));
      const download = await api(`/api/sites/${result.slug}/download?version=${result.versionId}`);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(zip));
      expect((await fetch(`${base}/api/sites/${result.slug}/download`)).status).toBe(403);
      expect((await fetch(`${base}/api/preview/${result.slug}/.artifact-package/original`)).status).not.toBe(200);
      expect((await fetch(`${base}/api/preview/${result.slug}/data.xlsx`)).status).toBe(415);
    } finally { await page.close(); }
  });
  it("shows return navigation only inside HTML on a shared package", async () => {
    const result = await publish("shared.zip", zipSync({ "index.html": Buffer.from("<h1>Shared report</h1>") }));
    const share = await (await api(`/api/sites/${result.slug}/shares`, { method: "POST", headers: { "content-type": "application/json", "x-management-reason": "Package navigation acceptance" }, body: JSON.stringify({ policy: "public", mode: "view", versionId: result.versionId }) })).json();
    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({ "accept-language": "en" });
      await page.goto(share.url, { waitUntil: "networkidle2" });
      await page.waitForSelector("iframe.fs-frame");
      const frame = (await (await page.$("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href="index.html"]');
      await page.waitForSelector(".package-navigation", { hidden: true });
      // A host/sibling message cannot impersonate the current sandbox.
      await page.evaluate(() => window.postMessage({ type: "artifact:package-location", directory: false }, "*"));
      expect(await page.$eval(".package-navigation", el => el.hasAttribute("hidden"))).toBe(true);
      await Promise.all([frame.waitForNavigation({ waitUntil: "load" }), frame.click('a[href="index.html"]')]);
      await page.waitForSelector(".package-navigation:not([hidden])");
      await page.click(".package-navigation button");
      await frame.waitForSelector('a[href="index.html"]');
      await page.waitForSelector(".package-navigation", { hidden: true });
    } finally { await page.close(); }
  });
  it.each([false, true])("can return before a deferred script loads (shared: %s)", async shared => {
    const result = await publish("pending.zip", zipSync({
      "index.html": Buffer.from('<!doctype html><html><head><script defer src="slow.js"></script></head><body><h1 id="pending-report">Pending script</h1></body></html>'),
      "slow.js": Buffer.from("window.scriptFinished = true;"),
    }));
    let url = `${base}/s/${result.slug}`;
    if (shared) {
      const share = await (await api(`/api/sites/${result.slug}/shares`, { method: "POST", headers: { "content-type": "application/json", "x-management-reason": "Pending script navigation acceptance" }, body: JSON.stringify({ policy: "public", mode: "view", versionId: result.versionId }) })).json();
      url = share.url;
    }
    const page = await browser.newPage();
    let held: HTTPRequest | undefined;
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/slow.js")) held = request;
      else void request.continue();
    });
    try {
      await page.goto(url, { waitUntil: "networkidle2" });
      const frame = (await (await page.waitForSelector("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href="index.html"]');
      await page.waitForSelector(".package-navigation", { hidden: true });
      await frame.click('a[href="index.html"]');
      await frame.waitForSelector("#pending-report", { visible: true });
      await expect.poll(() => Boolean(held)).toBe(true);
      // Neither DOMContentLoaded nor iframe load can fire until the deferred script resolves.
      expect(await frame.evaluate(() => document.readyState)).not.toBe("complete");
      await page.waitForSelector(".package-navigation:not([hidden])", { timeout: 5000 });
      await page.click(".package-navigation button");
      await frame.waitForSelector('a[href="index.html"]');
      await page.waitForSelector(".package-navigation", { hidden: true });
    } finally {
      await held?.abort().catch(() => {});
      await page.close();
    }
  });
  it.each(["tar", "tar.gz", "tgz"])("publishes %s from the picker with sandboxed hidden HTML and original downloads", async ext => {
    const dir = await mkdtemp(path.join(tmpdir(), "package-tar-"));
    const bytes = tarFixture([{ name: "./", type: "5" }, { name: "./.pages/index.html", content: "<h1 id='tar-report'>TAR report</h1>" }, { name: "./.lock" }, { name: "./empty/", type: "5" }], ext !== "tar");
    const file = path.join(dir, `report.${ext}`); await writeFile(file, bytes);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await page.setExtraHTTPHeaders({ "accept-language": "en" });
      await page.goto(base, { waitUntil: "networkidle2" });
      const input = await page.waitForSelector("input[type=file]:not([webkitdirectory])");
      await input!.uploadFile(file);
      await page.waitForSelector("dialog[open] .solid"); await page.click("dialog[open] .solid");
      await page.waitForSelector('.package-upload-hint a[href*="/s/"]');
      await page.click('.package-upload-hint a[href*="/s/"]');
      await page.waitForFunction(() => location.pathname.includes("/s/"));
      const slug = new URL(page.url()).pathname.split("/s/")[1];
      const frame = (await (await page.waitForSelector("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href=".pages/index.html"]');
      expect(await frame.evaluate(() => document.body.textContent)).toContain(".lock");
      await frame.click('[data-expand="true"]');
      await Promise.all([frame.waitForNavigation({ waitUntil: "load" }), frame.click('a[href=".pages/index.html"]')]);
      await frame.waitForSelector("#tar-report");
      await page.waitForSelector(".package-navigation:not([hidden])");
      await page.click(".package-navigation button"); await frame.waitForSelector('a[href=".pages/index.html"]');
      const download = await api(`/api/sites/${slug}/download`);
      expect(download.headers.get("content-type")).toBe(ext === "tar" ? "application/x-tar" : "application/gzip");
      expect(download.headers.get("content-disposition")).toContain(`report.${ext}`);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      expect((await fetch(`${base}/api/sites/${slug}/download`)).status).toBe(403);
    } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("publishes an original 7z through the browser file picker", async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en" });
    try {
      await page.goto(base, { waitUntil: "networkidle2" });
      await page.waitForSelector("input[type=file]:not([webkitdirectory])");
      const input = await page.$("input[type=file]:not([webkitdirectory])");
      await input!.uploadFile(path.resolve("test/fixtures/archives/acceptance.7z"));
      await page.waitForSelector("dialog[open] .solid");
      await page.click("dialog[open] .solid");
      await page.waitForSelector('.package-upload-hint a[href*="/s/"]');
      await page.click('.package-upload-hint a[href*="/s/"]');
      await page.waitForFunction(() => location.pathname.includes("/s/"));
      await page.waitForSelector("iframe.fs-frame");
      const frame = (await (await page.$("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href="index.html"]');
      expect(await frame.evaluate(() => document.body.textContent)).toContain("empty");
    } finally { await context.close(); }
  });
  it("publishes a selected folder without its wrapper or OS metadata", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "package-folder-"));
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await mkdir(path.join(dir, "assets"));
      await mkdir(path.join(dir, ".git"));
      await mkdir(path.join(dir, "node_modules/lib"), { recursive: true });
      await writeFile(path.join(dir, ".git/config"), "synthetic");
      await writeFile(path.join(dir, "node_modules/lib/style.css"), "#folder-report{color:rgb(12,34,56)}");
      await writeFile(path.join(dir, "index.html"), '<link rel="stylesheet" href="/node_modules/lib/style.css"><h1 id="folder-report">Folder report</h1>');
      await writeFile(path.join(dir, "assets/style.css"), '#folder-report{color:rgb(12,34,56)}');
      await writeFile(path.join(dir, ".DS_Store"), "junk");
      await page.setExtraHTTPHeaders({ "accept-language": "en" });
      await page.goto(base, { waitUntil: "networkidle2" });
      const input = await page.waitForSelector("input[webkitdirectory]");
      await input!.uploadFile(dir);
      await page.waitForSelector("dialog[open] .solid");
      await page.click("dialog[open] .solid");
      await page.waitForSelector('.package-upload-hint a[href*="/s/"]');
      await page.click('.package-upload-hint a[href*="/s/"]');
      await page.waitForFunction(() => location.pathname.includes("/s/"));
      await page.waitForSelector("iframe.fs-frame");
      const frame = (await (await page.$("iframe.fs-frame"))!.contentFrame())!;
      await frame.waitForSelector('a[href="index.html"]');
      expect(await frame.evaluate(() => document.body.textContent)).not.toContain(".DS_Store");
      expect(await frame.evaluate(() => document.body.textContent)).toContain(".git");
      expect(await frame.evaluate(() => document.body.textContent)).toContain("node_modules");
      await Promise.all([frame.waitForNavigation({ waitUntil: "load" }), frame.click('a[href="index.html"]')]);
      expect(await frame.$eval("#folder-report", e => getComputedStyle(e).color)).toBe("rgb(12, 34, 56)");
    } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it.each([["test_read_format_rar5_multiple_files_solid.rar", "application/vnd.rar"], ["acceptance.7z", "application/x-7z-compressed"]])("extracts %s in the deployed native runtime", async (file, mime) => {
    const bytes = await readFile(`test/fixtures/archives/${file}`);
    const result = await publish(file, bytes);
    const response = await api(`/api/sites/${result.slug}/download`);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it.each([200, 403, 404])("preserves real unsaved source edits during signed download (%s)", async status => {
    const created = await (await api("/api/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<h1>Saved source</h1>" }) })).json();
    const page = await browser.newPage();
    const bytes = Buffer.from(zipSync({ "index.html": Buffer.from("<h1>Saved source</h1>") }));
    let leavePrompts = 0;
    page.on("dialog", dialog => { leavePrompts++; void dialog.dismiss(); });
    await page.setExtraHTTPHeaders({ "accept-language": "en", ...headers });
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.url().startsWith("https://download.example.test/")) {
        void request.respond({ status, contentType: status === 200 ? "application/zip" : "application/xml", headers: status === 200 ? { "content-disposition": 'attachment; filename="signed-editor.zip"' } : {}, body: status === 200 ? bytes : "<Error>Storage error</Error>" });
      } else if (request.url().includes(`/api/sites/${created.slug}/download`)) {
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://download.example.test/original?signature=fixture" }) });
      } else void request.continue();
    });
    try {
      const url = `${base}/s/${created.slug}/edit`;
      await page.goto(url, { waitUntil: "networkidle2" });
      await page.waitForSelector(".editor-bar");
      await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Edit source")?.click());
      await page.waitForSelector("textarea.editor-textarea");
      await page.type("textarea.editor-textarea", " Unsaved draft");
      await page.locator('.editor-bar-right button[aria-label="More"]').click();
      await page.locator('[data-analytics-button="download"]').click();
      await page.waitForSelector("dialog[open]");
      await page.click('dialog[open] button[type="submit"]');
      if (status === 200) {
        await expect.poll(() => readFile(path.join(downloads, "signed-editor.zip")).then(b => b.length).catch(() => 0)).toBe(bytes.length);
        expect(await readFile(path.join(downloads, "signed-editor.zip"))).toEqual(bytes);
      } else {
        await page.waitForFunction(() => document.querySelector("dialog[open] [role=alert]")?.textContent?.includes("could not start the download"));
      }
      expect(page.url()).toBe(url);
      expect(await page.$eval("textarea.editor-textarea", el => (el as HTMLTextAreaElement).value)).toContain("Unsaved draft");
      expect(leavePrompts).toBe(0);
    } finally { await page.close(); }
  });

});
