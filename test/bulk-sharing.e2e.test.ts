// Run with MY_SITES_E2E_URL and a disposable ARTIFACT_DATABASE_URL.
import { mkdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { closeDbForTests, createId, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
const base = process.env.MY_SITES_E2E_URL;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("Selected-site sharing acceptance", () => {
  let browser: Browser, page: Page, headers: Record<string, string>;
  const slugs: string[] = [], errors: string[] = [];
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  async function click(label: string, selector = 'dialog[open] button') {
    await page.waitForFunction((s, text) => Array.from(document.querySelectorAll(s)).some(el => el.textContent?.trim() === text && !(el as HTMLButtonElement).disabled), {}, selector, label);
    for (const element of await page.$$(selector)) if (await element.evaluate(el => el.textContent?.trim()) === label) { await element.click(); return; }
  }
  const state = (index: number) => api(`/api/sites/${slugs[index]}/main-sharing`);
  async function policy(index: number, audience: string, comments = true) { await api(`/api/sites/${slugs[index]}/main-sharing`, "PUT", { action: "custom", policy: { audience, comments } }); }
  async function open(view = "list", extra = "") {
    await page.goto(`${base}/me?lang=en&view=${view}${extra}`, { waitUntil: "networkidle2" });
    for (const slug of slugs.slice(0, 2)) { await page.waitForSelector(`[data-slug="${slug}"] input[type=checkbox]`); await page.click(`[data-slug="${slug}"] input[type=checkbox]`); }
    await click("Share", ".scope-bulk-bar button");
    await page.waitForSelector('dialog[open] .sharing-audiences');
  }
  async function choose(audience: string) { await page.click(`dialog[open] input[value="${audience}"]`); }
  const confirmation = 'dialog[open][role="alertdialog"]';
  const listing = `${confirmation} input[type=checkbox]`;
  async function review() { await click("Apply to 2 sites"); await page.waitForSelector(confirmation); }
  async function confirm() { await click("Allow access", `${confirmation} button`); }
  async function apply() {
    const anyone = await page.$eval('dialog[open] input[value=anyone]', el => (el as HTMLInputElement).checked);
    await click("Apply to 2 sites");
    if (anyone) { await page.waitForSelector(confirmation); await confirm(); }
    await page.waitForSelector('dialog[open]', { hidden: true });
  }
  async function capture(name: string) {
    await page.screenshot({ path: `test-results/bulk-sharing-${name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.$eval('dialog[open]', el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  }
  beforeAll(async () => {
    mkdirSync("test-results", { recursive: true });
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const user = await upsertUser({ authProvider: "bulk-e2e", providerSubject: createId("owner"), displayName: "Bulk sharing acceptance" });
    const tenant = createId("bulk-team");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Design team')", [tenant]);
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant, user.id]);
    await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, user.id]);
    const { cookie } = await mintSession(new Request(base!), user.id);
    const pair = cookie.split(";")[0], split = pair.indexOf("=");
    headers = { cookie: pair, origin: new URL(base!).origin, "content-type": "application/json" };
    for (const title of ["Selected design prototype", "Selected quarterly report", "Unselected site"]) {
      const site = await api("/api/sites", "POST", { mode: "paste", title, html: `<html><body><h1>${title}</h1></body></html>` });
      slugs.push(site.slug);
      await policy(slugs.length - 1, "private");
    }
    const context = await browser.createBrowserContext();
    await context.setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(base!).hostname, path: "/" });
    page = await context.newPage();
    page.on("pageerror", e => errors.push(String(e)));
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1440, height: 1000 });
  }, 120000);
  afterEach(async test => {
    if (test.task.result?.state === "fail") { await page.screenshot({ path: "test-results/bulk-sharing-failure.png" }); console.error(await page.evaluate(() => document.body.innerText)); }
    await page.setRequestInterception(false); page.removeAllListeners("request");
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it("keeps displayed update times and ordering after changing selected-site permissions", async () => {
    const now = Date.now();
    for (const [i, slug] of slugs.entries()) {
      await rbacQuery("UPDATE sites SET updated_at=$1 WHERE slug=$2", [now - (3 - i) * 86400000, slug]);
    }
    const rows = () => page.$$eval(".site-row", elements => elements.map(el => ({
      slug: el.getAttribute("data-slug"), updated: el.querySelector(".row-date")?.textContent,
    })));
    await open();
    const before = await rows();
    expect(before.map(row => row.slug)).toEqual([...slugs].reverse());
    expect(new Set(before.map(row => row.updated)).size).toBe(3);
    await page.screenshot({ path: "test-results/sharing-timestamps-before.png" });
    await choose("anyone");
    await apply();
    await page.waitForNetworkIdle();
    expect(await rows()).toEqual(before);
    await page.reload({ waitUntil: "networkidle2" });
    expect(await rows()).toEqual(before);
    expect((await state(0)).policy.audience).toBe("anyone");
    expect((await state(1)).policy.audience).toBe("anyone");
    expect((await state(2)).policy.audience).toBe("private");
    await page.screenshot({ path: "test-results/sharing-timestamps-after.png" });
    await policy(0, "private"); await policy(1, "private");
  });
  it("requires public-access confirmation, defaults to unlisted, and preserves choices on Back and Escape", async () => {
    await open("list", "&sharing=private");
    expect(await page.$eval('dialog[open] h2', el => el.textContent)).toBe("Share 2 sites");
    expect(await page.$eval('dialog[open] footer button[type=submit]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await choose("anyone");
    expect((await state(0)).policy.audience).toBe("private");
    await capture("desktop-list");
    await review();
    expect(await page.$eval(listing, el => ({ checked: (el as HTMLInputElement).checked, mixed: (el as HTMLInputElement).indeterminate }))).toEqual({ checked: false, mixed: false });
    expect((await state(0)).policy.audience).toBe("private");
    expect(await page.$eval(confirmation + ' h2', el => el.textContent)).toBe("Allow anyone to access these 2 sites?");
    await page.screenshot({ path: "test-results/bulk-sharing-confirmation-desktop.png" });
    expect(["Back", "Close"]).toContain(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent));
    await click("Back", `${confirmation} button`);
    expect(await page.$eval('dialog[open] input[value=anyone]', el => (el as HTMLInputElement).checked)).toBe(true);
    await review(); await page.keyboard.press("Escape"); await page.waitForSelector(confirmation, { hidden: true });
    expect((await state(0)).policy.audience).toBe("private");
    await apply();
    expect((await state(0)).policy.audience).toBe("anyone");
    expect((await state(1)).policy.audience).toBe("anyone");
    expect((await state(2)).policy.audience).toBe("private");
    expect(await page.$eval('.toast', el => el.textContent)).toBe("Updated sharing settings for 2 sites");
    await page.waitForSelector(`[data-slug="${slugs[0]}"]`, { hidden: true });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.folder-heading h2'));
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H2");
  });
  it("preserves untouched mixed Discover settings", async () => {
    await policy(0, "public"); await policy(1, "login");
    await open(); await choose("anyone"); await review();
    expect(await page.$eval(listing, el => (el as HTMLInputElement).indeterminate)).toBe(true);
    await confirm(); await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await state(0)).policy.audience).toBe("public");
    expect((await state(1)).policy.audience).toBe("anyone");
  });
  it("lists or unlists all selected sites after explicitly toggling the Discover checkbox", async () => {
    await policy(0, "public"); await policy(1, "login");
    await open(); await choose("anyone"); await review();
    expect(await page.$eval(listing, el => (el as HTMLInputElement).indeterminate)).toBe(true);
    expect(await page.$$eval(`${confirmation} .sharing-discovery p`, elements => elements.map(el => el.textContent))).toEqual(["1 of 2 sites already listed in Discover"]);
    await page.focus(listing); await page.keyboard.press("Space");
    expect(await page.$eval(listing, el => (el as HTMLInputElement).checked)).toBe(true);
    expect(await page.$$eval(`${confirmation} .sharing-discovery p`, elements => elements.map(el => el.textContent))).toEqual(["2 sites will be listed in Discover"]);
    expect((await state(1)).policy.audience).toBe("login");
    await page.keyboard.press("Space");
    expect(await page.$eval(listing, el => ({ checked: (el as HTMLInputElement).checked, mixed: (el as HTMLInputElement).indeterminate }))).toEqual({ checked: false, mixed: false });
    expect(await page.$$eval(`${confirmation} .sharing-discovery p`, elements => elements.map(el => el.textContent))).toEqual(["0 sites will be listed in Discover"]);
    await click("Back", `${confirmation} button`);
    expect(await page.$eval('dialog[open] .bulk-sharing-effects', el => el.textContent)).toContain("One site will also be removed from Discover.");
    await review();
    expect(await page.$eval(listing, el => ({ checked: (el as HTMLInputElement).checked, mixed: (el as HTMLInputElement).indeterminate }))).toEqual({ checked: false, mixed: false });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/bulk-sharing-confirmation-mobile.png" });
    expect(await page.$eval(confirmation, el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await confirm(); await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await state(0)).policy.audience).toBe("anyone");
    expect((await state(1)).policy.audience).toBe("anyone");
    await page.setViewport({ width: 1440, height: 1000 });
    await open(); await choose("anyone"); await review();
    await page.click(listing);
    await click("Allow access and list", `${confirmation} button`);
    await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await state(1)).policy.audience).toBe("public");
    expect((await state(2)).policy.audience).toBe("private");
    await open(); await choose("anyone"); await review();
    expect(await page.$eval(listing, el => ({ checked: (el as HTMLInputElement).checked, mixed: (el as HTMLInputElement).indeterminate, disabled: (el as HTMLInputElement).disabled }))).toEqual({ checked: true, mixed: false, disabled: false });
    expect(await page.$eval(confirmation, el => el.textContent)).toContain("All selected sites are already listed in Discover.");
    await page.click(listing);
    expect(await page.$eval(listing, el => (el as HTMLInputElement).checked)).toBe(false);
    expect(await page.$$eval(`${confirmation} .sharing-discovery p`, elements => elements.map(el => el.textContent))).toEqual(["0 sites will be listed in Discover"]);
    await page.keyboard.press("Escape"); await page.waitForSelector(confirmation, { hidden: true });
    await review();
    expect(await page.$eval(listing, el => (el as HTMLInputElement).checked)).toBe(false);
    await confirm(); await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await state(0)).policy.audience).toBe("anyone");
    expect((await state(1)).policy.audience).toBe("anyone");
    expect((await state(2)).policy.audience).toBe("private");
  });
  it("preserves mixed audience, passcode and public listing during a grid comment edit", async () => {
    await policy(0, "public"); await policy(1, "passcode");
    const passcode = (await state(1)).passcode;
    await open("grid");
    expect(await page.$eval('dialog[open] .sharing-audience-list', el => el.textContent)).toContain("Settings differ across selected sites");
    expect(await page.$('dialog[open] input[value="passcode"]')).toBeNull();
    await page.select('dialog[open] select', "false");
    await capture("desktop-grid");
    await apply();
    expect(await state(0)).toMatchObject({ policy: { audience: "public", comments: false } });
    expect(await state(1)).toMatchObject({ policy: { audience: "passcode", comments: false }, passcode });
  });
  it("shows private access effects on mobile and supports cancellation", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await open("grid"); await choose("private");
    expect(await page.$eval('dialog[open]', el => el.textContent)).toContain("Existing members and independent sharing links keep their access.");
    await capture("mobile-grid");
    await click("Cancel"); await page.waitForSelector('dialog[open]', { hidden: true });
    expect((await state(0)).policy.audience).toBe("public");
    await open(); await choose("private"); await capture("mobile-list"); await apply();
    expect((await state(0)).policy.audience).toBe("private");
    await page.setViewport({ width: 1440, height: 1000 });
  });
  it("keeps choices after a stale revision and requires a refresh before retrying", async () => {
    await open(); await choose("anyone");
    await review();
    await policy(1, "login");
    await confirm();
    await page.waitForSelector('dialog[open] [role=alert]');
    expect(await page.$eval('dialog[open] [role=alert]', el => el.textContent)).toContain("Sharing settings changed");
    expect((await state(0)).policy.audience).toBe("private");
    expect(await page.$eval('dialog[open] input[value=anyone]', el => (el as HTMLInputElement).checked)).toBe(true);
    await click("Refresh current settings"); await page.waitForFunction(() => !(document.querySelector('dialog[open] footer button[type=submit]') as HTMLButtonElement)?.disabled);
    await apply();
  });
  it("reconciles a committed request whose response is lost before retrying", async () => {
    await policy(0, "private"); await policy(1, "private"); await open(); await choose("anyone");
    let lost = false;
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (!lost && request.url().endsWith("/api/me/sharing/batch") && JSON.parse(request.postData() || "{}").confirmation) {
        lost = true;
        void fetch(request.url(), { method: "POST", headers: request.headers(), body: request.postData() }).then(() => request.abort("failed"));
      } else void request.continue();
    });
    await review(); await page.click(listing); await click("Allow access and list", `${confirmation} button`);
    await page.waitForSelector('dialog[open] [role=alert]');
    expect(await page.$eval('dialog[open] [role=alert]', el => el.textContent)).toContain("Could not confirm whether sharing was updated");
    expect((await state(0)).policy.audience).toBe("public");
    const revision = (await state(0)).revision;
    await page.setRequestInterception(false); page.removeAllListeners("request");
    await click("Refresh current settings"); await page.waitForFunction(() => !(document.querySelector('dialog[open] footer button[type=submit]') as HTMLButtonElement)?.disabled);
    await apply();
    expect((await state(0)).revision).toBe(revision);
    expect(await page.$eval('.toast', el => el.textContent)).toBe("2 unchanged");
  });
  it("explains lost sharing authority without dismissing the user's choices", async () => {
    await open(); await choose("login");
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.url().endsWith("/api/me/sharing/batch")) void request.respond({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Permission revoked" }) });
      else void request.continue();
    });
    await click("Apply to 2 sites"); await page.waitForSelector('dialog[open] [role=alert]');
    expect(await page.$eval('dialog[open] [role=alert]', el => el.textContent)).toContain("update your selection");
    expect(await page.$eval('dialog[open] input[value=login]', el => (el as HTMLInputElement).checked)).toBe(true);
    await capture("permission-error");
    await click("Close and update selection");
    await page.waitForSelector('dialog[open]', { hidden: true });
    await click("Share", ".scope-bulk-bar button");
    await page.waitForSelector('dialog[open] [role=alert]');
    expect(await page.$eval('dialog[open] [role=alert]', el => el.textContent)).toContain("update your selection");
    await click("Close and update selection");
    expect(errors).toEqual([]);
  });
});
