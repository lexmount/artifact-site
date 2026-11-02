// Run against a disposable, OIDC-enabled server and its PostgreSQL database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import type { Browser } from "puppeteer-core";
import { closeDbForTests, createId, getSiteBySlug, updateSiteVisibility, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
const base = process.env.ACCESS_E2E_URL;
let browser: Browser;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("site access screens", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    await mkdir("test-results", { recursive: true });
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it.each(["en", "zh-CN"])("renders missing, guest and signed-in denial; preserves auth destinations (%s)", async locale => {
    const zh = locale === "zh-CN";
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: zh ? 390 : 1440, height: 900 });
    await context.setCookie(
      { name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" },
      { name: "artifact_sso_opt_out", value: "1", domain: new URL(base!).hostname, path: "/" },
    );
    try {
      await page.goto(`${base}/s/no-such-access-test`, { waitUntil: "networkidle0" });
      expect(await page.$eval("h1", el => el.textContent)).toBe(zh ? "站点不存在" : "Site not found");
      const owner = await upsertUser({ authProvider: "access-e2e", providerSubject: createId("owner") });
      const ownerCookie = (await mintSession(new Request(base!), owner.id)).cookie.split(";")[0];
      const created = await fetch(`${base}/api/sites`, { method: "POST", headers: { cookie: ownerCookie, origin: base!, "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<title>Private artifact title</title><h1>Secret content</h1>" }) });
      expect(created.status).toBe(200);
      const { slug, versionId } = await created.json();
      const site = (await getSiteBySlug(slug))!;
      await updateSiteVisibility(site.id, "private");
      const target = `/s/${slug}?version=${versionId}&collection=folder#page-2`;
      await page.goto(`${base}${target}`, { waitUntil: "networkidle0" });
      expect(await page.$eval("h1", el => el.textContent)).toBe(zh ? "暂无访问权限" : "Access denied");
      expect(await page.title()).toContain(zh ? "暂无访问权限" : "Access denied");
      expect(await page.content()).not.toContain("Private artifact title");
      expect(await page.$("iframe.fs-frame")).toBeNull();
      await page.screenshot({ path: `test-results/access-guest-${locale}.png`, fullPage: true });
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/auth/login") void request.respond({ status: 200, contentType: "text/html", body: "Sign-in destination captured" });
        else void request.continue();
      });
      await Promise.all([page.waitForNavigation(), page.click("main button.btn.solid")]);
      expect(new URL(page.url()).searchParams.get("return_to")).toBe(target);
      const stranger = await upsertUser({ authProvider: "access-e2e", providerSubject: createId("reader"), email: "access-reader@example.test", emailVerified: true });
      const credential = (await mintSession(new Request(base!), stranger.id)).cookie.split(";")[0];
      await context.setCookie({ name: credential.split("=")[0], value: credential.split("=")[1], domain: new URL(base!).hostname, path: "/" });
      await page.goto(`${base}${target}`, { waitUntil: "networkidle0" });
      expect(await page.evaluate(() => document.body.innerText)).toContain("access-reader@example.test");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/access-signed-in-${locale}.png`, fullPage: true });
      const switchButton = await page.waitForSelector("main button.btn:not(.solid)");
      await Promise.all([page.waitForNavigation(), switchButton!.click()]);
      const switched = new URL(page.url());
      expect(switched.searchParams.get("return_to")).toBe(target);
      expect(switched.searchParams.get("switch_account")).toBe("1");
      // Restore a fresh authenticated session, then obtain a grant and retry the original link.
      const renewed = (await mintSession(new Request(base!), stranger.id)).cookie.split(";")[0];
      await context.setCookie({ name: renewed.split("=")[0], value: renewed.split("=")[1], domain: new URL(base!).hostname, path: "/" });
      await page.goto(`${base}${target}`, { waitUntil: "networkidle0" });
      await updateSiteVisibility(site.id, "public");
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("main button.btn.solid")]);
      await page.waitForSelector("iframe.fs-frame");
      expect(page.url()).toBe(`${base}${target}`);
    } finally { await context.close(); }
  }, 60_000);
});
