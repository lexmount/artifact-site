import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, Page, HTTPRequest } from "puppeteer-core";
import { closeDbForTests, createId, getSiteBySlug, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

// The existing gate is retained for CI; this suite replaces retired quick-share education.

async function chooseAudience(page: Page, value: string) {
  const selector = `.sharing-audiences input[type=radio][value="${value}"]:not(:disabled)`;
  await page.waitForSelector(selector);
  await page.locator(selector).click();
}
const base = process.env.SHARE_EDUCATION_E2E_URL;
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Design review</title><style>body{margin:0;padding:80px 8%;font:18px/1.7 system-ui;color:#202923;background:#fafbf9}h1{font-size:48px;letter-spacing:-2px;margin:16px 0}small{color:#596c60}section{display:grid;grid-template-columns:1fr 1fr;gap:64px;margin-top:60px;border-top:1px solid #cdd5cf}h2{font-size:22px}button{padding:12px 20px;border:1px solid #adbdb0;background:#e8efe9;border-radius:6px}@media(max-width:600px){body{padding:52px 24px}h1{font-size:32px}section{grid-template-columns:1fr;gap:12px}}</style><small>ARTIFACT / DESIGN REVIEW</small><h1>产品设计方案</h1><p>让信息更清晰，让协作更简单。</p><button id="artifact-action" onclick="this.textContent='交互正常'">体验作品交互</button><section><div><h2>项目背景</h2><p>把完成的作品呈现给团队，让反馈与分享自然发生。</p></div><div><h2>目标与价值</h2><p>保留作品的完整体验，按需使用编辑和分享工具。</p></div></section></html>`;

let browser: Browser;
let headers: Record<string, string>;
let cookie: { name: string; value: string };
let slug: string;
let version: string;
async function ownerPage(beforeNavigate?: (page: Page) => Promise<void>) {
  const context = await browser.createBrowserContext();
  await context.setCookie({ ...cookie, domain: new URL(base!).hostname, path: "/", httpOnly: true });
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.bringToFront();
  await beforeNavigate?.(page);
  await page.goto(`${base}/s/${slug}?lang=en`, { waitUntil: "networkidle2" });
  return { context, page };
}
async function sharing(page: Page) {
  // Wait for the resolved identity's prefetch before clicking the keyed panel.
  await page.waitForFunction(() => performance.getEntriesByType("resource").some(entry => entry.name.includes("/sharing?summary=1")));
  await page.$eval('[data-analytics-button="share"]', el => (el as HTMLElement).focus());
  await page.locator('[data-analytics-button="share"]').click();
  await page.waitForSelector(".sharing-audiences input[type=radio]:not(:disabled)");
  await page.waitForSelector(".sharing-main-policy input[type=checkbox], #legacy-comments");
}
async function saveCustom(page: Page) {
  if (await page.$('.sharing-confirmation:modal')) await page.click('.sharing-confirmation footer button[type="submit"]');
  await page.waitForSelector('.sharing-confirmation', {hidden:true});
  await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
  await page.waitForSelector('.sharing-copy-button:not([disabled])');
}
async function more(page: Page) {
  await page.locator('button[aria-label="More sharing options"]:not([disabled])').click();
  await page.waitForSelector('.sharing-more-menu');
}
async function api(path: string, method = "GET", body?: unknown) {
  return fetch(`${base}/api/sites/${slug}/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("simplified sharing and presentation", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    await mkdir("test-results", { recursive: true });
    const user = await upsertUser({ authProvider: "sharing-e2e", providerSubject: createId("subject"), email: `${createId("user")}@example.com`, emailVerified: true });
    const tenant = createId("sharing-team");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Design team')", [tenant]);
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant,user.id]);
    await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant,user.id]);
    const session = await mintSession(new Request(base!), user.id);
    const [name, value] = session.cookie.split(";")[0].split("="); cookie = { name, value };
    headers = { cookie: `${name}=${value}`, origin: base!, "content-type": "application/json" };
    const response = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ mode: "paste", title: "Sharing acceptance", html: fixture }) });
    expect(response.status).toBe(200);
    slug = (await response.json()).slug;
    expect((await api("sharing", "PUT", { visibility: "private" })).status).toBe(200);
    version = (await (await api("versions")).json()).versions[0].id;
  }, 60_000);
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });

  it("prefetches once, keeps heavy panels lazy, and reopens without a loading flash", async () => {
    const requests: string[] = [];
    const { context, page } = await ownerPage(async page => {
      page.on("request", request => requests.push(new URL(request.url()).pathname));
    });
    try {
      await page.waitForFunction(() => performance.getEntriesByType("resource").some(entry => entry.name.includes("/comment-settings")));
      // Both settings requests already ran while the share panel was closed.
      expect(requests.filter(path => path.endsWith(`/${slug}/sharing`))).toHaveLength(1);
      expect(requests.filter(path => path.endsWith(`/${slug}/comment-settings`))).toHaveLength(1);
      expect(requests.some(path => path.endsWith(`/${slug}/shares`) || path.includes("/authorization/bindings"))).toBe(false);
      await sharing(page);
      await page.click('.sharing-dialog-head button[aria-label="Close"]');
      const before = requests.length;
      const state = await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('[data-analytics-button="share"]')!.click();
        return new Promise(resolve => requestAnimationFrame(() => resolve({
          skeleton: !!document.querySelector('.sharing-audience-skeleton'),
          access: !!document.querySelector('.sharing-main-policy'),
        })));
      });
      expect(state).toEqual({ skeleton: false, access: true });
      expect(requests.slice(before).filter(path => path.endsWith("/shares") || path.includes("/authorization/bindings"))).toHaveLength(0);
    } finally { await context.close(); }
  });

  it("shows access independently of slow comments and keeps the mobile copy footer visible", async () => {
    let release: (() => void) | undefined;
    const { context, page } = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.url().endsWith(`/${slug}/comment-settings`)) release = () => { void request.continue(); };
        else void request.continue();
      });
    });
    try {
      await page.click('[data-analytics-button="share"]');
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      expect(await page.$('.sharing-audiences input[type=radio]:checked')).not.toBeNull();
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(false);
      for (const width of [390, 320]) {
        await page.setViewport({width, height:568});
        await page.$eval('.sharing-dialog-body', el => { el.scrollTop = el.scrollHeight; });
        const layout = await page.evaluate(() => {
          const dialog = document.querySelector('.sharing-dialog')!;
          const button = document.querySelector('.sharing-copy-button')!.getBoundingClientRect();
          return { fits: dialog.scrollWidth <= dialog.clientWidth, visible: button.top >= 0 && button.bottom <= innerHeight, hitHeight: button.height };
        });
        expect(layout).toMatchObject({fits:true, visible:true});
        expect(layout.hitHeight).toBeGreaterThanOrEqual(44);
        await page.screenshot({path:`test-results/sharing-slow-mobile-${width}.png`});
      }
      release?.(); release = undefined;
      await page.waitForSelector('.sharing-main-policy input[type=checkbox], #legacy-comments');
    } finally { release?.(); await context.close(); }
  });

  it("keeps cached controls visible on background failure, disables writes, and recovers", async () => {
    const { context, page } = await ownerPage();
    try {
      await sharing(page);
      let fail = true;
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (fail && new URL(request.url()).pathname.endsWith(`/${slug}/sharing`)) void request.respond({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'});
        else void request.continue();
      });
      await page.evaluate(() => window.dispatchEvent(new Event("artifact:shares-changed")));
      await page.waitForSelector('.sharing-fetch-error');
      expect(await page.$('.sharing-audiences input[type=radio]:checked')).not.toBeNull();
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked', el => el.matches(":disabled"))).toBe(true);
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(true);
      fail = false;
      await page.locator('.sharing-fetch-error button').click();
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      await page.waitForSelector('.sharing-fetch-error', {hidden:true});
    } finally { await context.close(); }
  });

  it("retries failed access and restores copying while comments remain pending", async () => {
    let fail = true;
    let heldComments = 0;
    const { context, page } = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.url().endsWith(`/${slug}/comment-settings`)) { heldComments++; return; }
        if (fail && new URL(request.url()).pathname.endsWith(`/${slug}/sharing`)) {
          void request.respond({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'});
        } else void request.continue();
      });
    });
    try {
      await page.click('[data-analytics-button="share"]');
      await page.waitForSelector('.sharing-fetch-error button:not([disabled])');
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(true);
      fail = false;
      await page.locator('.sharing-fetch-error button').click();
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      await page.waitForSelector('.sharing-fetch-error', {hidden:true});
      expect(heldComments).toBeGreaterThanOrEqual(1);
      expect(await page.$('.sharing-audiences input[type=radio]:checked')).not.toBeNull();
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(false);
      expect(await page.$eval('.sharing-more > button', el => (el as HTMLButtonElement).disabled)).toBe(false);
      expect(await page.$eval('.sharing-links-entry', el => (el as HTMLButtonElement).disabled)).toBe(false);
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
      await page.click('.sharing-copy-button');
      await page.waitForFunction(() => document.querySelector('.sharing-copy p')?.textContent?.includes('Link copied'));
    } finally { await context.close(); }
  });

  it("opens member creation directly and preserves historical comment controls", async () => {
    const { context, page } = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.url().endsWith(`/${slug}/comment-settings`)) void request.respond({status:200,contentType:"application/json",body:JSON.stringify({mainPolicy:"members",readerAccess:false})});
        else void request.continue();
      });
    });
    try {
      await sharing(page);
      await page.click('.sharing-option .sharing-help-trigger');
      await page.waitForSelector('.sharing-help-popover:popover-open');
      expect(await page.$eval('.sharing-help-popover:popover-open',el=>el.textContent)).toContain('keeps its original discussion visibility');
      await page.keyboard.press('Escape');
      // Opening the new editor must not migrate an existing discussion policy.
      expect((await (await api("comment-settings")).json()).mainPolicy).toBeDefined();
      expect(await page.$('.sharing-audiences input[type=radio]:checked')).not.toBeNull();
      await more(page);
      await page.click('.sharing-more-menu button:first-child');
      await page.waitForSelector('.authorization-heading button');
      await page.click('.authorization-heading button');
      await page.type('.authorization-form input[placeholder="Name or email"]', 'design-review@example.test');
      await page.waitForSelector('.authorization-form');
      expect(await page.$$('dialog:modal')).toHaveLength(1);
      expect(await page.$eval('.authorization-form input[placeholder="Name or email"]',el=>(el as HTMLInputElement).value)).toBe('design-review@example.test');
      await page.waitForFunction(() => document.activeElement?.closest('.authorization-form') !== null);
    } finally { await context.close(); }
  });

  it("does not prefetch management data for an unrelated viewer", async () => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const requests: string[] = [];
      page.on('request', request => requests.push(new URL(request.url()).pathname));
      await api("sharing", "PUT", {visibility:"unlisted"});
      await page.goto(`${base}/s/${slug}?lang=en`, {waitUntil:"networkidle2"});
      expect(await page.$('[data-analytics-button="share"]')).toBeNull();
      expect(requests.some(path => path.endsWith('/sharing') || path.endsWith('/comment-settings'))).toBe(false);
    } finally { await api("sharing", "PUT", {visibility:"private"}); await context.close(); }
  });

  it("copies only the main link, with no permission mutation or independent link", async () => {
    const { context, page } = await ownerPage();
    try {
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { document.documentElement.dataset.copiedUrl = value; } } }));
      await sharing(page);
      expect(await page.$eval(".sharing-audiences input[type=radio]:checked", el => (el as HTMLInputElement).value)).toBe("private");
      expect(await page.$eval(".sharing-main-policy input[type=checkbox]", el => (el as HTMLInputElement).checked)).toBe(true);
      expect(await page.$eval(".sharing-dialog", el => el.parentElement === document.body && el.matches(":modal"))).toBe(true);
      await page.click(".sharing-copy-button");
      await page.waitForFunction(() => document.querySelector(".sharing-copy p")?.textContent?.includes("Link copied"));
      expect(await page.evaluate(() => document.documentElement.dataset.copiedUrl)).toBe(`${base}/s/${slug}`);
      expect((await (await api("sharing")).json()).visibility).toBe("private");
      expect((await (await api("shares")).json()).shares).toHaveLength(0);
      const denied = await fetch(`${base}/s/${slug}?lang=en`);
      expect(denied.status).toBe(200);
      const deniedHtml = await denied.text();
      expect(deniedHtml).toContain("Access denied");
      expect(deniedHtml).not.toContain('<iframe');
      expect(deniedHtml).not.toContain("Sharing acceptance");
      expect((await fetch(`${base}/api/preview/${slug}`)).status).toBe(404);
      await page.screenshot({ path: "test-results/sharing-main.png" });
      expect(await page.$('.sharing-status svg')).toBeNull();
      expect(await page.$('.sharing-copy-fallback')).toBeNull();
      for (const width of [1280, 390, 320]) {
        await page.setViewport({width, height:844});
        await more(page);
        await page.$eval('.sharing-more-menu', el => {
          const menu = el.getBoundingClientRect();
          if (menu.left < 0 || menu.right > innerWidth) throw new Error('More menu clipped');
        });
        expect(await page.$$('.sharing-dialog button')).not.toHaveLength(0);
        await page.screenshot({path:`test-results/sharing-more-${width}.png`});
        await page.keyboard.press('Escape');
        expect(await page.$('.sharing-dialog:modal')).not.toBeNull();
      }
      await page.setViewport({width:1280,height:900});
      await page.click('.sharing-links-entry');
      await page.waitForSelector('.share-new-trigger');
      expect(await page.$eval('.sharing-dialog h2', el => el.textContent)).toBe('Independent sharing links');
    } finally { await context.close(); }
  });

  it("confirms public access once, rolls back failures and retries without a separate save", async () => {
    await api("sharing", "PUT", {visibility:"private"});
    let finish: (() => void) | undefined;
    let fail = true;
    const {context,page} = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith(`/${slug}/main-sharing`)) {
          finish = () => { void (fail ? request.respond({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'}) : request.continue()); };
        } else void request.continue();
      });
    });
    try {
      await sharing(page);
      await chooseAudience(page, 'anyone');
      await page.waitForSelector('.sharing-confirmation:modal');
      expect((await (await api('sharing')).json()).visibility).toBe('private');
      await page.click('.sharing-confirmation footer button[type="submit"]');
      await page.waitForSelector('.sharing-audiences input[type=radio]:disabled');
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(true);
      await vi.waitFor(() => expect(finish).toBeDefined());
      finish!(); finish = undefined;
      await page.waitForSelector('.sharing-confirmation .drawer-error');
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked', el => (el as HTMLInputElement).value)).toBe('private');
      expect((await (await api('sharing')).json()).visibility).toBe('private');
      fail = false;
      await page.click('.sharing-confirmation footer button[type="submit"]');
      await vi.waitFor(() => expect(finish).toBeDefined());
      finish!(); finish = undefined;
      await page.waitForSelector('.sharing-confirmation', {hidden:true});
      await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      expect((await (await api('sharing')).json()).visibility).toBe('unlisted');
      expect(await page.$('.scope-form-actions')).toBeNull();
      await page.waitForSelector('.vis-unlisted');
      await page.keyboard.press('Escape');
      for (const width of [1280,390,320]) {
        await page.setViewport({width,height:844});
        await page.click('.vis-unlisted');
        await page.waitForSelector('.visibility-explanation:popover-open');
        expect(await page.$eval('.visibility-explanation:popover-open', el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
        await page.screenshot({path:`test-results/instant-access-${width}.png`});
        await page.keyboard.press('Escape');
      }
    } finally { finish?.(); await context.close(); await api('sharing','PUT',{visibility:'private'}); }
  });

  it("keeps comment URLs and return trails synchronized through router refresh", async () => {
    const created=await fetch(`${base}/api/sites`,{method:"POST",headers,body:JSON.stringify({mode:"paste",html:"<h1>History sync evidence</h1>"})});
    expect(created.status).toBe(200);
    const site=(await getSiteBySlug((await created.json()).slug))!;
    // The first automatic edit must differ from CI's public creation default.
    expect((await fetch(`${base}/api/sites/${site.slug}/main-sharing`,{method:"PUT",headers,body:JSON.stringify({action:"custom",policy:{audience:"private",comments:true}})})).status).toBe(200);
    const comment=await fetch(`${base}/api/sites/${site.slug}/comments`,{method:"POST",headers,body:JSON.stringify({scope:{siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main"}},body:"History sync evidence",clientRequestId:crypto.randomUUID(),anchor:{schemaVersion:1,kind:"html",filePath:"index.html",selector:"h1",quote:{exact:"History sync evidence"},viewport:{width:1440,height:900}}})});
    expect(comment.ok).toBe(true);
    const id=(await comment.json()).thread.id;
    const replacement=await fetch(`${base}/api/sites/${site.slug}/versions`,{method:"POST",headers,body:JSON.stringify({mode:"paste",html:"<h1>Current evidence</h1>"})});
    expect(replacement.ok).toBe(true);
    const {context,page}=await ownerPage();
    try {
      await page.goto(base!+"/me?lang=en",{waitUntil:"networkidle2"});
      await page.evaluate(({slug,id})=>{const a=document.createElement("a");a.href=`/s/${slug}?lang=en&thread=${id}`;a.id="history-sync-entry";a.textContent="Open";a.style.cssText="position:fixed;top:100px;left:20px;z-index:9999;background:white";document.body.append(a);},{slug:site.slug,id});
      await Promise.all([page.waitForNavigation({waitUntil:"networkidle2"}),page.click("#history-sync-entry")]);
      await page.waitForSelector(".comment-conversation");
      async function refreshThroughSharing(visibility:string) {
        const expected=page.url();
        await page.click('[data-analytics-button="share"]');
        await page.waitForSelector(".sharing-audiences input[type=radio]:not(:disabled)");
        const refreshed=page.waitForResponse(r=>r.request().headers()["rsc"]==="1" && new URL(r.url()).pathname===`/s/${site.slug}`);
        await chooseAudience(page, visibility === "unlisted" ? "anyone" : visibility);
        await saveCustom(page);
        await refreshed;
        await page.waitForFunction(()=>document.querySelector(".sharing-status")?.textContent==="Sharing settings updated");
        await page.waitForNetworkIdle();
        expect(page.url()).toBe(expected);
        expect(await page.$eval("a[data-viewer-return]",a=>a.getAttribute("href"))).toBe("/me?lang=en");
        await page.click('.sharing-dialog-head button[aria-label="Close"]');
      }
      await page.click(".comment-panel-heading > button");
      expect(new URL(page.url()).searchParams.has("thread")).toBe(false);
      await refreshThroughSharing("unlisted");
      await page.select('select[aria-label="Version"]',"all");
      await page.waitForSelector(".comment-summary");
      await page.click(".comment-summary");
      await page.waitForSelector(".comment-conversation");
      expect(new URL(page.url()).searchParams.get("comments")).toBe("all");
      expect(new URL(page.url()).hash).toBe(`#comment=${id}`);
      await refreshThroughSharing("private");
      await page.click(".comment-panel-heading > button");
      expect(new URL(page.url()).hash).toBe("");
      await refreshThroughSharing("unlisted");
    } finally { await context.close(); }
  });

  it("returns to the entry page after version changes and reloads, with a home fallback", async () => {
    const {context,page} = await ownerPage();
    try {
      const source = `${base}/?q=design&tab=recent`;
      await page.goto(source, {waitUntil:'networkidle2'});
      await page.evaluate(slug => { const a = document.createElement('a'); a.href = `/s/${slug}?lang=en`; a.id = 'return-test-link'; a.textContent = 'Open'; document.body.append(a); }, slug);
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}), page.click('#return-test-link')]);
      expect(await page.evaluate(() => history.state?.artifactReturnTo), 'initial entry').toBe('/?q=design&tab=recent');
      await page.evaluate(({slug,version}) => { const a = document.createElement('a'); a.id = 'version-entry'; a.style.cssText = 'position:fixed;z-index:9999;top:100px;left:20px;background:white'; a.href = `/s/${slug}?lang=en&version=${version}`; a.textContent = 'Version'; document.body.append(a); }, {slug,version});
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}),page.click('#version-entry')]);
      await page.waitForFunction(() => history.state?.artifactReturnTo !== undefined);
      expect(await page.evaluate(() => history.state?.artifactReturnTo), 'version entry').toBe('/?q=design&tab=recent');
      await page.reload({waitUntil:'networkidle2'});
      expect(await page.evaluate(() => history.state?.artifactReturnTo), 'reload entry').toBe('/?q=design&tab=recent');
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}),page.click('.fs-bar .brand')]);
      expect(page.url()).toBe(source);
      const direct = await context.newPage();
      await direct.bringToFront();
      await direct.goto(`${base}/s/${slug}?lang=en`, {waitUntil:'networkidle2'});
      await Promise.all([direct.waitForNavigation({waitUntil:'networkidle2'}),direct.click('.fs-bar .brand')]);
      expect(new URL(direct.url()).pathname).toBe('/');
      await page.bringToFront();
      const library = `${base}/me?view=list`;
      await page.goto(library, {waitUntil:'networkidle2'});
      await page.waitForSelector(`a[href="/s/${slug}"]`);
      await page.click(`a[href="/s/${slug}"]`);
      await page.waitForSelector('.fs-bar .brand');
      await page.waitForFunction(() => history.state?.artifactReturnTo === '/me?view=list');
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}), page.click('.fs-bar .brand')]);
      expect(page.url()).toBe(library);
    } finally { await context.close(); }
  });

  it("preserves entry history through fork, consecutive returns and Back/Forward", async () => {
    const {context,page} = await ownerPage();
    try {
      const source = `${base}/me?view=list`;
      await page.goto(source, {waitUntil:'networkidle2'});
      await page.waitForSelector(`a[href="/s/${slug}"]`);
      await page.click(`a[href="/s/${slug}"]`);
      await page.waitForSelector('.fs-bar .brand');
      await page.click('button[aria-label="More"]');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent?.trim() === 'Save as new site'));
      await page.evaluate(() => (Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(el => el.textContent?.trim() === 'Save as new site'))!.click());
      await page.waitForFunction(original => location.pathname !== `/s/${original}` && location.pathname.startsWith('/s/'), {}, slug);
      const fork = page.url();
      await page.waitForFunction(original => document.querySelector('.fs-bar .brand')?.getAttribute('href')?.startsWith(`/s/${original}`), {}, slug);
      await page.goBack({waitUntil:'networkidle2'});
      expect(await page.$eval('.fs-bar .brand', el => el.getAttribute('href'))).toBe('/me?view=list');
      await page.goForward({waitUntil:'networkidle2'});
      expect(page.url()).toBe(fork);
      await page.click('.fs-bar .brand');
      await page.waitForFunction(original => location.pathname === `/s/${original}`, {}, slug);
      await page.waitForFunction(() => document.querySelector('.fs-bar .brand')?.getAttribute('href') === '/me?view=list');
      await page.click('.fs-bar .brand');
      await page.waitForFunction(() => location.pathname === '/me');
      expect(page.url()).toBe(source);
    } finally { await context.close(); }
  });

  it("preserves the entry through an actual language-switch full navigation without Referer", async () => {
    // Expose the account language menu without requiring a live identity provider.
    const me = await (await fetch(`${base}/api/auth/me`, {headers})).json();
    const {context,page} = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/auth/me') void request.respond({status:200,contentType:'application/json',body:JSON.stringify({...me,oidcEnabled:true})});
        else void request.continue();
      });
    });
    try {
      await page.goto(`${base}/me?view=list`, {waitUntil:'networkidle2'});
      await page.evaluate(slug => { const a = document.createElement('a'); a.id = 'language-entry'; a.href = `/s/${slug}?lang=en`; a.textContent = 'Open'; document.body.append(a); }, slug);
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}),page.click('#language-entry')]);
      await page.click('.auth-chip > button');
      await page.click('.auth-language > button');
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}),page.click('.auth-language-menu button:first-child')]);
      expect(new URL(page.url()).searchParams.has('lang')).toBe(false);
      expect(await page.evaluate(() => document.referrer)).toBe('');
      expect(await page.$eval('html', el => el.lang)).toBe('zh-CN');
      expect(await page.$eval('.fs-bar .brand', el => el.getAttribute('href'))).toBe('/me?view=list');
      await page.click('.fs-bar .brand');
      await page.waitForFunction(() => location.pathname === '/me');
      expect(page.url()).toBe(`${base}/me?view=list`);
    } finally { await context.close(); }
  });

  it("saves confirmed custom link access, pauses comments, and keeps advanced creation at the top", async () => {
    const { context, page } = await ownerPage();
    try {
      await sharing(page);
      await chooseAudience(page, "anyone");
      await saveCustom(page);
      await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
      expect(await page.$('.sharing-save, .share-confirm')).toBeNull();
      expect((await (await api("sharing")).json()).visibility).toBe("unlisted");
      expect((await fetch(`${base}/s/${slug}`)).status).toBe(200);
      expect((await (await api("shares")).json()).shares).toHaveLength(0);
      await page.click(".sharing-main-policy input[type=checkbox]");
      await saveCustom(page);
      await page.waitForFunction(() => document.querySelector(".sharing-dialog")?.textContent?.includes("New comments and replies are paused"));
      expect((await (await api("comment-settings")).json()).mainPolicy).toBe("off");
      await page.click(".sharing-main-policy input[type=checkbox]");
      await saveCustom(page);
      await page.waitForFunction(() => document.querySelector(".sharing-dialog")?.textContent?.includes("Readers can see comments"));
      await page.locator(".sharing-links-entry").click();
      await page.waitForSelector(".share-new-trigger");
      const text = await page.$eval(".sharing-dialog", el => el.textContent);
      expect(text).toContain("Independent sharing links");
      expect(await page.$$('.sharing-dialog [role="tab"]')).toHaveLength(0);
      expect(await page.$eval(".share-new-trigger", el => el.textContent)).toContain("New share link");
      await page.click(".share-new-trigger");
      await page.type('#share-new-label', 'Draft audience');
      await page.click('button[aria-label="Expand"]');
      await page.waitForSelector('.sharing-dialog.is-expanded');
      expect(await page.$eval('#share-new-label', el => (el as HTMLInputElement).value)).toBe('Draft audience');
      await page.screenshot({ path: "test-results/sharing-advanced-expanded.png" });
      await page.click('button[aria-label="Collapse"]');
      expect(await page.$eval('#share-new-label', el => (el as HTMLInputElement).value)).toBe('Draft audience');
      await page.screenshot({ path: "test-results/sharing-advanced.png" });
    } finally { await context.close(); }
  });

  it("edits member access within the same panel and opens visits from More", async () => {
    const { context, page } = await ownerPage();
    try {
      await sharing(page);
      await more(page);
      await page.click('.sharing-more-menu button:first-child');
      await page.waitForSelector('.authorization-heading button');
      const width = await page.$eval('.sharing-dialog', el => el.getBoundingClientRect().width);
      await page.click('.authorization-heading button');
      await page.waitForSelector('.authorization-form');
      expect(await page.$$('dialog:modal')).toHaveLength(1);
      expect(await page.$eval('.sharing-dialog', el => el.getBoundingClientRect().width)).toBe(width);
      const member = await upsertUser({authProvider:"sharing-e2e", providerSubject:createId("member"), email:`${createId("member")}@example.com`, emailVerified:true});
      await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [(await getSiteBySlug(slug))!.tenantId, member.id]);
      await page.type('.authorization-form input[placeholder="Name or email"]', member.email!);
      await page.waitForSelector(`.authorization-form input[type="radio"][value="${member.id}"]`);
      await page.click(`.authorization-form input[type="radio"][value="${member.id}"]`);
      await page.waitForFunction(() => !!document.querySelector('.authorization-form option[value="viewer"]'));
      await page.select('.authorization-form form > label:last-of-type select', 'viewer');
      await page.setViewport({width:390,height:844});
      expect(await page.$eval('.sharing-dialog', el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({path:'test-results/sharing-members-mobile.png'});
      await page.setViewport({width:1280,height:900});
      await page.screenshot({path:'test-results/sharing-members-inline.png'});
      await page.click('.authorization-form button[type="submit"]');
      await page.waitForSelector('.authorization-form', {hidden:true});
      await page.waitForSelector('.authorization-list li');
      expect(await page.$eval('.authorization-list', el => el.textContent)).toContain('@example.com');
      await page.click('.authorization-list li button');
      await page.waitForSelector('.authorization-form');
      await page.click('.authorization-actions button:nth-child(2)');
      await page.waitForSelector('.authorization-form', {hidden:true});
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sharing-dialog', {hidden:true});
      await page.click('button[aria-label="More"]');
      await page.waitForSelector('.more-menu:not([hidden])');
      const history = await page.$('.more-menu button[aria-haspopup="dialog"]');
      expect(await history!.evaluate(el => el.textContent)).toContain('View history');
      await history!.click();
      await page.waitForSelector('.sharing-dialog');
      expect(await page.$eval('.sharing-dialog h2', el => el.textContent)).toBe('View history');
      expect(await page.$$('.sharing-dialog [role="tab"]')).toHaveLength(0);
    } finally { await context.close(); }
  });

  for (const pending of [false, true]) {
    it(pending ? "keeps both dialogs open while revocation is pending" : "Escape cancels only the nested revocation confirmation", async () => {
      const created = await api("shares", "POST", {policy:"login", label:"Cancel isolation"});
      expect(created.status).toBe(201);
      const {share} = await created.json();
      const {context, page} = await ownerPage();
      let release: (() => void) | undefined;
      let intercepted!: () => void;
      const requestSeen = new Promise<void>(resolve => { intercepted = resolve; });
      try {
        if (pending) {
          await page.setRequestInterception(true);
          page.on("request", request => {
            if (request.method() === "DELETE" && request.url().endsWith(`/shares/${share.id}`)) {
              release = () => { void request.respond({status:503, contentType:"application/json", body:JSON.stringify({error:"Revocation temporarily unavailable"})}); };
              intercepted();
            } else void request.continue();
          });
        }
        await sharing(page);
        await page.locator(".sharing-links-entry").click();
        await page.waitForSelector(`#share-card-${share.id}`);
        await page.click(`#share-card-${share.id} .share-link-settings > summary`);
        await page.click(`#share-card-${share.id} .danger`);
        await page.waitForSelector(".share-confirm:modal");
        if (pending) { await page.click(".share-confirm .solid"); await requestSeen; }
        await page.keyboard.press("Escape");
        expect(await page.$(".sharing-dialog:modal")).not.toBeNull();
        if (pending) {
          expect(await page.$(".share-confirm:modal")).not.toBeNull();
          expect(await page.$eval(".share-confirm .solid", el => (el as HTMLButtonElement).disabled)).toBe(true);
          release!(); release = undefined;
          await page.waitForFunction(() => document.querySelector(".share-confirm .share-error")?.textContent?.includes("Revocation temporarily unavailable"));
          expect(await page.$(".sharing-dialog:modal")).not.toBeNull();
          await page.keyboard.press("Escape");
        }
        await page.waitForSelector(".share-confirm", {hidden:true});
        expect(await page.$(".sharing-dialog:modal")).not.toBeNull();
        expect(await page.$eval(`#share-card-${share.id} .danger`, el => el === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        await page.waitForSelector(".sharing-dialog", {hidden:true});
      } finally { release?.(); await context.close(); await api(`shares/${share.id}`, "DELETE"); }
    });
  }

  it("fails closed when access settings cannot be loaded and permits an explicit retry", async () => {
    const { context, page } = await ownerPage();
    try {
      let fail = true;
      await page.setRequestInterception(true);
      page.on("request", request => { if (fail && new URL(request.url()).pathname.endsWith(`/api/sites/${slug}/sharing`)) void request.respond({ status: 503, contentType: "application/json", body: '{"error":"Unavailable"}' }); else void request.continue(); });
      await page.reload({waitUntil:"networkidle2"});
      await page.locator('[data-analytics-button="share"]').click();
      await page.waitForSelector(".sharing-fetch-error");
      await page.waitForSelector(".sharing-audiences input[type=radio]:disabled");
      expect(await page.$eval(".sharing-copy-button", el => (el as HTMLButtonElement).disabled)).toBe(true);
      fail = false;
      await page.locator(".sharing-fetch-error button").click();
      await page.waitForSelector(".sharing-audiences input[type=radio]:not(:disabled)");
    } finally { await context.close(); }
  });

  it("retries the new policy lookup without enabling copy or trapping the dialog", async () => {
    let fail = true;
    const {context, page} = await ownerPage(async page => {
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (fail && new URL(request.url()).pathname.endsWith(`/${slug}/main-sharing`))
          void request.respond({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'});
        else void request.continue();
      });
    });
    try {
      await page.click('[data-analytics-button="share"]');
      await page.waitForSelector('.sharing-main-policy .sharing-policy-error');
      expect(await page.$eval('.sharing-copy-button', el => (el as HTMLButtonElement).disabled)).toBe(true);
      await page.click('.sharing-dialog-head button[aria-label="Close"]');
      await page.waitForSelector('.sharing-dialog',{hidden:true});
      await page.click('[data-analytics-button="share"]');
      await page.waitForSelector('.sharing-main-policy .sharing-policy-error');
      fail = false;
      await page.click('.sharing-policy-error button');
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      expect(await page.$('.sharing-main-policy .sharing-policy-error')).toBeNull();
    } finally { await context.close(); }
  });

  it("renders Chinese audience cards and a full-row access target on desktop and mobile", async () => {
    const member = await upsertUser({authProvider:"sharing-e2e",providerSubject:createId("member"),displayName:"张晓",email:`${createId("member")}@example.com`,emailVerified:true});
    await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [(await getSiteBySlug(slug))!.tenantId, member.id]);
    const {siteId} = await (await api("sharing")).json();
    const grantResponse = await fetch(`${base}/api/authorization/bindings`, {method:"POST",headers,body:JSON.stringify({resource:{type:"site",id:siteId},subject:{type:"user",id:member.id},roleId:"viewer"})});
    expect(grantResponse.status).toBe(200);
    const binding = await grantResponse.json();
    const {context,page} = await ownerPage();
    try {
      await page.goto(`${base}/s/${slug}?lang=zh-CN`, {waitUntil:"networkidle2"});
      await sharing(page);
      expect(await page.$('.sharing-avatars')).toBeNull();
      expect(await page.$eval('.sharing-dialog h2', el => el.textContent)).toBe('分享作品');
      expect(await page.$eval('.sharing-audience-card', el => {
        const row = el.getBoundingClientRect(), label = el.querySelector('label')!.getBoundingClientRect();
        return Math.abs(row.width - label.width) <= 2 && label.height >= 44;
      })).toBe(true);
      for (const width of [1280,390,320]) {
        await page.setViewport({width,height:844});
        expect(await page.$eval('.sharing-dialog', el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({path:`test-results/sharing-zh-${width}.png`});
      }
    } finally {
      await context.close();
      await fetch(`${base}/api/authorization/bindings/${binding.id}`, {method:"DELETE",headers,body:JSON.stringify({expectedRevision:binding.revision})});
    }
  });

  it("uses a host presentation URL while retaining the sandbox, selected version and access gate", async () => {
    const { context, page } = await ownerPage();
    try {
      await page.goto(`${base}/s/${slug}?version=${version}&presentation=1`, { waitUntil: "networkidle2" });
      expect(await page.$(".fs-bar")).toBeNull();
      const iframe = await page.waitForSelector(".viewer-presentation iframe");
      expect(await iframe!.evaluate(el => el.getAttribute("sandbox"))).not.toContain("allow-same-origin");
      expect(await iframe!.evaluate(el => el.getAttribute("src"))).toContain(`v=${version}`);
      expect(await page.$eval(".presentation-exit", el => el.getAttribute("href"))).toBe(`/s/${slug}?version=${version}`);
      await api("sharing", "PUT", { visibility: "private" });
      const denied = await fetch(`${base}/s/${slug}?presentation=1&lang=en`);
      expect(denied.status).toBe(200);
      const deniedHtml = await denied.text();
      expect(deniedHtml).toContain("Access denied");
      expect(deniedHtml).not.toContain('<iframe');
      expect(deniedHtml).not.toContain("Sharing acceptance");
      expect((await fetch(`${base}/api/preview/${slug}`)).status).toBe(404);
    } finally { await context.close(); }
  });
  it("keeps both independent-link entry points and preserves permission feedback after copying", async () => {
    await api("main-sharing", "PUT", {action:"custom",policy:{audience:"private",comments:true}});
    const created = await api("shares", "POST", {policy:"login",label:"Dual entry acceptance"});
    const link = await created.json();
    const {context,page} = await ownerPage();
    try {
      await sharing(page);
      expect(await page.$eval('.sharing-status', el => el.textContent)).toBe('');
      expect(await page.$eval('.sharing-configuration',el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      await chooseAudience(page, 'tenant');
      await saveCustom(page);
      expect(await page.$eval('.sharing-links-entry', el => el.textContent)).toContain('(1)');
      await more(page);
      expect(await page.$eval('.sharing-more-menu [role="menuitem"]:nth-child(2)', el => el.textContent)).toBe('Independent sharing links (1)');
      expect(await page.$('.sharing-links-entry')).not.toBeNull();
      await page.click('.sharing-more-menu [role="menuitem"]:nth-child(2)');
      await page.waitForSelector(`#share-card-${link.share.id}`);
      await page.click('.sharing-dialog-head button');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async () => {}}}));
      await page.click('.sharing-copy-button');
      await page.waitForFunction(() => document.querySelector('.sharing-copy p')?.textContent?.includes('Link copied'));
      expect(await page.$eval('.sharing-status',el=>el.textContent)).toBe('Sharing settings updated');
      await page.click('.sharing-links-entry');
      await page.waitForSelector(`#share-card-${link.share.id}`);
    } finally { await context.close(); await api(`shares/${link.share.id}`,'DELETE'); await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}}); }
  });

  it("confirms Discover exposure once, applies immediately, and keeps ordinary toggles automatic", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'tenant',comments:true}});
    const {context,page} = await ownerPage();
    try {
      await sharing(page);
      expect(await page.$('input[id$="-discover"]')).toBeNull();
      await chooseAudience(page, 'anyone');
      await page.waitForSelector('.sharing-confirmation:modal');
      expect(await page.$eval('.sharing-confirmation h2',el=>el.textContent)).toBe('Allow anyone to access?');
      expect(await page.$eval('.sharing-confirmation', el => el.getAttribute('role'))).toBe('alertdialog');
      expect(await page.$('.sharing-confirmation .sharing-change-summary')).toBeNull();
      expect(await page.$('.sharing-confirmation .sharing-inheritance-warning')).toBeNull();
      expect(await page.$eval('.sharing-confirmation', el => el.textContent)).not.toContain('This does not list');
      expect(await page.$eval('.sharing-confirmation footer button[type="submit"]', el => getComputedStyle(el).backgroundColor)).toBe('rgb(159, 52, 52)');
      expect(await page.$eval('.sharing-confirmation', el => el.getBoundingClientRect().height)).toBeLessThan(340);
      await page.keyboard.press('Escape');
      // Native Escape closes the dialog before React removes its draft controls.
      await page.waitForFunction(() => !document.querySelector('.sharing-confirmation'));
      expect(await page.$('input[id$="-discover"]')).toBeNull();
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'tenant'}});
      await chooseAudience(page, 'anyone');
      await saveCustom(page);
      await page.click('input[id$="-discover"]');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'public'},pending:false});
      expect((await fetch(`${base}/s/${slug}`)).status).toBe(200);
      expect(await page.$('.moderation-status')).toBeNull();
      await page.click('input[id$="-comments"]');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'public',comments:false}});
      await page.click('input[id$="-discover"]');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'anyone',comments:false}});
      expect((await fetch(`${base}/s/${slug}`)).status).toBe(200);
      await page.click('input[id$="-discover"]');
      await saveCustom(page);
      await chooseAudience(page, 'tenant');
      await page.waitForSelector('.sharing-confirmation:modal');
      expect(await page.$eval('.sharing-confirmation',el=>el.textContent)).toContain('removes the artifact from Discover');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'tenant',comments:false}});
      const denied = await fetch(`${base}/s/${slug}?lang=en`);
      expect(denied.status).toBe(200);
      const deniedHtml = await denied.text();
      expect(deniedHtml).toContain("Access denied");
      expect(deniedHtml).not.toContain('<iframe');
      expect(deniedHtml).not.toContain("Sharing acceptance");
      expect((await fetch(`${base}/api/preview/${slug}`)).status).toBe(404);
    } finally { await context.close(); await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}}); }
  });

  it("preserves hidden legacy discussions when an anonymous creator turns off Discover", async () => {
    const uploaded=await fetch(`${base}/api/sites`,{method:'POST',headers:{origin:base!,'content-type':'application/json'},body:JSON.stringify({mode:'paste',html:'<h1>Anonymous legacy discussion</h1>'})});
    expect(uploaded.status).toBe(200);
    const anonymous=(await getSiteBySlug((await uploaded.json()).slug))!;
    const pair=uploaded.headers.getSetCookie().find(value=>/^(?:__Host-)?ah_anon=/.test(value))!.split(';')[0];
    const [name,value]=pair.split('=');
    await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1",[anonymous.id]);
    const comment=await fetch(`${base}/api/sites/${anonymous.slug}/comments`,{method:'POST',headers,body:JSON.stringify({scope:{siteId:anonymous.id,versionId:anonymous.currentVersionId,entry:{kind:'main'}},body:'Private historical discussion',clientRequestId:crypto.randomUUID(),anchor:{schemaVersion:1,kind:'document',filePath:'index.html'}})});
    expect(comment.status).toBe(201);
    await rbacQuery("UPDATE site_comment_settings SET main_policy='off',reader_access=0 WHERE site_id=$1",[anonymous.id]);
    // Legacy artifacts predate the unified policy row; read the stored comment setting.
    await rbacQuery('DELETE FROM site_sharing_state WHERE site_id=$1',[anonymous.id]);
    const read=()=>fetch(`${base}/api/sites/${anonymous.slug}/comments?versionId=${anonymous.currentVersionId}`);
    expect((await read()).status).toBe(404);
    const context=await browser.createBrowserContext();
    try {
      await context.setCookie({name,value,domain:new URL(base!).hostname,path:'/',httpOnly:true});
      const page=await context.newPage();
      await page.goto(`${base}/s/${anonymous.slug}?lang=en`,{waitUntil:'networkidle2'});
      await sharing(page);
      await page.click('input[id$="-discover"]');
      await saveCustom(page);
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked',el=>(el as HTMLInputElement).value)).toBe('anyone');
      expect(await rbacQuery('SELECT main_policy,reader_access FROM site_comment_settings WHERE site_id=$1',[anonymous.id])).toMatchObject([{main_policy:'off',reader_access:0}]);
      expect((await read()).status).toBe(404);
    } finally {await context.close();}
  });

  it("revalidates cached access before saving after reopen or focus", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'anyone',comments:true}});
    let hold=false, puts=0;
    const held: HTTPRequest[] = [];
    const release = () => { hold=false;for (const request of held.splice(0)) void request.continue(); };
    const {context,page}=await ownerPage(async page=>{
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(request.url().endsWith(`/${slug}/main-sharing`)) {
          if(request.method()==='PUT') puts++;
          if(request.method()==='GET'&&hold) { held.push(request);return; }
        }
        void request.continue();
      });
    });
    try {
      await sharing(page);
      await page.click('.sharing-dialog-head button[aria-label="Close"]');
      await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});
      hold=true;
      const requested=page.waitForRequest(request=>request.url().endsWith(`/${slug}/main-sharing`)&&request.method()==='GET');
      await page.click('[data-analytics-button="share"]');
      await requested;
      expect(await page.$eval('input[id$="-comments"]',el=>(el as HTMLInputElement).disabled)).toBe(true);
      await page.click('input[id$="-comments"]');
      expect(puts).toBe(0);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'private',comments:true}});
      release();
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked',el=>(el as HTMLInputElement).value)).toBe('private');
      await page.click('input[id$="-comments"]');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'private',comments:false}});
      hold=true;
      const focused=page.waitForRequest(request=>request.url().endsWith(`/${slug}/main-sharing`)&&request.method()==='GET');
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await focused;
      expect(await page.$eval('input[id$="-comments"]',el=>(el as HTMLInputElement).disabled)).toBe(true);
      expect(puts).toBe(1);
      release();
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      // A concurrent write after revalidation is rejected by the server revision guard.
      await api('main-sharing','PUT',{action:'custom',policy:{audience:'anyone',comments:false}});
      await page.click('input[id$="-comments"]');
      await page.waitForSelector('.sharing-policy-error');
      expect(puts).toBe(2);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{audience:'anyone',comments:false}});
      await page.click('.sharing-policy-error button');
      await page.waitForSelector('.sharing-audiences input[type=radio]:not(:disabled)');
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked',el=>(el as HTMLInputElement).value)).toBe('anyone');
      expect(puts).toBe(2);
    } finally {release();await context.close();await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});}
  });

  it("keeps compact toggles and help usable with mouse, keyboard and touch", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'anyone',comments:true}});
    const {context,page}=await ownerPage();
    try {
      await sharing(page);
      for (const [width,height] of [[1280,900],[390,844],[320,568]] as const) {
        await page.setViewport({width,height,hasTouch:width<680});
        // Toggling touch emulation can reload Chromium's document.
        if (!await page.$('.sharing-dialog:modal')) await sharing(page);
        const layout=await page.$eval('.sharing-dialog',el=>{
          const toggles=Array.from(el.querySelectorAll('.sharing-option')).map(node=>node.getBoundingClientRect());
          const inputs=Array.from(el.querySelectorAll('.sharing-option input')).map(node=>node.getBoundingClientRect());
          return {fits:el.scrollWidth<=el.clientWidth,height:el.getBoundingClientRect().height,
            separateRows:toggles[1].top>=toggles[0].bottom,smallSwitches:inputs.every(rect=>rect.width<=32&&rect.height<=20)};
        });
        expect(layout.fits).toBe(true);
        expect(layout.smallSwitches).toBe(true);
        expect(layout.height).toBeLessThanOrEqual(height);
        expect(layout.separateRows).toBe(true);
        const help='.sharing-links-help .sharing-help-trigger';
        await page.focus(help);
        await page.waitForSelector('.sharing-help-popover:popover-open');
        expect(await page.$eval('.sharing-help-popover:popover-open',el=>el.textContent)).toContain('Comments are separate for each link');
        const bounds=await page.$eval('.sharing-help-popover:popover-open',el=>{
          const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;
        });
        expect(bounds).toBe(true);
        await page.keyboard.press('Escape');
        expect(await page.$('.sharing-help-popover:popover-open')).toBeNull();
        expect(await page.$('.sharing-dialog:modal')).not.toBeNull();
        if(width<680) {
          const button=await page.$eval(help,el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};});
          expect(button.width).toBeGreaterThanOrEqual(44);
          expect(button.height).toBeGreaterThanOrEqual(44);
          await page.touchscreen.tap(button.x,button.y);
        } else await page.click(help);
        await page.waitForSelector('.sharing-help-popover:popover-open');
        await page.click('.sharing-dialog h2');
        expect(await page.$('.sharing-help-popover:popover-open')).toBeNull();
        await page.hover(help);
        await page.waitForSelector('.sharing-help-popover:popover-open');
        await page.hover('.sharing-dialog h2');
        await page.waitForSelector('.sharing-help-popover:popover-open',{hidden:true});
      }
    } finally {await context.close();}
  });

  it("aligns default and saved sharing controls without moving them when success appears", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});
    const {context,page}=await ownerPage();
    await mkdir('.impeccable/review',{recursive:true});
    const measure=()=>page.$eval('.sharing-dialog',el=>{
      const rect=(selector:string)=>el.querySelector(selector)!.getBoundingClientRect();
      const lefts=['.sharing-audiences legend','.sharing-audience-card','.sharing-toggle-row','.sharing-links-entry'].map(selector=>rect(selector).left);
      const rights=['.sharing-audience-card','.sharing-copy-button'].map(selector=>rect(selector).right);
      return {leftSpread:Math.max(...lefts)-Math.min(...lefts),rightSpread:Math.max(...rights)-Math.min(...rights),
        selectTop:rect('.sharing-audience-card').top,copyTop:rect('.sharing-copy-button').top,height:el.getBoundingClientRect().height};
    });
    try {
      for(const [width,height] of [[1280,900],[768,900],[390,844],[320,568]] as const) {
        await page.setViewport({width,height});
        await sharing(page);
        // Expanded cards scroll on short screens; compare feedback after reaching the control.
        await page.$eval('input[id$="-comments"]', el => el.scrollIntoView({ block: 'nearest' }));
        const before=await measure();
        expect(before.leftSpread).toBeLessThan(1);
        expect(before.rightSpread).toBeLessThan(1);
        expect(await page.$eval('.sharing-status',el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
        await page.screenshot({path:`.impeccable/review/aligned-default-${width}.png`});
        await page.click('input[id$="-comments"]');
        await saveCustom(page);
        expect(await measure()).toEqual(before);
        const feedback=await page.$eval('.sharing-status',el=>{
          const bar=el.getBoundingClientRect(),field=document.querySelector('.sharing-audience-card')!.getBoundingClientRect();
          const area=document.querySelector('.sharing-configuration')!;
          return {left:Math.abs(bar.left-field.left),right:Math.abs(bar.right-field.right),height:bar.height,
            shaded:getComputedStyle(el).backgroundColor!=='rgba(0, 0, 0, 0)',fullAreaShaded:getComputedStyle(area,'::before').content!=='none'};
        });
        expect(feedback.left).toBeLessThan(1);
        expect(feedback.right).toBeLessThan(1);
        expect(feedback.height).toBeLessThanOrEqual(36);
        expect(feedback.shaded).toBe(true);
        expect(feedback.fullAreaShaded).toBe(false);
        await page.screenshot({path:`.impeccable/review/aligned-updated-${width}.png`});
        await page.click('.sharing-dialog-head button[aria-label="Close"]');
        await page.waitForSelector('.sharing-dialog',{hidden:true});
      }
    } finally {await context.close();await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});}
  });

  it("captures the approved compact style with success feedback and both link entry points", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});
    const link = await (await api('shares','POST',{policy:'login',label:'Review link'})).json();
    const {context,page} = await ownerPage();
    await mkdir('.impeccable/review',{recursive:true});
    try {
      await page.goto(`${base}/s/${slug}?lang=zh-CN`,{waitUntil:'networkidle2'});
      await sharing(page);
      expect(await page.$eval('.sharing-configuration',el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      expect(await page.$eval('.sharing-audiences input[type=radio]:checked',el=>el.closest('label')?.querySelector('.sharing-audience-title')?.textContent)).toBe('私有');
      await chooseAudience(page, 'tenant');
      await page.waitForFunction(()=>document.querySelector('.sharing-status')?.textContent==='分享配置已经更新');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      for (const [width,height,name] of [[1440,1000,'desktop'],[390,844,'mobile'],[320,568,'narrow']] as const) {
        await page.setViewport({width,height});
        const layout = await page.$eval('.sharing-dialog',el=>{
          const button=el.querySelector('.sharing-copy-button')!.getBoundingClientRect();
          return {fits:el.scrollWidth<=el.clientWidth,copyVisible:button.top>=0&&button.bottom<=innerHeight};
        });
        expect(layout).toEqual({fits:true,copyVisible:true});
        expect(await page.$('input[id$="-discover"]')).toBeNull();
        expect(await page.$eval('.sharing-status',el=>el.textContent)).toBe('分享配置已经更新');
        expect(await page.$('.sharing-copy .sharing-status')).toBeNull();
        expect(await page.$eval('.sharing-configuration',el=>{
          const status=el.querySelector('.sharing-status')!.getBoundingClientRect();
          const area=el.getBoundingClientRect();
          return getComputedStyle(el.querySelector('.sharing-status')!).backgroundColor!=='rgba(0, 0, 0, 0)'&&status.top>=area.top&&status.bottom<=area.bottom;
        })).toBe(true);
        await page.screenshot({path:`.impeccable/review/${name}.png`});
        await page.click('button[aria-label="更多分享选项"]');
        await page.waitForSelector('.sharing-more-menu');
        expect(await page.$eval('.sharing-more-menu',el=>el.textContent)).toContain('独立分享链接 (1)');
        expect(await page.$eval('.sharing-links-entry',el=>el.textContent)).toContain('独立分享链接');
        await page.screenshot({path:`.impeccable/review/${name}-more.png`});
        await page.keyboard.press('Escape');
        expect(await page.$('.sharing-dialog:modal')).not.toBeNull();
      }
    } finally { await context.close(); await api(`shares/${link.share.id}`,'DELETE'); await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}}); }
  });

  it("retries a failed automatic comment change while retaining the last saved policy", async () => {
    await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});
    let attempts=0;
    const {context,page}=await ownerPage(async page=>{
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(request.method()==='PUT' && request.url().endsWith(`/${slug}/main-sharing`) && attempts++===0)
          void request.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary update failure'})});
        else void request.continue();
      });
    });
    try {
      await sharing(page);
      await page.click('input[id$="-comments"]');
      await page.waitForSelector('.sharing-policy-error');
      expect(await page.$('.sharing-confirmation')).toBeNull();
      expect(await page.$eval('input[id$="-comments"]',el=>(el as HTMLInputElement).checked)).toBe(true);
      expect(await page.$eval('.sharing-status',el=>el.textContent)).toBe('');
      expect(await page.$eval('.sharing-configuration',el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{comments:true}});
      await page.click('.sharing-policy-error button');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({policy:{comments:false}});
      expect(attempts).toBe(2);
    } finally {await context.close();await api('main-sharing','PUT',{action:'custom',policy:{audience:'private',comments:true}});}
  });

  it("explains all-sites inheritance in title help and saves individual changes directly", async () => {
    async function scope(enabled: boolean) {
      const body = { folderId: null, enabled, policy: { audience: "tenant", comments: true } };
      const request = (payload: unknown) => fetch(`${base}/api/me/sharing/scopes`, { method: "POST", headers, body: JSON.stringify(payload) });
      const preview = await request(body);
      expect(preview.status).toBe(200);
      expect((await request({ ...body, confirmation: (await preview.json()).confirmation })).status).toBe(200);
    }
    await scope(true);
    const { context, page } = await ownerPage();
    try {
      await sharing(page);
      expect(await page.$('.sharing-inheritance')).toBeNull();
      const help = '.sharing-dialog-head [aria-label="About Share artifact"]';
      await page.focus(help);
      await page.waitForSelector('.sharing-help-popover:popover-open');
      expect(await page.$eval('.sharing-help-popover:popover-open', el => el.textContent)).toContain("creator's all-sites sharing settings");
      await page.keyboard.press('Escape');
      expect(await page.$('.sharing-dialog:modal')).not.toBeNull();
      await page.click('input[id$="-comments"]');
      await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      expect(await page.$('.sharing-confirmation')).toBeNull();
      expect(await page.$(help)).toBeNull();
      expect(await (await api('main-sharing')).json()).toMatchObject({ source: 'manual', policy: { audience: 'tenant', comments: false } });
      await more(page);
      await page.locator('::-p-text(Restore shared settings)').click();
      await page.waitForSelector('.sharing-confirmation:modal');
      await saveCustom(page);
      expect(await (await api('main-sharing')).json()).toMatchObject({ source: 'all', policy: { audience: 'tenant', comments: true } });
      await page.setViewport({ width: 320, height: 568 });
      await page.locator(help).click();
      await page.waitForSelector('.sharing-help-popover:popover-open');
      expect(await page.$eval('.sharing-help-popover:popover-open', el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      })).toBe(true);
      await page.screenshot({ path: 'test-results/sharing-title-help-mobile.png' });
      await page.keyboard.press('Escape');
      await chooseAudience(page, 'login');
      await page.waitForFunction(() => document.querySelector('.sharing-status')?.textContent === 'Sharing settings updated');
      await page.waitForSelector('.sharing-copy-button:not([disabled])');
      expect(await page.$('.sharing-confirmation')).toBeNull();
      expect(await (await api('main-sharing')).json()).toMatchObject({ source: 'manual', policy: { audience: 'login' } });
      await page.goto(`${base}/s/${slug}?lang=zh-CN`, { waitUntil: 'networkidle2' });
      await sharing(page);
      await chooseAudience(page, 'anyone');
      await page.waitForSelector('.sharing-access-confirmation:modal');
      for (const [width, height] of [[1280, 900], [390, 844], [320, 568]] as const) {
        await page.setViewport({ width, height });
        expect(await page.$eval('.sharing-access-confirmation', el => {
          const dialog = el.getBoundingClientRect(), button = el.querySelector('button[type="submit"]')!.getBoundingClientRect();
          return el.scrollWidth <= el.clientWidth && dialog.top >= 0 && button.bottom <= innerHeight;
        })).toBe(true);
        await page.screenshot({ path: `test-results/sharing-compact-alert-zh-${width}.png` });
      }
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sharing-access-confirmation', { hidden: true });
      expect(await (await api('main-sharing')).json()).toMatchObject({ policy: { audience: 'login' } });
    } finally { await context.close(); await scope(false); await api('main-sharing', 'PUT', { action: 'custom', policy: { audience: 'private', comments: true } }); }
  });

});
