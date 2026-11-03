import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { closeDbForTests, createId, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

const base = process.env.SHARE_EDUCATION_E2E_URL;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("main-link passcode browser acceptance", () => {
  let browser: Browser, owner: BrowserContext, page: Page;
  let slug: string, userId: string, tenant: string, headers: Record<string, string>;
  const api = (method = "GET", body?: unknown) => fetch(`${base}/api/sites/${slug}/main-sharing`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function openSharing() {
    await page.goto(`${base}/s/${slug}?lang=en`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/sharing?summary=1')));
    await page.$eval('[data-analytics-button="share"]', el => (el as HTMLElement).focus());
    await page.locator('[data-analytics-button="share"]').click();
    await page.waitForSelector('.sharing-audiences input:not(:disabled)');
  }
  async function saved() {
    if (await page.$('.sharing-confirmation:modal')) await page.click('.sharing-confirmation footer button[type="submit"]');
    await page.waitForSelector('.sharing-confirmation', { hidden: true });
    await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
    await page.waitForSelector('.sharing-copy-button:not(:disabled)');
  }
  async function choose(value: string) {
    await page.locator(`.sharing-audiences input[value="${value}"]:not(:disabled)`).click();
    await saved();
  }
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const user = await upsertUser({ authProvider: "main-code-e2e", providerSubject: createId("owner") });
    userId = user.id; tenant = createId("code-team");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Design team')", [tenant]);
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant, userId]);
    await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, userId]);
    const session = await mintSession(new Request(base!), userId);
    const [name, value] = session.cookie.split(";")[0].split("=");
    headers = { cookie: `${name}=${value}`, origin: base!, "content-type": "application/json" };
    const response = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ mode: "paste", title: "Main passcode acceptance", html: "<!doctype html><html><body><h1 id='protected-content'>Protected design</h1></body></html>" }) });
    expect(response.status).toBe(200); slug = (await response.json()).slug;
    expect((await api("PUT", { action: "custom", policy: { audience: "private", comments: true } })).status).toBe(200);
    owner = await browser.createBrowserContext();
    await owner.setCookie({ name, value, domain: new URL(base!).hostname, path: "/", httpOnly: true });
    page = await owner.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await mkdir("test-results", { recursive: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });

  it("anchors sharing below its trigger through viewport and content changes", async () => {
    await page.setViewport({ width: 1440, height: 1200 });
    await openSharing();
    const geometry = () => page.evaluate(() => {
      const trigger = document.querySelector('[data-analytics-button="share"]')!.getBoundingClientRect();
      const dialog = document.querySelector('.sharing-dialog')!.getBoundingClientRect();
      const copy = document.querySelector('.sharing-copy-button')!.getBoundingClientRect();
      return { gap: dialog.top - trigger.bottom, alignment: Math.abs(dialog.right - trigger.right), fits: dialog.left >= 0 && dialog.right <= innerWidth && dialog.bottom <= innerHeight, copyVisible: copy.top >= dialog.top && copy.bottom <= innerHeight };
    });
    expect((await geometry()).gap).toBeCloseTo(8, 0);
    expect((await geometry()).alignment).toBeLessThanOrEqual(1);
    await choose('passcode');
    expect((await geometry()).gap).toBeCloseTo(8, 0);
    for (const viewport of [{ width: 1280, height: 600 }, { width: 800, height: 700 }]) {
      await page.setViewport(viewport);
      await page.waitForFunction(() => {
        const trigger = document.querySelector('[data-analytics-button="share"]')!.getBoundingClientRect();
        const dialog = document.querySelector('.sharing-dialog')!.getBoundingClientRect();
        return Math.abs(dialog.top - trigger.bottom - 8) < 1;
      });
      expect(await geometry()).toMatchObject({ fits: true, copyVisible: true });
    }
    await page.locator('.sharing-dialog-head button[aria-label="Close"]').click();
    await page.waitForSelector('.sharing-dialog', { hidden: true });
    expect(await page.$eval('[data-analytics-button="share"]', el => el === document.activeElement)).toBe(true);
    await page.setViewport({ width: 1440, height: 1000 });
    expect((await api('PUT', { action: 'custom', policy: { audience: 'private', comments: true } })).status).toBe(200);
  });

  it("protects the same URL, exposes the generated code and invalidates both visitor and resource access on reset", async () => {
    await openSharing();
    expect(await page.$$eval('.sharing-audiences input[type=radio]', inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(['private', 'tenant', 'login', 'passcode', 'anyone']);
    expect(await page.$('input[id$="-discover"]')).toBeNull();
    await choose('passcode');
    const code = await page.$eval('.sharing-passcode-controls input', input => (input as HTMLInputElement).value);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(await page.$eval('.sharing-copy-button', el => el.textContent)).toBe('Copy link and passcode');
    await page.screenshot({ path: 'test-results/main-passcode-desktop.png' });
    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844 });
      expect(await page.$eval('.sharing-dialog', el => {
        const copy = el.querySelector('.sharing-copy-button')!.getBoundingClientRect();
        return el.scrollWidth <= el.clientWidth && copy.top >= 0 && copy.bottom <= innerHeight;
      })).toBe(true);
      await page.screenshot({ path: `test-results/main-passcode-${width}.png` });
    }
    await page.setViewport({ width: 1440, height: 1000 });
    const guest = await browser.createBrowserContext(), visitor = await guest.newPage();
    try {
      await visitor.goto(`${base}/s/${slug}?lang=en`, { waitUntil: 'networkidle2' });
      expect(await visitor.$('iframe')).toBeNull();
      await visitor.type('#main-passcode', 'WRONG1');
      await Promise.all([visitor.waitForNavigation({ waitUntil: 'networkidle2' }), visitor.click('.main-passcode-entry button')]);
      expect(await visitor.$('[role=alert]')).not.toBeNull();
      await visitor.type('#main-passcode', code.toLowerCase());
      await Promise.all([visitor.waitForNavigation({ waitUntil: 'networkidle2' }), visitor.click('.main-passcode-entry button')]);
      expect(new URL(visitor.url()).pathname).toBe(`/s/${slug}`);
      await visitor.waitForSelector('.fs-stage iframe');
      const frame = await (await visitor.$('.fs-stage iframe'))!.contentFrame();
      await frame!.waitForSelector('#protected-content');
      const previewUrl = await frame!.evaluate(() => new URL('index.html', document.baseURI).href);
      expect((await fetch(previewUrl)).status).toBe(200);
      expect(await visitor.$eval('.fs-stage iframe', el => el.getAttribute('sandbox'))).not.toContain('allow-same-origin');
      await page.click('.sharing-passcode-controls .ghost');
      await page.waitForSelector('.scope-dialog:modal');
      expect(await page.$eval('.scope-dialog:modal', el => el.textContent)).toContain('The old passcode will stop working');
      await page.click('.scope-dialog:modal footer .solid');
      await saved();
      const nextCode = await page.$eval('.sharing-passcode-controls input', el => (el as HTMLInputElement).value);
      expect(nextCode).not.toBe(code);
      expect((await fetch(previewUrl)).status).not.toBe(200);
      await visitor.reload({ waitUntil: 'networkidle2' });
      expect(await visitor.$('#main-passcode')).not.toBeNull();
      await openSharing();
      expect(await page.$eval('.sharing-passcode-controls input', el => (el as HTMLInputElement).value)).toBe(nextCode);
    } finally { await guest.close(); }
  });

  it("includes Discover in the anyone confirmation and saves or cancels both settings together", async () => {
    expect((await api('PUT', { action: 'custom', policy: { audience: 'private', comments: true } })).status).toBe(200);
    await openSharing();
    await page.locator('.sharing-audiences input[value="anyone"]').click();
    await page.waitForSelector('.sharing-confirmation:modal');
    const toggle = '.sharing-confirmation input[role="switch"]';
    expect(await page.$(toggle)).not.toBeNull();
    expect(await page.$eval(toggle, el => (el as HTMLInputElement).checked)).toBe(false);
    await page.click(toggle);
    expect(await page.$eval('.sharing-confirmation h2', el => el.textContent)).toBe('Allow access and list in Discover?');
    expect((await (await api()).json()).policy.audience).toBe('private');
    await page.click('.sharing-confirmation footer button[type="button"]');
    await page.waitForSelector('.sharing-confirmation', { hidden: true });
    expect((await (await api()).json()).policy.audience).toBe('private');
    expect(await page.$('input[id$="-discover"]')).toBeNull();

    await page.locator('.sharing-audiences input[value="anyone"]').click();
    await page.waitForSelector('.sharing-confirmation:modal');
    expect(await page.$eval(toggle, el => (el as HTMLInputElement).checked)).toBe(false);
    await page.click(toggle);
    await page.click(toggle);
    expect(await page.$eval('.sharing-confirmation h2', el => el.textContent)).toBe('Allow anyone to access?');
    await page.click(toggle);
    await saved();
    expect((await (await api()).json()).policy.audience).toBe('public');
    expect(await page.$eval('input[id$="-discover"]', el => (el as HTMLInputElement).checked)).toBe(true);
    await openSharing();
    expect(await page.$eval('input[id$="-discover"]', el => (el as HTMLInputElement).checked)).toBe(true);
    await choose('private');
  });

  it("keeps secondary actions in menus and makes Discover conditional without relisting", async () => {
    await openSharing();
    await page.click('button[aria-label="More sharing options"]');
    await page.waitForSelector('.sharing-more-menu');
    expect(await page.$eval('.sharing-more-menu button:first-child', el => el.textContent)).toBe('Permission settings');
    await page.click('.sharing-more-menu button:first-child');
    await page.waitForFunction(() => document.querySelector('.sharing-dialog-head h2')?.textContent === 'Permission settings');
    await page.click('.sharing-dialog-head button[aria-label="Close"]');
    expect(await page.$('.controls > a[href*="/edit"]')).toBeNull();
    await page.$eval('.controls .more-button', el => (el as HTMLElement).focus());
    await page.locator('.controls .more-button').click();
    await page.waitForSelector('.more-menu:not([hidden]) a[href*="/edit"]');
    expect(await page.$eval('.more-menu:not([hidden])', el => el.textContent)).not.toContain('Administrator activity');
    await page.keyboard.press('Escape');
    await openSharing();
    await choose('anyone');
    await page.click('input[id$="-discover"]');
    await saved();
    expect((await (await api()).json()).policy.audience).toBe('public');
    await choose('login');
    expect(await page.$('input[id$="-discover"]')).toBeNull();
    await choose('anyone');
    expect(await page.$eval('input[id$="-discover"]', el => (el as HTMLInputElement).checked)).toBe(false);
    await page.goto(`${base}/s/${slug}?lang=zh-CN`, { waitUntil: 'networkidle2' });
    await page.$eval('[data-analytics-button="share"]', el => (el as HTMLElement).focus());
    await page.locator('[data-analytics-button="share"]').click();
    await page.waitForSelector('.sharing-audiences input:not(:disabled)');
    await page.screenshot({ path: 'test-results/main-anyone-zh.png' });
    await rbacQuery("UPDATE users SET tenant_id='init' WHERE id=$1", [userId]);
    try {
      await openSharing();
      expect(await page.$('.sharing-audiences input[value="tenant"]')).toBeNull();
    } finally { await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, userId]); }
  });
});
