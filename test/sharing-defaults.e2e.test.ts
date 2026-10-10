// Run with SHARING_E2E_URL and ARTIFACT_DB_DRIVER=postgres against an isolated server/database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import type { Browser, Page } from "puppeteer-core";
import { closeDbForTests, createId, upsertUser, rbacQuery } from "@/lib/db";
import { mintSession } from "@/lib/session";
const base = process.env.SHARING_E2E_URL;
let browser: Browser;
async function button(page: Page, label: string, scope = "") {
  await page
    .waitForFunction(
      (s, l) =>
        Array.from(document.querySelectorAll(s + "button")).some(
          (b) => b.textContent?.trim() === l,
        ),
      { timeout: 12000 },
      scope,
      label,
    )
    .catch(async () => {
      await page.screenshot({
        path: "output/sharing-acceptance/failure.png",
        fullPage: true,
      });
      throw new Error(
        `Missing ${label}: ${await page.evaluate(() => document.body.innerText)}`,
      );
    });
  for (const b of await page.$$(`${scope}button`))
    if ((await b.evaluate((el) => el.textContent?.trim())) === label) {
      await b.click();
      return;
    }
  throw new Error(`Button not found: ${label}`);
}
async function text(page: Page, selector: string, value: string) {
  await page
    .waitForFunction(
      (s, v) => document.querySelector(s)?.textContent?.includes(v),
      { timeout: 15000 },
      selector,
      value,
    )
    .catch(async () => {
      await page.screenshot({
        path: "output/sharing-acceptance/failure.png",
        fullPage: true,
      });
      throw new Error(
        `Missing text ${value}: ${await page.evaluate(() => document.body.innerText)}`,
      );
    });
}
async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async (p, m, b) => {
      const r = await fetch(p, {
        method: m,
        headers: { "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return data;
    },
    path,
    method,
    body,
  );
}
async function shot(page: Page, name: string) {
  await page.screenshot({
    path: `output/sharing-acceptance/${name}.png`,
    fullPage: !(await page.$("dialog[open]")),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)(
  "default and scope sharing browser acceptance",
  () => {
    beforeAll(async () => {
      const { default: puppeteer } = await import("puppeteer-core");
      browser = await puppeteer.launch({
        executablePath:
          process.env.E2E_CHROME ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: true,
        args: process.env.CI ? ["--no-sandbox"] : [],
      });
      mkdirSync("output/sharing-acceptance", { recursive: true });
    });
    afterAll(async () => {
      await browser?.close();
      await closeDbForTests();
    });
    it.each([{ locale: "en", width: 1440 }, { locale: "zh-CN", width: 390 }])("keeps sharing controls reachable and settings discoverable in $locale", async ({ locale, width }) => {
      const owner = await upsertUser({ authProvider: "sharing-ux", providerSubject: createId("owner"), email: "sharing-admin@example.test", emailVerified: true });
      const tenantId = createId("tenant"), name = `ZZ Default ${locale}`;
      await rbacQuery("INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)", [tenantId, name, tenantId]);
      await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenantId, owner.id]);
      await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenantId, owner.id]);
      const context = await browser.createBrowserContext();
      const pair = (await mintSession(new Request(base!), owner.id)).cookie.split(";")[0];
      await context.setCookie({ name: pair.split("=")[0], value: pair.split("=")[1], domain: new URL(base!).hostname, path: "/" }, { name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" });
      const page = await context.newPage();
      await page.setViewport({ width, height: 844 });
      const zh = locale === "zh-CN";
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(String(e)));
      try {
        await page.goto(`${base}/admin/tenants`, { waitUntil: "networkidle2" });
        await page.waitForSelector(`a.tenant-name-link[href$='${tenantId}']`);
        // The identifier cell opens the detail too; navigation is not limited to Members.
        await page.evaluate(id => { const row = document.querySelector(`a[href$='${id}'].tenant-name-link`)!.closest("tr")!; (row.children[1] as HTMLElement).click(); }, tenantId);
        await page.waitForSelector(".tenant-settings-sections .sharing-defaults");
        expect(await page.$$eval('.hm-tabs [role="tab"]', els => els.map(e => e.textContent))).toEqual(zh ? ["成员", "设置"] : ["Members", "Settings"]);
        await shot(page, `ux-tenant-settings-${locale}`);
        await page.goto(`${base}/me/sharing`, { waitUntil: "networkidle2" });
        await text(page, ".scope-default-tenant", name);
        expect(await page.$(".scope-tenant-picker")).toBeNull();
        expect(await page.$(".sharing-preferences-page select")).toBeNull();
        await shot(page, `ux-personal-default-${locale}`);
        const sites = [];
        for (let i = 0; i < 12; i++) sites.push(await api(page, "/api/sites", "POST", { mode: "paste", html: "<h1>Preview</h1>", title: `Long document title for permission preview ${i}` }));
        await page.goto(`${base}/s/${sites[0].slug}`, { waitUntil: "networkidle2" });
        await page.waitForSelector('[data-analytics-button="share"]', { visible: true });
        await page.click('[data-analytics-button="share"]');
        await page.waitForSelector(".sharing-main-policy select");
        expect(await page.$(".sharing-main-policy .scope-notice")).toBeNull();
        expect(await page.$(".sharing-main-policy .scope-source")).toBeNull();
        await shot(page, `ux-document-default-${locale}`);
        const { createUserFolder, assignUserSite } = await import("@/lib/user-folders");
        const folder = await createUserFolder(owner.id, "UX Folder");
        for (const site of sites) await assignUserSite(owner.id, site.slug, folder.id);
        for (const kind of ["all", "folder"]) {
          await page.goto(`${base}/me?folder=${folder.id}`, { waitUntil: "networkidle2" });
          if (kind === "all") {
            await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
            await page.click('.work-tabs-tools button[aria-haspopup="menu"]');
            expect(await page.$('[role="menu"] a[href$="/admin/tenants"]')).not.toBeNull();
            expect(await page.$('[role="menu"] a[href$="/tenants"]:not([href$="/admin/tenants"])')).toBeNull();
            await page.keyboard.press('Escape');
            expect(await page.$('.scope-all-entry')).toBeNull();
            expect(await page.$('.folder-rail nav .folder:first-child .lucide-panels-top-left')).not.toBeNull();
            expect(await page.$('.folder-rail nav .folder:first-child .folder-share-badge')).toBeNull();
            await page.click(`.folder-heading-actions [aria-label="${zh ? "分享我的全部站点" : "Share my entire collection"}"]`);
          } else {
            await page.click(`.folder-heading-actions [aria-label="${zh ? "分享文件夹" : "Share folder"}"]`);
          }
          await page.waitForSelector("dialog select");
          await button(page, zh ? "预览权限变化" : "Review changes", "dialog ");
          await page.waitForSelector(".scope-impact details");
          await page.$eval(".scope-impact details", el => { (el as HTMLDetailsElement).open = true; });
          const bounds = await page.evaluate(() => {
            const body = document.querySelector(".scope-dialog-body")!, footer = document.querySelector("dialog.scope-dialog footer")!;
            const b = body.getBoundingClientRect(), f = footer.getBoundingClientRect();
            body.scrollTop = body.scrollHeight;
            return { bottom: b.bottom, footer: f.top, footerBottom: f.bottom, viewport: innerHeight, scrollable: body.scrollHeight > body.clientHeight };
          });
          expect(bounds.bottom).toBeLessThanOrEqual(bounds.footer + 1);
          expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.viewport);
          expect(bounds.scrollable).toBe(true);
          await shot(page, `ux-${kind}-preview-${locale}`);
          await button(page, zh ? "开启分享" : "Enable sharing", "dialog ");
          await page.waitForSelector("dialog .scope-link input");
          await page.click(`dialog [aria-label="${zh ? "关闭" : "Close"}"]`);
        }
        await page.goto(`${base}/me?folder=${folder.id}`, { waitUntil: "networkidle2" });
        expect(await page.$$('.folder-heading-actions button')).toHaveLength(3);
        expect(await page.$('.folder-rail .folder-actions')).toBeNull();
        if (width < 600) await page.click('.mobile-folders');
        expect(await page.$('.folder[aria-current="true"] .lucide-folder')).not.toBeNull();
        expect(await page.$('.folder[aria-current="true"] .folder-share-badge')).not.toBeNull();
        expect(await page.$('.folder-rail nav .folder:first-child .folder-share-badge')).not.toBeNull();
        if (zh) await text(page, '.folder-hint', '文件夹用于整理文档，文件夹粒度的分享会同步改变内部文档的可见性。');
        if (width < 600) await page.click('.mobile-folders');
        const rename = `.folder-heading-actions [aria-label="${zh ? "重命名" : "Rename"}"]`;
        await page.click(rename);
        await page.waitForSelector('dialog[open] input');
        await page.$eval('dialog input', el => (el as HTMLInputElement).select());
        await page.type('dialog input', 'Cancelled name');
        await button(page, zh ? "取消" : "Cancel", "dialog ");
        await text(page, '.folder-heading h2', 'UX Folder');
        await page.click(rename);
        await page.waitForSelector('dialog[open] input');
        expect(await page.$eval('dialog input', el => (el as HTMLInputElement).value)).toBe('UX Folder');
        await page.$eval('dialog input', el => (el as HTMLInputElement).select());
        await page.type('dialog input', 'Renamed folder');
        expect(await page.$eval('dialog[open]', el => el.getBoundingClientRect().height)).toBeLessThan(400);
        await shot(page, `folder-rename-${locale}`);
        let failRename = true;
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (failRename && request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith(`/folders/${folder.id}`)) {
            failRename = false;
            void request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary failure' }) });
          } else void request.continue();
        });
        await button(page, zh ? "确认修改" : "Confirm changes", "dialog ");
        await page.waitForSelector('dialog[open] .drawer-error');
        expect(await page.$eval('dialog input', el => (el as HTMLInputElement).value)).toBe('Renamed folder');
        await text(page, '.folder-heading h2', 'UX Folder');
        await button(page, zh ? "确认修改" : "Confirm changes", "dialog ");
        await page.waitForSelector('dialog[open]', { hidden: true });
        await text(page, '.folder-heading h2', 'Renamed folder');
        await shot(page, `folder-actions-${locale}`);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
    it("saves defaults, applies folder/all scopes, previews moves, restores defaults and checks both locales", async () => {
      const owner = await upsertUser({
        authProvider: "sharing-e2e",
        providerSubject: createId("owner"),
        email: "sharing-admin@example.test",
        emailVerified: true,
        displayName: "林悦",
      });
      const reader = await upsertUser({
        authProvider: "sharing-e2e",
        providerSubject: createId("reader"),
        email: createId("reader") + "@example.test",
        emailVerified: true,
      });
      const other = createId("tenant");
      await rbacQuery(
        "INSERT INTO tenants(id,name) VALUES($1,'Partner team')",
        [other],
      );
      await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [
        reader.id,
      ]);
      await rbacQuery(
        "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
        [other, reader.id],
      );
      const context = await browser.createBrowserContext();
      const { cookie } = await mintSession(new Request(base!), owner.id);
      const pair = cookie.split(";")[0],
        i = pair.indexOf("=");
      await context.setCookie(
        {
          name: pair.slice(0, i),
          value: pair.slice(i + 1),
          domain: new URL(base!).hostname,
          path: "/",
        },
        {
          name: "ah_locale",
          value: "zh-CN",
          domain: new URL(base!).hostname,
          path: "/",
        },
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.setViewport({ width: 1440, height: 1050 });
      await page.goto(`${base}/admin/tenants/init`, {
        waitUntil: "networkidle2",
      });
      await button(page, "设置");
      await page.waitForSelector(".scope-policy-fields select");
      await page.select(".scope-policy-fields select", "tenant");
      await button(page, "保存设置");
      await text(page, ".sharing-defaults", "分享偏好已保存");
      await shot(page, "01-tenant-defaults-zh");
      await page.goto(`${base}/me/sharing`, { waitUntil: "networkidle2" });
      await text(page, ".sharing-defaults", "继承租户设置");
      await shot(page, "02-user-inherit-zh");
      await page.click(".scope-inheritance label:nth-of-type(2)");
      await page.select(".scope-policy-fields select", "private");
      await button(page, "保存设置");
      await text(page, ".sharing-defaults", "分享偏好已保存");
      await shot(page, "03-user-custom-zh");
      const first = await api(page, "/api/sites", "POST", {
        mode: "paste",
        html: "<h1>Product brief</h1>",
        title: "产品需求说明",
      });
      const second = await api(page, "/api/sites", "POST", {
        mode: "paste",
        html: "<h1>Design notes</h1>",
        title: "设计规范",
      });
      const { createUserFolder, assignUserSite } = await import(
        "@/lib/user-folders"
      );
      const folder = await createUserFolder(owner.id, "项目资料");
      await assignUserSite(owner.id, first.slug, folder.id);
      await page.goto(`${base}/me?folder=${folder.id}`, {
        waitUntil: "networkidle2",
      });
      await page.waitForSelector('.folder-heading-actions [aria-label="分享文件夹"]');
      await page.click('.folder-heading-actions [aria-label="分享文件夹"]');
      await text(page, "dialog", "项目资料");
      await shot(page, "04-folder-config-zh");
      await button(page, "预览权限变化", "dialog ");
      await text(page, "dialog", "篇文档将更新");
      await shot(page, "05-folder-preview-zh");
      await button(page, "开启分享", "dialog ");
      await page.waitForSelector("dialog .scope-link input");
      const collection = await api(
        page,
        "/api/me/sharing/scopes?folderId=" + folder.id,
      );
      await shot(page, "06-folder-enabled-zh");
      await page.click('dialog [aria-label="关闭"]');
      await page.goto(`${base}/s/${first.slug}`, { waitUntil: "networkidle2" });
      await button(page, "分享设置");
      await text(page, ".sharing-main-policy", "正在跟随");
      await shot(page, "07-document-follow-zh");
      await page.select(".sharing-main-policy select", "private");
      await button(page, "保存并单独设置");
      await text(page, ".sharing-main-policy", "恢复跟随");
      await shot(page, "08-document-custom-zh");
      await button(page, "恢复跟随");
      await text(page, "dialog", "变更后权限");
      await shot(page, "09-resume-preview-zh");
      await button(page, "确认恢复", "dialog ");
      await page.waitForSelector("dialog.scope-dialog", { hidden: true });
      await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
      await page.waitForSelector(
        `[data-slug='${second.slug}'] input[type=checkbox]`,
      );
      await page.click(`[data-slug='${second.slug}'] input[type=checkbox]`);
      await button(page, "批量移动文档");
      await page.select("dialog select", folder.id);
      await text(page, "dialog", "1 篇将跟随所属文件夹");
      await shot(page, "10-move-preview-zh");
      await button(page, "确认移动", "dialog ");
      await page.waitForSelector("dialog", { hidden: true });
      expect(
        (await api(page, `/api/sites/${second.slug}/main-sharing`)).source,
      ).toBe("folder");
      await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
      await page.click('.folder-heading-actions [aria-label="分享我的全部站点"]');
      await text(page, "dialog", "跨租户");
      await page.select("dialog select", "login");
      await button(page, "预览权限变化", "dialog ");
      await button(page, "开启分享", "dialog ");
      await page.waitForSelector("dialog .scope-link input");
      await shot(page, "11-all-sites-enabled-zh");
      await page.click('dialog [aria-label="关闭"]');
      const readerContext = await browser.createBrowserContext();
      const rc = (
        await mintSession(new Request(base!), reader.id)
      ).cookie.split(";")[0];
      const ri = rc.indexOf("=");
      await readerContext.setCookie(
        {
          name: rc.slice(0, ri),
          value: rc.slice(ri + 1),
          domain: new URL(base!).hostname,
          path: "/",
        },
        {
          name: "ah_locale",
          value: "en",
          domain: new URL(base!).hostname,
          path: "/",
        },
      );
      const rp = await readerContext.newPage();
      await rp.goto(base + collection.url, { waitUntil: "networkidle2" });
      await text(rp, ".collection-empty", "No accessible documents");
      expect(await rp.evaluate(() => document.body.innerText)).not.toContain(
        "产品需求说明",
      );
      await shot(rp, "12-cross-tenant-empty-en");
      await page.goto(base + collection.url, { waitUntil: "networkidle2" });
      await text(page, ".collection-list", "产品需求说明");
      await shot(page, "13-collection-zh");
      await page.click(`.collection-list a[href*='${first.slug}']`);
      await page.waitForSelector(".collection-return");
      await shot(page, "14-reader-return-zh");
      await page.goto(`${base}/me?folder=${folder.id}`, {
        waitUntil: "networkidle2",
      });
      await page.click('.folder-heading-actions [aria-label="分享文件夹"]');
      await page.waitForSelector("dialog .scope-link");
      await button(page, "停止统一分享", "dialog ");
      await button(page, "预览权限变化", "dialog ");
      await text(page, "dialog", "2 篇将跟随全部站点分享");
      await shot(page, "15-stop-folder-zh");
      await button(page, "停止并恢复", "dialog ");
      await page.waitForSelector("dialog", { hidden: true });
      await rp.goto(`${base}/s/${first.slug}`, { waitUntil: "networkidle2" });
      expect(await rp.$(".fs-viewer")).not.toBeNull();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${base}/me/sharing`, { waitUntil: "networkidle2" });
      await text(page, ".sharing-defaults", "单独设置");
      await shot(page, "16-mobile-defaults-zh");
      await context.setCookie({
        name: "ah_locale",
        value: "en",
        domain: new URL(base!).hostname,
        path: "/",
      });
      await page.reload({ waitUntil: "networkidle2" });
      await text(page, "h1", "Sharing preferences");
      await shot(page, "17-mobile-defaults-en");
      await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
      await page.goto(`${base}/me`, { waitUntil: "networkidle2" });
      await page.click('.folder-heading-actions [aria-label="Share my entire collection"]');
      await text(page, "dialog", "Across tenants");
      await shot(page, "18-mobile-scope-en");
      await button(page, "Stop unified sharing", "dialog ");
      await button(page, "Review changes", "dialog ");
      await text(page, "dialog", "2 documents will restore current defaults");
      await shot(page, "19-mobile-stop-all-sites-en");
      await button(page, "Stop and restore", "dialog ");
      await page.waitForSelector("dialog", { hidden: true });
      expect(
        (await api(page, `/api/sites/${first.slug}/main-sharing`)).policy
          .audience,
      ).toBe("private");
      await page.setViewport({ width: 1440, height: 1050 });
      await page.goto(`${base}/me?folder=${folder.id}`, {
        waitUntil: "networkidle2",
      });
      await page.click('.folder-heading-actions [aria-label="Delete folder"]');
      await text(page, "dialog", "Documents will not be deleted");
      await button(page, "Review changes", "dialog ");
      await shot(page, "20-delete-folder-en");
      await button(page, "Delete folder", "dialog ");
      await page.waitForSelector("dialog", { hidden: true });
      const independent = await api(
        page,
        `/api/sites/${first.slug}/shares`,
        "POST",
        { policy: "public" },
      );
      await page.goto(`${base}/s/${first.slug}`, { waitUntil: "networkidle2" });
      await button(page, "Sharing");
      await text(page, ".sharing-main-policy", "Other access: 1");
      await button(page, "Stop all sharing for this document");
      await text(
        page,
        "dialog.scope-dialog",
        "Independent links and direct grants are revoked",
      );
      await shot(page, "21-stop-document-en");
      await button(page, "Stop all sharing", "dialog.scope-dialog ");
      await page.waitForSelector("dialog.scope-dialog", { hidden: true });
      expect(
        (await api(page, `/api/sites/${first.slug}/main-sharing`)).links,
      ).toBe(0);
      const guestContext = await browser.createBrowserContext(),
        guest = await guestContext.newPage();
      await guestContext.setCookie({
        name: "ah_locale",
        value: "en",
        domain: new URL(base!).hostname,
        path: "/",
      });
      await guest.goto(base + collection.url, { waitUntil: "networkidle2" });
      await text(guest, ".collection-empty", "Collection link disabled");
      await shot(guest, "22-disabled-collection-en");
      await guest.goto(`${base}/v/${independent.token}`, {
        waitUntil: "networkidle2",
      });
      await text(guest, "h1", "This link is no longer valid");
      expect(await guest.$("iframe")).toBeNull();
      await guestContext.close();
      expect(errors).toEqual([]);
      await context.close();
      await readerContext.close();
    }, 180000);
  },
);
