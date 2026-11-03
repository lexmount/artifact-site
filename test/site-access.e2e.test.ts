// Run against a disposable, OIDC-enabled server and its PostgreSQL database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import type { Browser } from "puppeteer-core";
import { closeDbForTests, createId, getSiteBySlug, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { putUserSiteRole } from "@/lib/role-bindings";
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
      const headers = { cookie: ownerCookie, origin: base!, "content-type": "application/json" };
      const created = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ mode: "paste", html: "<title>Private artifact title</title><h1>Secret content</h1>" }) });
      expect(created.status).toBe(200);
      const { slug, versionId } = await created.json();
      const setAudience = (audience: string) => fetch(`${base}/api/sites/${slug}/main-sharing`, { method: "PUT", headers, body: JSON.stringify({ action: "custom", policy: { audience, comments: true } }) });
      expect((await setAudience("private")).status).toBe(200);
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
      expect((await setAudience("anyone")).status).toBe(200);
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("main button.btn.solid")]);
      await page.waitForSelector("iframe.fs-frame");
      expect(page.url()).toBe(`${base}${target}`);
    } finally { await context.close(); }
  }, 60_000);

  it.each(["en", "zh-CN"])("recovers a passcode link through member login and account switching (%s)", async locale => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const domain = new URL(base!).hostname;
    const setSession = async (userId: string) => {
      const { cookie } = await mintSession(new Request(base!), userId);
      const [name, value] = cookie.split(";")[0].split("=");
      await context.setCookie({ name, value, domain, path: "/" });
    };
    await page.setViewport({ width: locale === "en" ? 1440 : 320, height: 900 });
    await context.setCookie(
      { name: "ah_locale", value: locale, domain, path: "/" },
      { name: "artifact_sso_opt_out", value: "1", domain, path: "/" },
    );
    try {
      const owner = await upsertUser({ authProvider: "access-e2e", providerSubject: createId("code-owner") });
      const member = await upsertUser({ authProvider: "access-e2e", providerSubject: createId("code-member") });
      const wrong = await upsertUser({ authProvider: "access-e2e", providerSubject: createId("wrong"), email: "wrong-account@example.test", emailVerified: true });
      const headers = { cookie: (await mintSession(new Request(base!), owner.id)).cookie.split(";")[0], origin: base!, "content-type": "application/json" };
      const created = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ mode: "paste", html: "<title>Protected title</title><p id='historical'>Selected historical version</p>" }) });
      expect(created.status).toBe(200);
      const { slug, versionId } = await created.json();
      const site = (await getSiteBySlug(slug))!;
      await putUserSiteRole(rbacQuery, site.id, member.id, "editor", owner.id);
      expect((await fetch(`${base}/api/sites/${slug}/edit`, { method: "POST", headers, body: JSON.stringify({ content: "<p>New current version</p>" }) })).status).toBe(200);
      expect((await fetch(`${base}/api/sites/${slug}/main-sharing`, { method: "PUT", headers, body: JSON.stringify({ action: "custom", policy: { audience: "passcode", comments: true } }) })).status).toBe(200);
      const target = `/s/${slug}?version=${versionId}&collection=folder#page-2`;
      // Capture the IdP handoff; the callback is represented by a real server session.
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/auth/login") void request.respond({ status: 200, contentType: "text/html", body: "Sign-in destination captured" });
        else void request.continue();
      });
      for (const signedIn of [false, true]) {
        if (signedIn) await setSession(wrong.id);
        // A same-URL navigation with a fragment can reuse the previous account's document.
        await page.goto("about:blank");
        await page.goto(`${base}${target}`, { waitUntil: "networkidle0" });
        expect(await page.$("#main-passcode")).not.toBeNull();
        expect(await page.$("iframe.fs-frame")).toBeNull();
        expect(await page.title()).not.toContain("Protected title");
        expect(await page.$eval(".main-passcode-actions a", el => el.getAttribute("href"))).toBe("/");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (signedIn) expect(await page.$eval(".main-passcode-recovery", el => el.textContent)).toContain("wrong-account@example.test");
        await page.screenshot({ path: `test-results/passcode-recovery-${locale}-${signedIn ? "switch" : "login"}.png`, fullPage: true });
        const selector = `.main-passcode-actions button${signedIn ? ":not(.solid)" : ".solid"}`;
        expect(await page.$eval(selector, el => el.closest("form"))).toBeNull();
        await Promise.all([page.waitForNavigation(), page.click(selector)]);
        const login = new URL(page.url());
        expect(login.pathname).toBe("/api/auth/login");
        expect(login.searchParams.get("return_to")).toBe(target);
        expect(login.searchParams.get("switch_account")).toBe(signedIn ? "1" : null);
        // No passcode is supplied. The member's direct grant restores the selected version.
        await setSession(member.id);
        await page.goto(`${base}${login.searchParams.get("return_to")}`, { waitUntil: "networkidle0" });
        const iframe = await page.waitForSelector("iframe.fs-frame");
        const frame = await iframe!.contentFrame();
        await frame!.waitForSelector("#historical");
        expect(await frame!.$eval("#historical", el => el.textContent)).toBe("Selected historical version");
        expect(page.url()).toBe(`${base}${target}`);
        expect(await page.$("#main-passcode")).toBeNull();
      }
    } finally { await context.close(); }
  }, 60_000);
});
