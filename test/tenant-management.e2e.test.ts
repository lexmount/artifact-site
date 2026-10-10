// Run against an isolated server and its disposable PostgreSQL database.
// Server: ARTIFACT_ADMIN_EMAILS=tenant-admin@example.test.
// Runner: TENANT_E2E_URL plus ARTIFACT_DB_DRIVER=postgres and the same ARTIFACT_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import type { Browser, Page } from "puppeteer-core";
import { closeDbForTests, createId, upsertUser, rbacQuery } from "@/lib/db";
import { mintSession } from "@/lib/session";
const base = process.env.TENANT_E2E_URL;
let browser: Browser;
async function button(page: Page, label: string, scope = "") {
  const buttons = await page.$$(`${scope}button`);
  for (const b of buttons) if ((await b.evaluate(el => el.textContent?.trim())) === label) { await b.click(); return; }
  throw new Error(`Button not found: ${label}`);
}
async function waitText(page: Page, selector: string, text: string) {
  await page.waitForFunction((s, t) => document.querySelector(s)?.textContent?.includes(t), {}, selector, text);
}

describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("tenant administration browser acceptance", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    mkdirSync("output/tenant-management-acceptance", { recursive: true });
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it("creates a tenant, edits roles, changes the default and renders both locales on desktop/mobile", async () => {
    const admin = await upsertUser({ authProvider: "tenant-e2e", providerSubject: "admin", email: "tenant-admin@example.test", emailVerified: true, displayName: "陈晨" });
    const person = await upsertUser({ authProvider: "tenant-e2e", providerSubject: createId("person"), email: `${createId("lin")}@example.test`, emailVerified: true, displayName: "林悦" });
    const { cookie } = await mintSession(new Request(base!), admin.id);
    const context = await browser.createBrowserContext();
    const pair = cookie.split(";")[0], split = pair.indexOf("=");
    await context.setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(base!).hostname, path: "/" }, { name: "ah_locale", value: "zh-CN", domain: new URL(base!).hostname, path: "/" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`${base}/admin/tenants`, { waitUntil: "networkidle0" });
    await waitText(page, "h1", "租户管理");
    await button(page, "新建租户");
    await page.waitForSelector("dialog[open]");
    await page.type("dialog input[maxlength='100']", "产品研发团队");
    const slug = "product-" + Date.now();
    await page.type("dialog input[maxlength='63']", slug);
    await page.type("dialog input[type='email']", admin.email!);
    await waitText(page, "dialog", "英文标识可用");
    await page.screenshot({ path: "output/tenant-management-acceptance/create-zh.png", fullPage: true });
    await button(page, "新建租户", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    await waitText(page, "table", slug);
    await page.screenshot({ path: "output/tenant-management-acceptance/list-zh.png", fullPage: true });
    const [tenant] = await rbacQuery("SELECT id FROM tenants WHERE slug=$1", [slug]);
    const tenantId = tenant.id as string;
    await page.goto(`${base}/admin/tenants/${tenantId}`, { waitUntil: "networkidle0" });
    await page.type("input[type='email']", person.email!);
    await button(page, "添加成员");
    await waitText(page, "table", person.email!);
    const role = `select[aria-label='林悦 的角色']`;
    await page.select(role, "admin");
    await page.waitForFunction(s => !(document.querySelector(s) as HTMLSelectElement)?.disabled, {}, role);
    await page.waitForFunction(s => (document.querySelector(s) as HTMLSelectElement)?.value === "admin", {}, role);
    await page.screenshot({ path: "output/tenant-management-acceptance/members-zh.png", fullPage: true });
    expect(await rbacQuery("SELECT role FROM authorization_tenant_members WHERE tenant_id=$1 AND user_id=$2", [tenantId, person.id])).toEqual([{ role: "admin" }]);
    await page.goto(`${base}/admin/users`, { waitUntil: "networkidle0" });
    await page.type("input[type='search']", person.email!);
    await page.waitForFunction(email => { const rows = document.querySelectorAll(".admin-table tbody tr"); return rows.length === 1 && rows[0].textContent?.includes(email); }, {}, person.email!);
    await button(page, "修改默认租户");
    await page.select("dialog select", tenantId);
    await waitText(page, "dialog", "现有角色保持不变");
    await page.screenshot({ path: "output/tenant-management-acceptance/default-zh.png", fullPage: true });
    await button(page, "保存修改", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    await waitText(page, "table", "产品研发团队");
    expect(await rbacQuery("SELECT tenant_id FROM users WHERE id=$1", [person.id])).toEqual([{ tenant_id: tenantId }]);
    expect(await rbacQuery("SELECT tenant_id FROM tenant_members WHERE user_id=$1 AND tenant_id='init'", [person.id])).toHaveLength(1);
    await page.goto(`${base}/admin/tenants/${tenantId}`, { waitUntil: "networkidle0" });
    await waitText(page, ".tenant-members", "请先修改该用户的默认发布租户");
    await button(page, "基本设置");
    await button(page, "重命名");
    await page.$eval("dialog input[maxlength='100']", el => { (el as HTMLInputElement).select(); });
    await page.type("dialog input[maxlength='100']", "设计团队");
    await button(page, "保存修改", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    await waitText(page, ".tenant-detail-title", "设计团队");
    await button(page, "禁用租户");
    await waitText(page, "dialog", "系统不会自动修改");
    await button(page, "禁用租户", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    await waitText(page, ".tenant-detail-title", "已禁用");
    await button(page, "启用租户");
    await button(page, "启用租户", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    expect(await rbacQuery("SELECT slug,disabled_at FROM tenants WHERE id=$1", [tenantId])).toEqual([{ slug, disabled_at: null }]);
    // Offboarding never needs to temporarily restore the account's access.
    const { disableUser } = await import("@/lib/admin");
    await disableUser(new Request(base!), { kind: "token", userId: null }, person.id, "Offboarding");
    await page.goto(`${base}/admin/users`, { waitUntil: "networkidle0" });
    await page.type("input[type='search']", person.email!);
    await page.waitForFunction(email => { const rows = document.querySelectorAll(".admin-table tbody tr"); return rows.length === 1 && rows[0].textContent?.includes(email); }, {}, person.email!);
    await button(page, "修改默认租户");
    await waitText(page, "dialog", "该账号将保持停用");
    await page.select("dialog select", "init");
    await button(page, "保存修改", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    await waitText(page, "table", "已禁用");
    const [disabledUser] = await rbacQuery("SELECT disabled_at,tenant_id FROM users WHERE id=$1", [person.id]);
    expect(disabledUser.disabled_at).not.toBeNull();
    expect(disabledUser.tenant_id).toBe("init");
    // Upgrade recovery is available in both the tenant list and its settings.
    await rbacQuery("UPDATE tenants SET disabled_at=123 WHERE id='init'");
    try {
      await page.goto(`${base}/admin/tenants`, { waitUntil: "networkidle0" });
      await page.waitForSelector("button[aria-label='init 的操作']");
      await page.click("button[aria-label='init 的操作']");
      await button(page, "启用租户", ".more-menu ");
      await button(page, "取消", "dialog ");
      await page.goto(`${base}/admin/tenants/init`, { waitUntil: "networkidle0" });
      await button(page, "基本设置");
      await button(page, "启用租户");
      await button(page, "启用租户", "dialog ");
      await page.waitForSelector("dialog", { hidden: true });
      expect(await rbacQuery("SELECT disabled_at FROM tenants WHERE id='init'")).toEqual([{ disabled_at: null }]);
      expect(await page.$$eval("button", buttons => buttons.some(b => b.textContent?.trim() === "禁用租户"))).toBe(false);
    } finally { await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id='init'"); }
    // A filtered last page must remain usable after removing its only member.
    const search = createId("pagination");
    for (let i = 0; i < 26; i++) {
      const member = await upsertUser({ authProvider: "tenant-e2e", providerSubject: createId("page"), email: `${search}-${i}@example.test`, emailVerified: true, displayName: `${search} ${i}` });
      const status = await page.evaluate(async ({ tenantId, userId }) => (await fetch(`/api/tenants/${tenantId}/members`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, role: "member" }) })).status, { tenantId, userId: member.id });
      expect(status).toBe(200);
    }
    await page.goto(`${base}/admin/tenants/${tenantId}`, { waitUntil: "networkidle0" });
    await page.type(".tenant-member-search", search);
    await waitText(page, ".admin-pager", "1–25 / 26");
    await button(page, "下一页", ".admin-pager ");
    await waitText(page, ".admin-pager", "26–26 / 26");
    expect(await page.$$(".tenant-members tbody tr")).toHaveLength(1);
    const removedEmail = await page.$eval(".tenant-members tbody tr .admin-slug", el => el.textContent);
    await button(page, "移除", ".tenant-members tbody ");
    await page.waitForSelector("dialog[open]");
    await button(page, "移除", "dialog ");
    await page.waitForSelector("dialog", { hidden: true });
    expect(await page.$eval(".tenant-member-search", el => (el as HTMLInputElement).value)).toBe(search);
    expect(await page.$$(".tenant-members tbody tr")).toHaveLength(25);
    expect(await page.$(".admin-pager")).toBeNull();
    expect(await page.$eval(".tenant-members tbody", el => el.textContent)).not.toContain(removedEmail);
    for (const locale of ["en", "zh-CN"]) {
      await context.setCookie({ name: "ah_locale", value: locale, domain: new URL(base!).hostname, path: "/" });
      for (const width of [1440, 390]) {
        await page.setViewport({ width, height: 1000 });
        for (const [name, path] of [["list", "/admin/tenants"], ["members", `/admin/tenants/${tenantId}`], ["users", "/admin/users"]]) {
          await page.goto(base + path, { waitUntil: "networkidle0" });
          await page.waitForSelector("table tbody tr");
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          const dimensions = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: window.innerWidth }));
          expect(dimensions.actual, `${name} ${locale} ${width}`).toBeLessThanOrEqual(dimensions.viewport);
          await page.screenshot({ path: `output/tenant-management-acceptance/${name}-${locale}-${width}.png`, fullPage: true });
        }
      }
    }
    expect(errors).toEqual([]);
    await context.close();
  }, 120_000);
});
