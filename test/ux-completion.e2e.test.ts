import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import sharp from "sharp";
import { closeDbForTests, createId, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

const base = process.env.RBAC_E2E_URL;
let browser: Browser;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("UX completion browser acceptance", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true, args:process.env.CI ? ["--no-sandbox"] : []});
    await mkdir("test-results", {recursive:true});
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it.skipIf(Boolean(process.env.AUTH_E2E_CONFIGURED))("does not offer login when the server has no identity provider", async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const response = await page.goto(`${base}/?lang=en`, {waitUntil:"networkidle2"});
    expect(response?.ok()).toBe(true);
    await page.waitForSelector(".auth-slot.is-empty");
    expect(await page.$(".nav-signin")).toBeNull();
    await context.close();
  });
  it.skipIf(!process.env.AUTH_E2E_CONFIGURED)("shows home sign-in during delayed detection and animates only the first identity reveal", async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    let release: (() => void) | undefined;
    let resolved = false;
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/auth/me") { void request.continue(); return; }
      const respond = () => { resolved = true; void request.respond({status:200, contentType:"application/json", body:JSON.stringify({oidcEnabled:true, user:{id:"arrival-test",displayName:"Arrival",email:"arrival@example.com"}})}); };
      if (resolved) respond(); else release = respond;
    });
    await page.goto(`${base}/?lang=en`, {waitUntil:"domcontentloaded"});
    // This also validates the SSR capability flag: no account response has arrived yet.
    const enabled = await page.$(".nav-signin");
    if (!enabled) {
      release?.();
      await context.close();
      throw new Error("Run this browser suite with OIDC configured to test the pending sign-in entry");
    }
    expect(await page.$eval(".nav-signin", el => el.textContent)).toContain("Sign in / Sign up");
    expect(await page.$eval(".nav-signin", el => el.getAttribute("href"))).toContain("/api/auth/login");
    await page.screenshot({path:"test-results/ux-home-pending-signin.png"});
    await page.waitForFunction(() => document.readyState === "complete");
    expect(release).toBeDefined();
    release!();
    await page.waitForSelector(".auth-chip.auth-arrival");
    expect(await page.$(".nav-signin")).toBeNull();
    await page.reload({waitUntil:"networkidle2"});
    await page.waitForSelector(".auth-chip");
    expect(await page.$(".auth-chip.auth-arrival")).toBeNull();
    await page.goto(`${base}/explore?lang=en`, {waitUntil:"networkidle2"});
    expect(await page.$(".auth-chip.auth-arrival")).toBeNull();
    await context.close();
    const guestContext = await browser.createBrowserContext();
    const guest = await guestContext.newPage();
    await guest.setRequestInterception(true);
    guest.on("request", request => {
      if (new URL(request.url()).pathname === "/api/auth/me") void request.abort();
      else void request.continue();
    });
    await guest.goto(`${base}/?lang=zh-CN`, {waitUntil:"networkidle2"});
    expect(await guest.$eval(".nav-signin", el => el.textContent)).toContain("登录 / 注册");
    expect(await guest.$(".nav-signin.auth-arrival")).toBeNull();
    await guest.setViewport({width:390,height:844});
    await guest.screenshot({path:"test-results/ux-home-mobile-signin.png"});
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guestContext.close();
  });
  it.skipIf(!process.env.AUTH_E2E_CONFIGURED)("holds a session hint until real validation accepts or rejects it", async () => {
    const user = await upsertUser({authProvider:"ux-test", providerSubject:createId("subject"), email:`${createId("user")}@example.com`, emailVerified:true});
    const {cookie} = await mintSession(new Request(base!), user.id);
    const [name, secret] = cookie.split(";")[0].split("=");
    for (const valid of [true, false]) {
      const context = await browser.createBrowserContext();
      const value = valid ? secret : "expired-session-hint";
      await context.setCookie({name, value, domain:new URL(base!).hostname, path:"/", httpOnly:true});
      const page = await context.newPage();
      let release!: () => void;
      let pending!: () => void;
      const intercepted = new Promise<void>(resolve => { pending = resolve; });
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/auth/me") {
          release = () => { void request.continue(); };
          pending();
        } else void request.continue();
      });
      const response = await page.goto(`${base}/?lang=en`, {waitUntil:"domcontentloaded"});
      await intercepted;
      expect(await page.$(".nav-signin")).toBeNull();
      expect(await page.$(".auth-slot.is-loading")).not.toBeNull();
      expect(await response!.text()).not.toContain(value);
      await page.screenshot({path:`test-results/ux-home-${valid ? "valid" : "expired"}-session-pending.png`});
      release();
      await page.waitForSelector(valid ? ".auth-chip" : ".nav-signin");
      expect(await page.$(".auth-slot.is-loading")).toBeNull();
      expect(await page.$(valid ? ".nav-signin" : ".auth-chip")).toBeNull();
      await context.close();
    }
  });
  it("dismisses guidance once per visit, preserves three acknowledgements, and contains the mobile sheet", async () => {
    const user = await upsertUser({authProvider:"ux-test", providerSubject:createId("subject"), email:`${createId("user")}@example.com`, emailVerified:true});
    const {cookie} = await mintSession(new Request(base!), user.id);
    const headers = {cookie:cookie.split(";")[0], origin:base!, "content-type":"application/json"};
    const created = await fetch(`${base}/api/sites`, {method:"POST", headers, body:JSON.stringify({mode:"paste", html:"<html><body style='margin:0;background:#fff;min-height:100vh'><h1>UX acceptance</h1></body></html>"})});
    expect(created.status).toBe(200);
    const site = await created.json();
    expect((await fetch(`${base}/api/sites/${site.slug}/sharing`, {method:"PUT", headers, body:JSON.stringify({visibility:"private"})})).status).toBe(200);
    const context = await browser.createBrowserContext();
    const [name, value] = headers.cookie.split("=");
    await context.setCookie({name, value, domain:new URL(base!).hostname, path:"/"});
    const page = await context.newPage();
    await page.setViewport({width:1280,height:800});
    for (let visit = 1; visit <= 3; visit++) {
      await page.goto(`${base}/s/${site.slug}?lang=en`, {waitUntil:"domcontentloaded"});
      await page.waitForSelector(".private-share-education");
      expect(await page.$eval(".private-share-education-head", el => el.textContent)).toContain(`${visit}/3`);
      expect(await page.$eval(".private-share-education", el => el.parentElement?.className)).not.toBe("fs-bar");
      await page.click(".private-share-education-actions button:last-child");
      await page.waitForSelector(".private-share-education", {hidden:true});
    }
    await Promise.all([
      page.waitForResponse(response => response.url().includes("/api/me/share-education")),
      page.reload({waitUntil:"domcontentloaded"}),
    ]);
    expect(await page.$(".private-share-education")).toBeNull();
    await page.setViewport({width:390,height:844});
    await page.click('[data-analytics-button="share"]');
    await page.waitForSelector(".share-quick");
    expect(await page.$eval(".share-quick-options button", el => el === document.activeElement)).toBe(true);
    expect(await page.$eval(".share-quick", el => el.matches(":modal"))).toBe(true);
    await page.$eval('[data-analytics-button="share"]', el => (el as HTMLElement).focus());
    expect(await page.$eval(".share-quick", el => el.contains(document.activeElement))).toBe(true);
    const box = await page.$eval(".share-quick", el => {const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};});
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(box.left).toBe(8);
    expect(box.right).toBe(382);
    expect(box.bottom).toBeLessThanOrEqual(844);
    expect(box.height).toBeLessThan(700);
    await page.screenshot({path:"test-results/ux-mobile-sharing.png"});
    await page.keyboard.press("Escape");
    await page.waitForSelector(".share-quick", {hidden:true});
    expect(await page.$eval('[data-analytics-button="share"]', el => el === document.activeElement)).toBe(true);
    await page.click('[data-analytics-button="share"]');
    await page.waitForSelector(".share-quick:modal");
    await page.mouse.click(2, 100);
    await page.waitForSelector(".share-quick", {hidden:true});
    expect(await page.$eval('[data-analytics-button="share"]', el => el === document.activeElement)).toBe(true);
    await page.setViewport({width:1280,height:800});
    await page.evaluate(() => {
      localStorage.setItem("sites:barMode", "auto");
      window.dispatchEvent(new StorageEvent("storage", {key:"sites:barMode"}));
    });
    await page.$eval('[data-analytics-button="share"]', el => (el as HTMLElement).focus());
    await page.$eval(".fs-handle", el => (el as HTMLElement).focus());
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(await page.$eval(".fs-handle", el => el.getAttribute("aria-expanded"))).toBe("true");
    await page.evaluate(() => {
      localStorage.setItem("sites:barMode", "manual");
      window.dispatchEvent(new StorageEvent("storage", {key:"sites:barMode"}));
    });
    await page.click('.fs-handle[aria-expanded="true"]');
    await page.waitForSelector('.fs-handle[aria-expanded="false"]');
    await page.waitForFunction(() => document.querySelector('.fs-handle')!.getBoundingClientRect().top === 0);
    await page.mouse.move(400, 600);
    await page.screenshot({path:"test-results/ux-collapsed-light.png"});
    for (const selector of [".fs-handle svg", ".comment-rail-toggle svg"]) {
      const icon = await page.$(selector);
      const pixels = await sharp(Buffer.from(await icon!.screenshot())).stats();
      expect(pixels.channels[0].min, `${selector} should have a dark glyph over white`).toBeLessThan(100);
    }
    const preview = await (await page.$("iframe.fs-frame"))!.contentFrame();
    await preview!.evaluate(() => { document.body.style.background = "#151515"; document.body.style.color = "#eee"; });
    await page.screenshot({path:"test-results/ux-collapsed-dark.png"});
    for (const selector of [".fs-handle svg", ".comment-rail-toggle svg"]) {
      const icon = await page.$(selector);
      const pixels = await sharp(Buffer.from(await icon!.screenshot())).stats();
      expect(pixels.channels[0].max, `${selector} should have a light glyph over dark`).toBeGreaterThan(170);
    }
    expect(await page.$eval('.comment-rail[data-collapsed="true"]', el => getComputedStyle(el).mixBlendMode)).toBe("difference");
    await preview!.evaluate(() => { document.body.style.background = "#808080"; });
    await page.screenshot({path:"test-results/ux-collapsed-midtone.png"});
    for (const selector of [".fs-handle svg", ".comment-rail-toggle svg"]) {
      const icon = await page.$(selector);
      const pixels = await sharp(Buffer.from(await icon!.screenshot())).stats();
      expect(pixels.channels[0].min, `${selector} needs an edge on a midtone background`).toBeLessThan(100);
    }
    await page.click(".fs-handle");
    await page.waitForSelector('.fs-handle[aria-expanded="true"]');
    await page.waitForFunction(() => document.querySelector("#fs-bar")!.getBoundingClientRect().top === 0);
    await page.click(".header-pin");
    expect(await page.$eval(".header-pin", el => el.getAttribute("aria-pressed"))).toBe("true");
    await page.click(".fs-handle");
    await page.waitForSelector('.fs-handle[aria-expanded="false"]');
    await page.click(".comment-rail-toggle");
    await page.waitForSelector('.comment-rail[data-collapsed="false"]');
    // Server history, rather than the current browser's acknowledgement count, suppresses teaching.
    let shareUrl = "";
    for (let n = 0; n < 3; n++) {
      const response = await fetch(`${base}/api/sites/${site.slug}/shares`, {method:"POST", headers, body:JSON.stringify({policy:"public"})});
      expect(response.status).toBe(201);
      shareUrl = (await response.json()).url;
    }
    await page.evaluate(() => localStorage.clear());
    const history = page.waitForResponse(response => response.url().includes("/api/me/share-education"));
    await page.reload({waitUntil:"networkidle2"});
    expect((await (await history).json()).linksCreated).toBe(3);
    expect(await page.$(".private-share-education")).toBeNull();
    await page.goto(shareUrl, {waitUntil:"networkidle2"});
    await page.waitForFunction(() => {
      const logo = document.querySelector<HTMLImageElement>(".viewer-brand-logo img");
      return logo?.complete && logo.naturalWidth > 0;
    });
    expect(await page.$eval(".viewer-brand-logo", el => el.getBoundingClientRect().width)).toBe(123);
    await page.screenshot({path:"test-results/ux-shared-brand-desktop.png"});
    await page.click(".fs-handle");
    await page.waitForFunction(() => document.querySelector('.fs-handle')!.getBoundingClientRect().top === 0);
    await page.click(".fs-handle");
    await page.waitForFunction(() => document.querySelector('header.fs-bar')!.getBoundingClientRect().top === 0);
    await page.setViewport({width:390,height:844});
    expect(await page.$eval(".viewer-brand-logo", el => el.getBoundingClientRect().width)).toBe(28);
    expect(await page.$eval(".header-mid > .header-title", el => getComputedStyle(el).display)).toBe("none");
    expect(await page.$(".controls a[target='_blank'] svg")).not.toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:"test-results/ux-shared-brand-mobile.png"});
    await context.close();
  });
  it("renders compact notification states and removes a marked item from Unread", async () => {
    const page = await browser.newPage();
    await page.setViewport({width:1280,height:800});
    let read = false;
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/notifications") {
        if (request.method() === "POST") read = true;
        const items = read ? [] : [{id:"ux-notification",createdAt:Date.now()-60_000,readAt:null,available:true,author:"Alex",mentioned:true,agent:false,excerpt:"Can you take a look at the updated sharing flow?",siteTitle:"Sharing experience",versionNumber:2,shared:false,shareLabel:null,threadId:"thread",messageId:"message"}];
        void request.respond({status:200,contentType:"application/json",body:JSON.stringify(request.method() === "POST" ? {ok:true} : {items,nextCursor:null})});
      } else void request.continue();
    });
    await page.goto(`${base}/notifications?lang=en`, {waitUntil:"networkidle0"});
    await page.waitForSelector(".notification-row");
    await page.screenshot({path:"test-results/ux-notifications-desktop.png"});
    await page.click('.notification-filters [role="group"] button:last-child');
    await page.waitForSelector(".notification-row");
    await page.click(".notification-read");
    await page.waitForSelector(".notification-empty");
    expect(await page.$(".notification-row")).toBeNull();
    await page.setViewport({width:390,height:844});
    await page.screenshot({path:"test-results/ux-notifications-mobile.png"});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  });
});
