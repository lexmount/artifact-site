import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import type { Browser } from "puppeteer-core";
const base = process.env.SHARING_E2E_URL;
let browser: Browser;
describe.skipIf(!base)("collection folder navigation", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    await mkdir("test-results", { recursive: true });
  });
  afterAll(async () => { await browser?.close(); });
  it("preserves a restricted collection deep link through sign-in", async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    let signedIn = false;
    const query = new URLSearchParams({ folder: "fld-a", q: "report & notes" }).toString();
    const target = new URL(`${base}/c/login-token?${query}`);
    await page.setRequestInterception(true);
    page.on("request", r => {
      const url = new URL(r.url());
      if (url.pathname.endsWith("/api/auth/login")) {
        signedIn = true;
        // Simulate the IdP's successful callback using the actual sign-in return target.
        void r.respond({ status: 302, headers: { location: url.searchParams.get("return_to")! } });
      } else if (url.pathname.includes("/api/collections/")) {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(signedIn ? {
          state: "ready", name: "My entire collection", owner: "Alex",
          folders: [{ id: "fld-a", name: "Research", count: 1 }],
          items: [{ slug: "alpha", title: "Research report & notes", folderId: "fld-a", tenantName: "Team", updatedAt: 1791763200000, comments: true }],
        } : { state: "login", items: [] }) });
      } else void r.continue();
    });
    try {
      await page.goto(target.href, { waitUntil: "networkidle2" });
      await page.waitForSelector('.collection-empty a');
      expect(new URL(page.url()).searchParams.get("folder")).toBe("fld-a");
      const login = new URL(await page.$eval('.collection-empty a', e => (e as HTMLAnchorElement).href));
      expect(login.searchParams.get("return_to")).toBe(target.pathname + target.search);
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }), page.click('.collection-empty a')]);
      await page.waitForSelector('.collection-row');
      expect(new URL(page.url()).searchParams.get("folder")).toBe("fld-a");
      expect(new URL(page.url()).searchParams.get("q")).toBe("report & notes");
      expect(await page.$eval('.collection-content h2', e => e.textContent)).toBe("Research");
      expect(await page.$eval('.searchbox input', e => (e as HTMLInputElement).value)).toBe("report & notes");
    } finally { await context.close(); }
  });
  it.each(["en", "zh-CN"])("filters and restores URL state in %s", async locale => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await context.setCookie({ name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" });
    await page.setViewport({ width: locale === "en" ? 1440 : 390, height: 900 });
    let fail = true;
    let folders = [{ id: "fld-a", name: "Research", count: 1 }, { id: "fld-b", name: "Design", count: 1 }];
    await page.setRequestInterception(true);
    page.on("request", r => {
      if (!r.url().includes("/api/collections/")) { void r.continue(); return; }
      void r.respond({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "Unavailable" } : { state: "ready", name: "My entire collection", owner: "Alex", folders, items: [{ slug: "alpha", title: "Research report", folderId: "fld-a", tenantName: "Team", updatedAt: 1791763200000, comments: true }, { slug: "beta", title: "Design report", folderId: "fld-b", tenantName: "Team", updatedAt: 1791763200000, comments: false }, { slug: "gamma", title: "Notes", folderId: null, tenantName: "Team", updatedAt: 1791763200000, comments: false }] }) });
    });
    try {
      await page.goto(`${base}/c/test-token?folder=fld-a&q=report`, { waitUntil: "networkidle2" });
      await page.waitForSelector('[role="alert"] button');
      fail = false;
      await page.click('[role="alert"] button');
      await page.waitForSelector('.collection-row');
      expect(await page.$$eval('.collection-row strong', es => es.map(e => e.textContent))).toEqual(["Research report"]);
      if (locale === "en") await page.click('.collection-folders button:last-child');
      else await page.select('.collection-folder-picker select', 'fld-b');
      await page.waitForFunction(() => document.querySelector('.collection-row strong')?.textContent === 'Design report');
      expect(page.url()).toContain('folder=fld-b');
      expect(page.url()).toContain('q=report');
      await page.reload({ waitUntil: 'networkidle2' });
      expect(await page.$$eval('.collection-row strong', es => es.map(e => e.textContent))).toEqual(["Design report"]);
      await page.screenshot({ path: `test-results/collection-folders-${locale}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.goBack({ waitUntil: 'networkidle2' });
      expect(page.url()).toContain('folder=fld-a');
      folders = [];
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('folder'));
      expect(await page.$('.collection-folders')).toBeNull();
      expect(await page.$$('.collection-row')).toHaveLength(2);
    } finally { await context.close(); }
  });
});
