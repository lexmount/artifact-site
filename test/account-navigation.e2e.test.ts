import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { closeDbForTests, createId, getSiteBySlug, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { putTenantAdmin } from "@/lib/role-bindings";
const base = process.env.RBAC_E2E_URL;
let browser: Browser;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("account navigation", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    await mkdir("test-results", { recursive: true });
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it.each([
    ["tenants", "en"], ["claims", "zh-CN"],
  ])("recovers a failed %s lookup without reloading (%s)", async (failed, locale) => {
    const user = await upsertUser({ authProvider: "account-retry", providerSubject: createId("user") });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const counts = { tenants: 0, claims: 0 };
    let documentRequests = 0;
    const cookie = (await mintSession(new Request(base!), user.id)).cookie.split(";")[0];
    await context.setCookie(
      { name: cookie.split("=")[0], value: cookie.split("=")[1], domain: new URL(base!).hostname, path: "/" },
      { name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" },
    );
    await page.setViewport({ width: locale === "zh-CN" ? 390 : 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
      const path = new URL(request.url()).pathname;
      const key = path.endsWith("/api/tenants") ? "tenants" : path.endsWith("/api/me/adopt") ? "claims" : null;
      if (!key) { void request.continue(); return; }
      counts[key]++;
      // Repeated failure must remain recoverable; retrying one resource must leave the other intact.
      const unavailable = key === failed && counts[key] <= 2;
      void request.respond({ status: unavailable ? 503 : 200, contentType: "application/json", body: JSON.stringify(unavailable ? { error: "Temporarily unavailable" } : key === "tenants" ? { tenants: [{ id: "init", role: "admin", disabledAt: null }] } : { sites: [{ slug: "browser-artifact" }] }) });
    });
    const errorSelector = `[data-account-lookup="${failed}"][role="alert"]`;
    const assertTenantLink = async (visible: boolean) => {
      await page.click('.work-tabs-tools button[aria-haspopup="menu"]');
      expect(Boolean(await page.$('[role="menu"] a[href$="/tenants"]'))).toBe(visible);
      await page.keyboard.press("Escape");
    };
    try {
      await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
      await page.waitForSelector(errorSelector);
      expect(await page.$eval(errorSelector, e => e.textContent)).toContain(locale === "zh-CN" ? "无法检查待认领作品" : "Could not load tenant settings access");
      await assertTenantLink(failed !== "tenants");
      expect(Boolean(await page.$('.account-claim-notice a'))).toBe(failed !== "claims");
      await page.screenshot({ path: `test-results/account-retry-${locale}.png`, fullPage: true });
      for (let attempt = 2; attempt <= 3; attempt++) {
        await page.click(`${errorSelector} button`);
        await page.waitForFunction((selector, successful) => successful ? !document.querySelector(selector.replace('[role="alert"]', "")) : Boolean(document.querySelector(`${selector} button:not(:disabled)`)), {}, errorSelector, attempt === 3);
        expect(counts[failed as keyof typeof counts]).toBe(attempt);
      }
      await page.waitForSelector('.account-claim-notice a');
      await assertTenantLink(true);
      expect(counts[failed === "tenants" ? "claims" : "tenants"]).toBe(1);
      expect(documentRequests).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  });
  it.each(["en", "zh-CN"])("separates tenant administration and explicit browser claiming in %s", async locale => {
    const zh = locale === "zh-CN";
    const user = await upsertUser({ authProvider: "account-nav", providerSubject: createId("user"), email: `${createId("mail")}@example.test`, emailVerified: true });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: zh ? 390 : 1440, height: 900 });
    await context.setCookie({ name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" });
    try {
      await page.goto(base!, { waitUntil: "networkidle2" });
      const created = await page.evaluate(async () => {
        const r = await fetch('/api/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'paste', title: 'Before signing in', html: '<h1>Browser artifact</h1>' }) });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });
      expect((await getSiteBySlug(created.slug))!.ownerId).toBeNull();
      const cookie = (await mintSession(new Request(base!), user.id)).cookie.split(';')[0];
      await context.setCookie({ name: cookie.split('=')[0], value: cookie.split('=')[1], domain: new URL(base!).hostname, path: '/' });
      await page.goto(`${base}/me`, { waitUntil: 'networkidle2' });
      expect(await page.$('.work-tabs-tools a[href$="/tenants"]')).toBeNull();
      await page.waitForSelector('.account-claim-notice a');
      await page.click('.work-tabs-tools button[aria-haspopup="menu"]');
      expect(await page.$('[role="menu"] a[href$="/tenants"]')).toBeNull();
      await page.keyboard.press('Escape');
      await page.click('.account-claim-notice a');
      await page.waitForSelector('.claim-artifacts .claim-submit');
      expect(await page.$('.claim-artifacts select')).toBeNull();
      await page.screenshot({ path: `test-results/account-claim-${locale}.png`, fullPage: true });
      expect((await getSiteBySlug(created.slug))!.ownerId).toBeNull();
      await page.click('.claim-submit');
      await page.waitForSelector('.claim-success');
      expect((await getSiteBySlug(created.slug))!).toMatchObject({ ownerId: user.id, tenantId: 'init' });
      await page.goto(`${base}/me`, { waitUntil: 'networkidle2' });
      expect(await page.$('.account-claim-notice')).toBeNull();
      await page.screenshot({ path: `test-results/account-sites-${locale}.png`, fullPage: true });
      await page.goto(`${base}/tenants`, { waitUntil: 'networkidle2' });
      expect(await page.$('.tenant-settings-sections')).toBeNull();
      const tenantId = createId('tenant');
      await rbacQuery('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$1)', [tenantId, 'Managed tenant']);
      await rbacQuery('INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)', [tenantId, user.id]);
      await putTenantAdmin(rbacQuery, tenantId, user.id, true, null);
      await page.goto(`${base}/me`, { waitUntil: 'networkidle2' });
      await page.click('.work-tabs-tools button[aria-haspopup="menu"]');
      await page.waitForSelector('[role="menu"] a[href$="/tenants"]');
      await page.click('[role="menu"] a[href$="/tenants"]');
      await page.waitForSelector('.tenant-settings-sections .sharing-defaults');
      expect(await page.$eval('.tenant-detail-title h2', e => e.textContent)).toBe('Managed tenant');
      expect(await page.$('.tenant-manager-picker')).toBeNull();
      await page.screenshot({ path: `test-results/account-tenant-${locale}.png`, fullPage: true });
      expect(await page.$$eval('.tenant-setting button', es => es.map(e => e.textContent?.trim()))).toEqual([zh ? '重命名' : 'Rename']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  }, 60_000);
});
