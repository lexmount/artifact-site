import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import { closeDbForTests, createId, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { SHARE_EDUCATION_KEY, SHARE_EDUCATION_DISMISSED_KEY, SHARE_EDUCATION_INTERVAL, SHARE_EDUCATION_DATABASE } from "@/lib/share-education";

// Use an isolated running Postgres-backed app and the same ARTIFACT_DATABASE_URL.
const base = process.env.SHARE_EDUCATION_E2E_URL;
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Design review</title><style>body{margin:0;padding:80px 8%;font:18px/1.7 system-ui;color:#202923;background:#fafbf9}h1{font-size:48px;letter-spacing:-2px;margin:16px 0}small{color:#596c60}section{display:grid;grid-template-columns:1fr 1fr;gap:64px;margin-top:60px;border-top:1px solid #cdd5cf}h2{font-size:22px}button{padding:12px 20px;border:1px solid #adbdb0;background:#e8efe9;border-radius:6px}@media(max-width:600px){body{padding:52px 24px}h1{font-size:32px}section{grid-template-columns:1fr;gap:12px}}</style><small>ARTIFACT / DESIGN REVIEW</small><h1>产品设计方案</h1><p>让信息更清晰，让协作更简单。</p><button id="artifact-action" onclick="this.textContent='交互正常'">体验作品交互</button><section><div><h2>项目背景</h2><p>把完成的作品呈现给团队，让反馈与分享自然发生。</p></div><div><h2>目标与价值</h2><p>保留作品的完整体验，按需使用编辑和分享工具。</p></div></section></html>`;
let browser: Browser;
let cookie: {name: string; value: string};
let headers: Record<string, string>;
let slug: string;
let version: string;
async function contextPage(): Promise<{context: BrowserContext; page: Page}> {
  const context = await browser.createBrowserContext();
  await context.setCookie({...cookie, domain:new URL(base!).hostname, path:"/", httpOnly:true});
  const page = await context.newPage();
  await page.setViewport({width:1280,height:800});
  await page.bringToFront();
  return {context, page};
}
async function visit(page: Page, target = slug, lang = "en") {
  await page.goto(`${base}/s/${target}?lang=${lang}`, {waitUntil:"networkidle2"});
}
async function resetEducation(page: Page) {
  await page.evaluate(async ({keys, database}) => {
    keys.forEach(key => localStorage.removeItem(key)); sessionStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(database);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
  }, {keys:[SHARE_EDUCATION_KEY, SHARE_EDUCATION_DISMISSED_KEY], database:SHARE_EDUCATION_DATABASE});
  await page.reload({waitUntil:"networkidle2"});
}
async function setLastShownAt(page: Page, lastShownAt: number | null) {
  await page.evaluate(async ({key,database,lastShownAt}) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key,JSON.stringify({...state,lastShownAt}));
    await new Promise<void>((resolve,reject) => {
      const opening = indexedDB.open(database,1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db=opening.result, tx=db.transaction("progress","readwrite"), store=tx.objectStore("progress");
        const reading=store.get(key);
        reading.onsuccess=()=>store.put({...reading.result,lastShownAt},key);
        tx.oncomplete=()=>{db.close();resolve();}; tx.onabort=()=>{db.close();reject(tx.error);};
      };
    });
  }, {key:SHARE_EDUCATION_KEY,database:SHARE_EDUCATION_DATABASE,lastShownAt});
}
async function copied(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || "{}").copies || 0, SHARE_EDUCATION_KEY);
}

async function holdEducationLock(page: Page) {
  await page.evaluate(key => {
    delete document.documentElement.dataset.educationLockHeld;
    const gate = new Promise<void>(resolve => { Object.assign(window, { releaseEducationLock: resolve }); });
    void navigator.locks.request(key, async () => {
      document.documentElement.dataset.educationLockHeld = "true";
      await gate;
    });
  }, SHARE_EDUCATION_KEY);
  await page.waitForFunction(() => document.documentElement.dataset.educationLockHeld === "true", {polling:50});
}
async function releaseEducationLock(page: Page) {
  await page.evaluate(() => (window as unknown as {releaseEducationLock: () => void}).releaseEducationLock());
}

describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("private share education and immersive preview", () => {
  beforeAll(async () => {
    const {default:puppeteer} = await import("puppeteer-core");
    browser = await puppeteer.launch({executablePath:process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true, args:process.env.CI ? ["--no-sandbox"] : []});
    await mkdir("test-results", {recursive:true});
    await writeFile("test-results/share-preview.html", fixture);
    const user = await upsertUser({authProvider:"share-education-e2e",providerSubject:createId("subject"),email:`${createId("user")}@example.com`,emailVerified:true});
    const session = await mintSession(new Request(base!), user.id);
    const [name, value] = session.cookie.split(";")[0].split("="); cookie = {name,value};
    headers = {cookie:`${name}=${value}`,origin:base!,"content-type":"application/json"};
    const response = await fetch(`${base}/api/sites`, {method:"POST",headers,body:JSON.stringify({mode:"paste",title:"产品设计方案",html:fixture})});
    expect(response.status).toBe(200);
    const site = await response.json(); slug = site.slug;
    expect((await fetch(`${base}/api/sites/${slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility:"private"})})).status).toBe(200);
    const versions = await (await fetch(`${base}/api/sites/${slug}/versions`, {headers})).json(); version = versions.versions[0].id;
  }, 60_000);
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });

  it("holds the bubble and toolbar through timeout, iframe interaction and manual collapse, then dismisses once", async () => {
    const {context,page} = await contextPage();
    await visit(page);
    await page.waitForSelector(".private-share-education");
    await new Promise(resolve => setTimeout(resolve, 2900));
    const frame = await (await page.$("iframe.fs-frame"))!.contentFrame();
    await frame!.click("#artifact-action");
    await page.click(".fs-handle");
    await page.mouse.move(600,700);
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(await page.$eval(".fs-handle", el => el.getAttribute("aria-expanded"))).toBe("true");
    expect(await page.$eval(".private-share-education", el => el.textContent)).toContain(`/s/${slug}`);
    await page.click(".private-share-education-actions button:nth-child(2)");
    await page.waitForSelector(".private-share-education", {hidden:true});
    expect(await copied(page)).toBe(0);
    await page.reload({waitUntil:"networkidle2"});
    expect(await page.$(".private-share-education")).toBeNull();
    await context.close();
  });

  it("contains Chinese guidance at desktop and mobile sizes, with no reminder counter", async () => {
    for (const width of [1280,390,320]) {
      // Changing mobile emulation reloads the page. Configure it before visiting so an
      // outgoing page cannot claim a freshly cleared cooldown during that reload.
      const {context,page} = await contextPage();
      try {
        await page.setViewport({width,height:844,isMobile:width < 600,hasTouch:width < 600});
        await visit(page, slug, "zh-CN");
        await page.waitForSelector(".private-share-education");
        expect(await page.$eval(".private-share-education", el => el.textContent)).toContain("私有站点，请使用分享链接");
        expect(await page.$eval(".private-share-education", el => el.textContent)).not.toMatch(/\b\d\s*\/\s*3\b/);
        const rect = await page.$eval(".private-share-education", el => {const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};});
        expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width); expect(rect.bottom).toBeLessThanOrEqual(844);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({path:width === 1280 ? "test-results/share-education-desktop.png" : `test-results/share-education-mobile-${width}.png`});
      } finally { await context.close(); }
    }
  });

  it("opens existing quick sharing and counts three real copies including reuse, but not failures", async () => {
    const {context,page} = await contextPage();
    await visit(page);
    await page.click(".private-share-education-actions button:first-child");
    await page.waitForSelector(".share-quick:modal");
    await context.overridePermissions(base!, ["clipboard-read", "clipboard-sanitized-write"]);
    for (let n=1;n<=3;n++) {
      await page.click(".share-quick-options button");
      await page.waitForFunction((key, count) => JSON.parse(localStorage.getItem(key) || "{}").copies === count, {}, SHARE_EDUCATION_KEY, n);
    }
    const list = await (await fetch(`${base}/api/sites/${slug}/shares`, {headers})).json();
    expect(list.shares).toHaveLength(1);
    await page.keyboard.press("Escape");
    await page.evaluate(key => { const state=JSON.parse(localStorage.getItem(key)!); state.lastShownAt=null; localStorage.setItem(key,JSON.stringify(state));sessionStorage.clear(); }, SHARE_EDUCATION_KEY);
    await page.reload({waitUntil:"networkidle2"});
    expect(await page.$(".private-share-education")).toBeNull();
    await resetEducation(page);
    await page.click(".private-share-education-actions button:first-child");
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); }; });
    await page.click(".share-quick-options button");
    await page.waitForSelector(".share-quick-manual");
    expect(await copied(page)).toBe(0);
    await context.close();
  });

  it("counts copies from existing link settings, excluding passcodes and the site address", async () => {
    expect((await fetch(`${base}/api/sites/${slug}/shares`, {method:"POST",headers,body:JSON.stringify({policy:"public"})})).status).toBe(201);
    const {context,page} = await contextPage();
    await visit(page);
    await context.overridePermissions(base!, ["clipboard-read", "clipboard-sanitized-write"]);
    await page.click(".private-share-education-actions button:first-child");
    await page.waitForSelector(".share-quick-private");
    await page.locator(".share-quick-foot .btn.primary").click();
    await page.locator(".share-drawer .copy-field button").click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || "{}").copies === 1, {}, SHARE_EDUCATION_KEY);
    await page.click('.drawer-tabs button:nth-child(2)');
    await page.click(".share-foot button");
    expect(await copied(page)).toBe(1);
    await page.click('.drawer-tabs button:first-child');
    await page.locator(".share-new-trigger").click();
    await page.waitForSelector("#share-new-policy");
    await page.select("#share-new-policy", "passcode");
    await page.click(".share-new-actions button:first-child");
    await page.waitForSelector('.share-link.is-new button[aria-label="Copy passcode"]');
    expect(await copied(page)).toBe(1);
    await page.locator('.share-link.is-new button[aria-label="Copy passcode"]').click();
    expect(await copied(page)).toBe(1);
    await context.close();
  });

  it("opens creation only by explicit intent and refreshes quick-sharing visibility copy", async () => {
    const {context,page} = await contextPage();
    const response = await fetch(`${base}/api/sites`, {method:"POST",headers,body:JSON.stringify({mode:"paste",html:fixture})});
    expect(response.status).toBe(200);
    const site = await response.json();
    const setVisibility = async (visibility: string) => {
      expect((await fetch(`${base}/api/sites/${site.slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility})})).status).toBe(200);
    };
    await setVisibility("private");
    await visit(page, site.slug, "zh-CN");
    await page.locator(".private-share-education-actions button:first-child").click();
    await page.waitForSelector(".share-quick:modal");
    expect(await page.$eval(".share-quick-foot b", el => el.textContent)).toBe("需要更详细的分享设置？");
    await page.waitForFunction(() => document.querySelector(".share-quick-foot span")?.textContent?.includes("当前为私有"));
    expect(await page.$eval(".share-quick-foot span", el => el.textContent)).toBe("可以新建分享链接、调整站点地址可见性（当前为私有）或添加站点协作权限。");
    for (const width of [1280, 390]) {
      await page.setViewport({width,height:844});
      await page.waitForFunction(() => {
        const dialog = document.querySelector<HTMLDialogElement>(".share-quick");
        if (!dialog) return false;
        const rect = dialog.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
      });
      await page.screenshot({path:`test-results/share-settings-entry-${width}.png`});
    }
    await page.setViewport({width:1280,height:800});
    await page.locator(".share-quick-foot > button:last-child").click();
    await page.locator('.drawer-tabs button:first-child').click();
    await page.waitForSelector(".share-new-trigger");
    expect(await page.$("#share-new-policy")).toBeNull();
    await page.locator(".share-new-trigger").click();
    await page.waitForSelector("#share-new-policy");
    await page.locator('.drawer-tabs button:nth-child(2)').click();
    await page.locator('.drawer-tabs button:first-child').click();
    await page.waitForSelector(".share-new-trigger");
    await page.keyboard.press("Escape");
    await page.locator('[data-analytics-button="share"]').click();
    await page.locator(".share-quick-foot .btn.primary").click();
    await page.waitForSelector("#share-new-policy");
    await page.locator('.drawer-tabs button:nth-child(2)').click();
    await page.locator('.drawer-tabs button:first-child').click();
    await page.waitForSelector(".share-new-trigger");
    await page.keyboard.press("Escape");
    // Reopening must fetch current visibility even if another page changed it.
    for (const visibility of ["public", "unlisted", "private"]) {
      await setVisibility(visibility);
      await page.locator('[data-analytics-button="share"]').click();
      await page.waitForFunction(label => document.querySelector(".share-quick-foot span")?.textContent?.includes(`当前为${label}`), {}, visibility === "private" ? "私有" : "公开");
      await page.keyboard.press("Escape");
    }
    await context.close();
  });

  it("does not present cached visibility as current while refreshing or after failure, and retries", async () => {
    const {context,page} = await contextPage();
    await visit(page, slug, "zh-CN");
    expect((await fetch(`${base}/api/sites/${slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility:"public"})})).status).toBe(200);
    let mode: "hold" | "network" | "success" = "hold";
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.method() !== "GET" || new URL(request.url()).pathname !== `/api/sites/${slug}/sharing`) { void request.continue(); return; }
      if (mode === "hold") void held.then(() => request.respond({status:500,contentType:"application/json",body:'{"error":"Unavailable"}'}));
      else if (mode === "network") void request.abort("failed");
      else void request.continue();
    });
    try {
      await page.locator(".private-share-education-actions button:first-child").click();
      await page.waitForFunction(() => document.querySelector(".share-quick-foot")?.textContent?.includes("正在读取"));
      expect(await page.$eval(".share-quick-foot", el => el.textContent)).not.toContain("当前为私有");
      expect(await page.$(".share-quick-private")).toBeNull();
      release();
      await page.waitForSelector(".share-quick-visibility-error");
      expect(await page.$eval(".share-quick-foot", el => el.textContent)).toContain("无法确认");
      expect(await page.$eval(".share-quick", el => el.textContent)).not.toContain("当前为私有");
      mode = "network";
      await page.locator(".share-quick-visibility-error button").click();
      await page.waitForSelector(".share-quick-visibility-error");
      expect(await page.$eval(".share-quick-foot", el => el.textContent)).toContain("无法确认");
      mode = "success";
      await page.locator(".share-quick-visibility-error button").click();
      await page.waitForFunction(() => document.querySelector(".share-quick-foot")?.textContent?.includes("当前为公开"));
      expect(await page.$(".share-quick-visibility-error, .share-quick-private")).toBeNull();
    } finally {
      release();
      await context.close();
      await fetch(`${base}/api/sites/${slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility:"private"})});
    }
  });

  it("keeps the quick dialog within a short viewport when private guidance arrives", async () => {
    const {context,page} = await contextPage();
    await page.setViewport({width:1280,height:420});
    await visit(page);
    await page.locator(".private-share-education-actions button:nth-child(2)").click();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.method() === "GET" && new URL(request.url()).pathname === `/api/sites/${slug}/sharing`) void held.then(() => request.continue());
      else void request.continue();
    });
    try {
      await page.locator('[data-analytics-button="share"]').click();
      await page.waitForFunction(() => document.querySelector(".share-quick-foot")?.textContent?.includes("Checking"));
      const focused = await page.evaluate(() => document.activeElement?.outerHTML);
      await page.evaluate(() => {
        document.querySelector(".share-quick")!.addEventListener("close", () => { document.documentElement.dataset.quickClosed = "true"; });
      });
      release();
      await page.waitForSelector(".share-quick-private");
      // No resize/scroll is dispatched: the content change itself must trigger positioning.
      await page.waitForFunction(() => {
        const dialog = document.querySelector<HTMLDialogElement>(".share-quick");
        const rect = dialog?.getBoundingClientRect();
        return dialog?.matches(":modal") && rect && rect.top >= 12 && rect.bottom <= innerHeight - 12;
      }, {timeout:3000});
      expect(await page.evaluate(() => document.documentElement.dataset.quickClosed)).toBeUndefined();
      expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(focused);
      await page.screenshot({path:"test-results/share-quick-short-viewport.png"});
      await page.keyboard.press("Escape");
      await page.waitForSelector(".share-quick", {hidden:true});
      expect(await page.$eval('[data-analytics-button="share"]', el => el === document.activeElement)).toBe(true);
    } finally {
      release();
      await context.close();
    }
  });

  it("shares opt-out across tabs and never lets a storage event reopen a lesson", async () => {
    const {context,page} = await contextPage();
    await visit(page);
    const sibling=await context.newPage(); await visit(sibling);
    expect(await sibling.$(".private-share-education")).toBeNull();
    await sibling.evaluate(key => { localStorage.setItem(key, JSON.stringify({copies:0,dismissed:true,lastShownAt:null})); }, SHARE_EDUCATION_KEY);
    await page.waitForSelector(".private-share-education", {hidden:true});
    await page.bringToFront();
    await resetEducation(page);
    await page.click(".private-share-education-opt-out");
    await page.reload({waitUntil:"networkidle2"});
    expect(await page.$(".private-share-education")).toBeNull();
    expect(await page.evaluate(key => localStorage.getItem(key), SHARE_EDUCATION_DISMISSED_KEY)).toBe("1");
    await context.close();
  });

  it("serializes real competing tabs and preserves opt-out while another tab has a queued copy", async () => {
    const {context, page:gate} = await contextPage();
    await gate.goto(base!, {waitUntil:"networkidle2"});
    await holdEducationLock(gate);
    const first = await context.newPage(), second = await context.newPage();
    await Promise.all([first.setViewport({width:1280,height:800}), second.setViewport({width:1280,height:800})]);
    await Promise.all([visit(first), visit(second)]);
    await gate.waitForFunction(async key => (await navigator.locks.query()).pending?.filter(lock => lock.name === key).length === 2, {polling:50}, SHARE_EDUCATION_KEY);
    expect(await first.$(".private-share-education")).toBeNull();
    expect(await second.$(".private-share-education")).toBeNull();
    await releaseEducationLock(gate);
    await Promise.any([first.waitForSelector(".private-share-education"), second.waitForSelector(".private-share-education")]);
    await gate.waitForFunction(async key => !(await navigator.locks.query()).pending?.some(lock => lock.name === key), {polling:50}, SHARE_EDUCATION_KEY);
    const firstShowing = !!await first.$(".private-share-education");
    const winner = firstShowing ? first : second, copier = firstShowing ? second : first;
    expect(await copier.$(".private-share-education")).toBeNull();

    await context.overridePermissions(base!, ["clipboard-read", "clipboard-sanitized-write"]);
    await copier.bringToFront();
    if (await copier.$eval(".fs-handle", el => el.getAttribute("aria-expanded")) === "false") await copier.click(".fs-handle");
    await copier.locator('[data-analytics-button="share"]').click();
    await copier.waitForSelector(".share-quick:modal");
    await holdEducationLock(gate);
    await copier.bringToFront();
    await copier.locator(".share-quick-options button").click();
    await gate.waitForFunction(async key => (await navigator.locks.query()).pending?.some(lock => lock.name === key), {polling:50}, SHARE_EDUCATION_KEY).catch(async error => {
      throw new Error(`${String(error)}; copy UI: ${await copier.$eval(".share-quick", el => el.textContent)}; locks: ${JSON.stringify(await gate.evaluate(() => navigator.locks.query()))}`);
    });
    await copier.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(".share-quick-options button");
      return button && !button.disabled && button.textContent?.includes("Copied");
    }, {polling:50});
    // A second click must write again while the education lock is still held.
    await copier.locator(".share-quick-options button").click();
    await gate.waitForFunction(async key => (await navigator.locks.query()).pending?.filter(lock => lock.name === key).length === 2, {polling:50}, SHARE_EDUCATION_KEY);
    await copier.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(".share-quick-options button");
      return button && !button.disabled && button.textContent?.includes("Copied");
    }, {polling:50});
    expect(await copied(copier)).toBe(0);
    await winner.bringToFront();
    await winner.click(".private-share-education-opt-out");
    await releaseEducationLock(gate);
    await copier.waitForFunction(key => JSON.parse(localStorage.getItem(key) || "{}").copies === 2, {polling:50}, SHARE_EDUCATION_KEY);
    expect(await copier.evaluate(key => localStorage.getItem(key), SHARE_EDUCATION_DISMISSED_KEY)).toBe("1");
    // Remove only the cooldown/session guards: opt-out must independently prevent a new claim.
    await setLastShownAt(copier,null);
    const fresh = await context.newPage(); await visit(fresh);
    expect(await fresh.$(".private-share-education")).toBeNull();
    await context.close();
  });

  it("limits reminders across sites for 24 hours and does not consume guidance on public sites", async () => {
    const {context,page} = await contextPage();
    await visit(page);
    const result=await fetch(`${base}/api/sites`, {method:"POST",headers,body:JSON.stringify({mode:"paste",html:fixture})});
    expect(result.status).toBe(200);
    const second=await result.json();
    expect((await fetch(`${base}/api/sites/${second.slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility:"private"})})).status).toBe(200);
    await visit(page,second.slug); expect(await page.$(".private-share-education")).toBeNull();
    await setLastShownAt(page,Date.now()-SHARE_EDUCATION_INTERVAL);
    await page.reload({waitUntil:"networkidle2"}); await page.waitForSelector(".private-share-education");
    await fetch(`${base}/api/sites/${second.slug}/sharing`, {method:"PUT",headers,body:JSON.stringify({visibility:"public"})});
    await resetEducation(page);
    expect(await page.$(".private-share-education")).toBeNull();
    expect(await page.evaluate(key => localStorage.getItem(key), SHARE_EDUCATION_KEY)).toBeNull();
    await context.close();
  });

  it("opens the viewed snapshot in a separate chrome-free, sandboxed tab; strangers remain denied", async () => {
    const {context,page} = await contextPage();
    const updated = await fetch(`${base}/api/sites/${slug}/versions`, {method:"POST",headers,body:JSON.stringify({mode:"paste",html:fixture.replace("产品设计方案", "新版本")})});
    expect(updated.status).toBe(200);
    expect((await updated.json()).versionId).not.toBe(version);
    await page.goto(`${base}/s/${slug}?version=${version}&lang=en`, {waitUntil:"networkidle2"});
    await page.hover(".header-immersive");
    await page.waitForSelector('[role="tooltip"]');
    expect(await page.$eval('[role="tooltip"]', el => el.textContent)).toContain("new tab");
    expect(await page.$eval(".header-immersive", el => el.nextElementSibling?.classList.contains("header-pin"))).toBe(true);
    const target=browser.waitForTarget(target=>target.opener() === page.target());
    await page.click(".header-immersive");
    const preview=await (await target).page(); expect(preview).not.toBeNull();
    await preview!.waitForSelector("#artifact-action");
    expect(new URL(preview!.url()).pathname.replace(/\/$/, "")).toBe(`/api/preview/${slug}`);
    expect(new URL(preview!.url()).searchParams.get("v")).toBe(version);
    expect(await preview!.$(".fs-bar, .fs-handle, .private-share-education, .comment-rail")).toBeNull();
    expect(await preview!.evaluate(()=>window.opener === null)).toBe(true);
    const response=await preview!.reload({waitUntil:"networkidle2"});
    expect(response!.headers()["content-security-policy"]).toContain("sandbox");
    expect(response!.headers()["content-security-policy"]).not.toContain("allow-same-origin");
    await preview!.click("#artifact-action");
    expect(await preview!.$eval("#artifact-action",el=>el.textContent)).toBe("交互正常");
    await preview!.screenshot({path:"test-results/immersive-preview.png"});
    expect((await fetch(preview!.url())).status).toBe(404);
    await preview!.close();
    expect(page.url()).toContain(`/s/${slug}`);
    expect(await page.$(".private-share-education")).not.toBeNull();
    await context.close();
  });
});
