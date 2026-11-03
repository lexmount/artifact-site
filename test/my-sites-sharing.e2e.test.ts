// Run against a disposable Postgres-backed app with MY_SITES_E2E_URL and ARTIFACT_DATABASE_URL.
import { mkdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { closeDbForTests, createId, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

const base = process.env.MY_SITES_E2E_URL;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("My sites sharing and drag acceptance", () => {
  let browser: Browser, context: BrowserContext, page: Page;
  let userId: string, tenant: string, plain: string, shared: string;
  let headers: Record<string, string>;
  const slugs: string[] = [], errors: string[] = [];
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const row = (index: number) => `[data-slug="${slugs[index]}"]`;
  const target = (id: string) => `.folder[data-folder-id="${id}"]`;
  async function clickText(label: string, selector = 'dialog[open] button') {
    await page.waitForFunction((s, text) => Array.from(document.querySelectorAll(s)).some(el => el.textContent?.trim() === text && !(el as HTMLButtonElement).disabled), {}, selector, label);
    for (const element of await page.$$(selector)) if ((await element.evaluate(el => el.textContent?.trim())) === label) { await element.click(); return; }
    throw new Error(`Missing button: ${label}`);
  }
  async function closeDialog() { await page.click('dialog[open] header button[aria-label="关闭"]'); await page.waitForSelector('dialog[open]', { hidden: true }); }
  async function directory(view = "list") {
    await page.goto(`${base}/me?view=${view}&lang=zh-CN`, { waitUntil: "networkidle2" });
    await page.waitForSelector(row(0));
    await page.waitForSelector('.collection-share-action');
  }
  async function openScope(folderId?: string) {
    await page.goto(`${base}/me?lang=zh-CN${folderId ? `&folder=${folderId}` : ""}`, { waitUntil: "networkidle2" });
    await page.click(folderId ? '.folder-heading-actions button[aria-label="分享文件夹"]' : '.collection-share-action');
    await page.waitForSelector('dialog[open] .scope-policy-fields select');
  }
  async function screenshot(name: string) {
    await page.screenshot({ path: `test-results/my-sites-${name}.png`, fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  async function drag(index: number, folder: string, capture = false) {
    const source = await page.$(`${row(index)} ${await page.$(`${row(index)} .site-name strong`) ? '.site-name strong' : '.recent-title'}`);
    const destination = await page.$(target(folder));
    const a = await source!.boundingBox(), b = await destination!.boundingBox();
    const to = { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
    const data = await page.mouse.drag({ x: a!.x + a!.width / 2, y: a!.y + a!.height / 2 }, to);
    await page.mouse.dragEnter(to, data);
    await page.mouse.dragOver(to, data);
    if (capture) { await page.waitForSelector(`${target(folder)}[data-drop-active]`); await screenshot("batch-drag"); }
    await page.mouse.drop(to, data);
    await page.mouse.up();
  }
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    mkdirSync("test-results", { recursive: true });
    const user = await upsertUser({ authProvider: "my-sites-review", providerSubject: createId("owner"), displayName: "设计验收" });
    userId = user.id; tenant = createId("design-team");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Design team')", [tenant]);
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant, userId]);
    await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, userId]);
    const { cookie } = await mintSession(new Request(base!), userId);
    const pair = cookie.split(";")[0], split = pair.indexOf("=");
    headers = { cookie: pair, origin: base!, "content-type": "application/json" };
    for (const title of ["产品体验演示", "季度复盘报告", "交互原型"]) {
      const site = await api("/api/sites", "POST", { mode: "paste", title, html: `<html><body><h1>${title}</h1><p>Design acceptance</p></body></html>` });
      slugs.push(site.slug);
      await api(`/api/sites/${site.slug}/main-sharing`, "PUT", { action: "custom", policy: { audience: "private", comments: true } });
    }
    plain = (await api("/api/me/folders", "POST", { name: "研究资料" })).folder.id;
    shared = (await api("/api/me/folders", "POST", { name: "产品设计" })).folder.id;
    const body = { folderId: shared, enabled: true, policy: { audience: "anyone", comments: true } };
    const preview = await api("/api/me/sharing/scopes", "POST", body);
    await api("/api/me/sharing/scopes", "POST", { ...body, confirmation: preview.confirmation });
    context = await browser.createBrowserContext();
    await context.setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(base!).hostname, path: "/" });
    page = await context.newPage();
    page.on("pageerror", error => { errors.push(String(error)); console.error(error); });
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setDragInterception(true);
  }, 120000);
  afterEach(async (test) => {
    if (test.task.result?.state === "fail" && page) {
      await page.screenshot({ path: "test-results/my-sites-failure.png" });
      console.error(await page.evaluate(() => document.body.innerText));
    }
    await page?.mouse.up().catch(() => {});
    await page?.setRequestInterception(false);
    page?.removeAllListeners('request');
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });

  it("keeps opens on one line, adds the Unfiled icon and presents compact explicit sharing", async () => {
    await directory();
    expect(await page.$(`${target("unfiled")} .lucide-inbox`)).not.toBeNull();
    expect(await page.$eval('.list-header .row-views', el => ({ whiteSpace: getComputedStyle(el).whiteSpace, fits: el.scrollWidth <= el.clientWidth }))).toEqual({ whiteSpace: "nowrap", fits: true });
    await screenshot("directory-desktop");
    await openScope();
    expect(await page.$$eval('dialog .scope-policy-fields option', elements => elements.map(el => (el as HTMLOptionElement).value))).toEqual(["private", "tenant", "login", "anyone"]);
    await page.select('dialog select', 'login');
    expect((await api('/api/me/sharing/scopes')).enabled).toBe(false);
    await clickText('保存');
    await page.waitForSelector('.scope-impact');
    expect((await api('/api/me/sharing/scopes')).enabled).toBe(false);
    expect(await page.$eval('.scope-impact details', el => (el as HTMLDetailsElement).open)).toBe(false);
    await screenshot("first-enable");
    await clickText('返回');
    await page.select('dialog select', 'tenant');
    await clickText('保存');
    await clickText('开启分享');
    await page.waitForSelector('.scope-link-compact');
    expect((await api('/api/me/sharing/scopes')).policy.audience).toBe('tenant');
    expect(await page.$eval('dialog[open]', el => el.getBoundingClientRect().height)).toBeLessThan(600);
    await screenshot("share-all-desktop");
    await closeDialog();
    await openScope(shared);
    await screenshot("share-folder-desktop");
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => { throw new Error("Clipboard denied"); } }); });
    await clickText('复制链接');
    await page.waitForSelector('.scope-link input');
    expect(await page.$eval('.scope-link input', el => (el as HTMLInputElement).value)).toContain('/c/');
    await closeDialog();
  });

  it("files selected rows directly, but dragging an unselected row affects only that row", async () => {
    await directory();
    await page.click(`${row(0)} input[type=checkbox]`);
    await page.click(`${row(1)} input[type=checkbox]`);
    await drag(0, plain, true);
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '2', {}, `${target(plain)} b`);
    expect(await page.$('dialog[open]')).toBeNull();
    let shelf = await api('/api/me/folders');
    expect(shelf.assign[slugs[0]]).toBe(plain); expect(shelf.assign[slugs[1]]).toBe(plain);
    await page.click(`${row(0)} input[type=checkbox]`);
    await page.click(`${row(1)} input[type=checkbox]`);
    await drag(2, shared);
    await page.waitForSelector('dialog .scope-impact');
    expect(await page.$eval('dialog .scope-object', el => el.textContent)).toContain('1 个作品');
    expect(await page.$eval('.scope-impact-access', el => el.textContent)).toContain('任何人');
    await screenshot("move-confirmation");
    await closeDialog();
    expect((await api('/api/me/folders')).assign[slugs[2]]).toBeUndefined();
    await drag(2, shared);
    await clickText('移动并更新');
    await page.waitForSelector('dialog[open]', { hidden: true });
    shelf = await api('/api/me/folders');
    expect(shelf.assign[slugs[0]]).toBe(plain); expect(shelf.assign[slugs[1]]).toBe(plain); expect(shelf.assign[slugs[2]]).toBe(shared);
    expect((await api(`/api/sites/${slugs[2]}/main-sharing`)).source).toBe('folder');
  });

  it("supports card selection, grid moves to Unfiled, failed moves and keyboard alternatives", async () => {
    await directory('grid');
    expect(await page.$(`${row(0)} input[type=checkbox]`)).not.toBeNull();
    await drag(2, 'unfiled');
    await clickText('移动并更新');
    await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await api('/api/me/folders')).assign[slugs[2]]).toBeUndefined();
    let fail = true;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const body = request.postData();
      if (fail && request.url().endsWith('/api/me/sharing/move') && body && JSON.parse(body).confirmation) {
        fail = false; void request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary failure' }) });
      } else void request.continue();
    });
    await drag(2, plain);
    await page.waitForFunction(() => document.querySelector('.folder-note')?.textContent?.includes('Temporary failure'));
    expect((await api('/api/me/folders')).assign[slugs[2]]).toBeUndefined();
    await page.click(`${row(2)} .more-button`);
    const picker = '.more-menu:not([hidden]) .row-menu-move select';
    await page.waitForSelector(picker);
    await page.focus(picker);
    await page.select(picker, plain);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '3', {}, `${target(plain)} b`);
    expect((await api('/api/me/folders')).assign[slugs[2]]).toBe(plain);
    await screenshot("grid-filed");
  });

  it("hides organization choices for init users, preserves existing access, and fits narrow screens", async () => {
    await rbacQuery("UPDATE users SET tenant_id='init' WHERE id=$1", [userId]);
    for (const folder of [undefined, shared]) {
      await openScope(folder);
      expect(await page.$('dialog option[value="tenant"]')).toBeNull();
      if (!folder) {
        expect((await api('/api/me/sharing/scopes')).policy.audience).toBe('tenant');
        expect(await page.$eval('dialog select', el => (el as HTMLSelectElement).value)).toBe('');
        expect(await page.$eval('dialog footer .solid', el => (el as HTMLButtonElement).disabled)).toBe(true);
      }
      await screenshot(folder ? "init-folder" : "init-all");
      await closeDialog();
    }
    await page.goto(`${base}/s/${slugs[0]}?lang=zh-CN`, { waitUntil: "networkidle2" });
    await page.click('[data-analytics-button="share"]');
    await page.waitForSelector('.sharing-audiences');
    expect(await page.$('.sharing-audiences input[value="tenant"]')).toBeNull();
    expect(await page.$eval('.sharing-audiences input[value="private"]', el => el.closest('label')?.textContent)).toContain('私有');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await openScope(shared);
    await screenshot("share-folder-mobile");
    expect(await page.$eval('dialog footer', el => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    expect(await page.$eval('dialog[open]', el => el.getBoundingClientRect().height)).toBeLessThan(600);
    expect(await page.$eval('dialog[open]', el => Math.abs(el.getBoundingClientRect().left - (innerWidth - el.getBoundingClientRect().right)))).toBeLessThan(2);
    await closeDialog();
    await directory('grid');
    await page.click('.mobile-folders');
    expect(await page.$(`${target('unfiled')} .lucide-inbox`)).not.toBeNull();
    await screenshot("directory-mobile");
    expect(errors).toEqual([]);
  });

  it.each([false, true])("reviews a concurrently stopped or changed scope before saving (folder=%s)", async folderScope => {
    await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, userId]);
    await page.setViewport({ width: 1440, height: 1000 });
    const folderId = folderScope ? (await api('/api/me/folders', 'POST', { name: '并发分享' })).folder.id : null;
    const site = await api('/api/sites', 'POST', { mode: 'paste', html: '<h1>Independent settings</h1>', title: '独立设置作品' });
    if (folderId) await api('/api/me/folders/assignments', 'PUT', { slug: site.slug, folderId });
    const policy = { audience: 'private', comments: false };
    async function apply(enabled: boolean) {
      const body = { folderId, enabled, policy };
      const preview = await api('/api/me/sharing/scopes', 'POST', body);
      await api('/api/me/sharing/scopes', 'POST', { ...body, confirmation: preview.confirmation });
    }
    const scopePath = `/api/me/sharing/scopes${folderId ? `?folderId=${folderId}` : ''}`;
    await apply(true);
    await api(`/api/sites/${site.slug}/main-sharing`, 'PUT', { action: 'custom', policy });
    await openScope(folderId ?? undefined);
    // Another tab stops the scope while this dialog retains its enabled snapshot.
    await apply(false);
    await page.click('dialog input[role="switch"]');
    await clickText('保存');
    await page.waitForSelector('dialog .scope-impact');
    expect((await api(scopePath)).enabled).toBe(false);
    expect(await api(`/api/sites/${site.slug}/main-sharing`)).toMatchObject({ source: 'manual', policy });
    await clickText('开启分享');
    await page.waitForSelector('dialog .scope-link');
    expect(await api(`/api/sites/${site.slug}/main-sharing`)).toMatchObject({ source: folderScope ? 'folder' : 'all', policy: { ...policy, comments: true } });
    // A fresh comments-only save still completes without another confirmation.
    await page.click('dialog input[role="switch"]');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/sharing/scopes' && response.request().method() === 'GET');
    await clickText('保存');
    expect((await refreshed).ok()).toBe(true);
    await page.waitForFunction(() => {
      const save = document.querySelector<HTMLButtonElement>('dialog footer .solid');
      return save?.disabled && save.textContent === '保存' && document.querySelector('dialog .scope-success');
    });
    expect(await page.$('dialog .scope-impact')).toBeNull();
    expect((await api(scopePath)).policy.comments).toBe(false);
    // Even when the scope remains enabled, a new revision requires review.
    await apply(true);
    await page.click('dialog input[role="switch"]');
    await clickText('保存');
    await page.waitForSelector('dialog .scope-impact');
    expect((await api(scopePath)).policy.comments).toBe(false);
    await closeDialog();
  });
});
