import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { createId, upsertUser, closeDbForTests, rbacQuery } from "@/lib/db";
import { createSite, replaceSiteContent } from "@/lib/sites";
import { createComment, replyComment } from "@/lib/comments/service";
import { mintSession } from "@/lib/session";
import type { Site } from "@/lib/types";

const url = process.env.COMMENTS_E2E_URL;
describe.skipIf(!url)("comment pagination and draft browser acceptance", () => {
  let browser: Browser, page: Page, site: Site, threadId: string;
  beforeAll(async () => {
    process.env.ARTIFACT_DATA_DIR = resolve(process.env.COMMENTS_E2E_DATA || ".data/comment-browser");
    process.env.ARTIFACT_PUBLIC_URL = url!;
    process.env.ARTIFACT_CREATE_POLICY = "open";
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
    const user = await upsertUser({ authProvider: "browser", providerSubject: createId("subject"), email: "pagination@example.test", displayName: "Pagination Reviewer", emailVerified: true });
    const { cookie } = await mintSession(new Request(url!), user.id);
    site = (await createSite({ mode: "file", title: "Pagination acceptance", filename: "index.html", bytes: new TextEncoder().encode("<!doctype html><h1>Immutable review</h1>") }, { ownerId: user.id })).site;
    const replacement = await replaceSiteContent(site.slug, { mode: "file", filename: "index.html", bytes: new TextEncoder().encode("<!doctype html><h1>Second review version</h1>") }, { actor: { kind: "user", userId: user.id, anonId: null }, method: "api", ip: null, userAgent: null });
    if (replacement && "site" in replacement) site = replacement.site;
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const pair = cookie.split(";")[0]; const split = pair.indexOf("=");
    await browser.defaultBrowserContext().setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(url!).hostname, path: "/" });
    page = await browser.newPage();
    page.setDefaultTimeout(Number(process.env.COMMENTS_E2E_TIMEOUT || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.COMMENTS_E2E_TIMEOUT || 30000));
    await page.evaluateOnNewDocument(() => { if (window.top === window && location.protocol.startsWith("http")) localStorage.setItem("artifact-comment-rail-collapsed", "false"); });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    await page.goto(`${url}/s/${site.slug}`);
    const previousRateLimit = process.env.ARTIFACT_RATE_LIMIT;
    process.env.ARTIFACT_RATE_LIMIT = "off";
    try {
    const request = new Request(`${url}/api/sites/${site.slug}/comments`, { method: "POST", headers: { cookie: cookie.split(";")[0], origin: url! } });
    for (let index = 0; index < 31; index++) {
      const detail = await createComment(request, site.slug, { scope: { siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" } }, clientRequestId: crypto.randomUUID(), anchor: { schemaVersion: 1, kind: "document", filePath: "index.html" }, body: `Thread ${index}` });
      threadId = detail.detail.thread.id;
      await rbacQuery("UPDATE comment_threads SET created_at=$1 WHERE id=$2", [Date.now() - 60000 + index * 1000, threadId]);
    }
    for (let index = 0; index < 31; index++) await replyComment(request, site.slug, threadId, { clientRequestId: crypto.randomUUID(), body: `Reply ${index}` });
    } finally { if (previousRateLimit === undefined) delete process.env.ARTIFACT_RATE_LIMIT; else process.env.ARTIFACT_RATE_LIMIT = previousRateLimit; }
  }, 60000);
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  async function click(text: string) {
    await page.waitForFunction(text => [...document.querySelectorAll("button")].some(b => b.textContent?.trim() === text && !b.disabled), {}, text);
    await page.evaluate(text => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text && !b.disabled)!.click(), text);
  }
  it("keeps loaded threads, replies and list position after quiet refresh", async () => {
    await page.reload(); await page.waitForSelector('button[aria-label="Comments"]'); await page.click('button[aria-label="Comments"]');
    await page.click('button[aria-label="Filters"]');
    await page.waitForSelector(".comment-filter-drawer select");
    await page.select('.comment-filter-drawer select', "open");
    await click("Load more comments");
    await page.waitForFunction(() => document.querySelectorAll(".comment-summary").length === 31);
    await page.$eval(".comment-panel-content",el=>{el.scrollTop=300;});
    const scroll=await page.$eval(".comment-panel-content",el=>el.scrollTop);
    await page.evaluate(()=>[...document.querySelectorAll<HTMLButtonElement>(".comment-summary")].find(el=>el.textContent?.includes("Thread 30"))!.click());
    await click("Load more replies");
    await page.waitForFunction(() => document.querySelectorAll(".comment-body").length === 32);
    // The resolved detail stays readable even after the open-only list excludes it.
    expect(await page.$(".comment-error")).toBeNull();
    await click("End discussion");
    await page.waitForSelector(".comment-resolved");
    await page.waitForFunction(() => document.querySelectorAll(".comment-body").length === 32);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await new Promise(resolve=>setTimeout(resolve,11000));
    expect(await page.$$(".comment-body")).toHaveLength(32);
    await click("All comments");
    await page.waitForFunction(()=>document.querySelectorAll(".comment-summary").length===30);
    await page.waitForFunction(scroll=>document.querySelector(".comment-panel-content")?.scrollTop===scroll,{},scroll);
    expect(await page.$$(".comment-summary")).toHaveLength(30);
  });
  it("keeps readable discussions after an unavailable initial thread", async () => {
    await page.goto(`${url}/s/${site.slug}#comment=missing-thread`); await page.reload();
    await page.waitForSelector('button[aria-label="Comments"]'); await page.click('button[aria-label="Comments"]');
    await page.waitForSelector(".comment-summary");
    expect(await page.$('button[aria-label="Add comment"]')).not.toBeNull();
  });
  it("honors server ordering and retains displaced rows on quiet refresh", async () => {
    await page.goto(`${url}/s/${site.slug}?comments=all`);
    await page.waitForSelector(".comment-summary");
    await page.click('button[aria-label="Filters"]');
    await page.waitForSelector(".comment-filter-drawer select");
    await page.evaluate(() => {
      const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find(s => [...s.options].some(o => o.value === "oldest"))!;
      select.value = "oldest"; select.dispatchEvent(new Event("change", {bubbles:true}));
    });
    await page.waitForFunction(() => document.querySelector(".comment-summary-body")?.textContent === "Thread 0");
    await click("Load more comments");
    await page.waitForFunction(() => document.querySelectorAll(".comment-summary").length === 31);
    expect(await page.$$eval(".comment-summary-body", els => els.map(e => e.textContent))).toEqual(Array.from({length:31}, (_,i)=>`Thread ${i}`));
    await page.evaluate(() => {
      const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find(s => [...s.options].some(o => o.value === "newest"))!;
      select.value = "newest"; select.dispatchEvent(new Event("change", {bubbles:true}));
    });
    await page.waitForFunction(() => document.querySelector(".comment-summary-body")?.textContent === "Thread 30");
    const before = await page.$$eval(".comment-summary-body", els=>els.map(e=>e.textContent));
    await page.evaluate(async site => {
      const r=await fetch(`/api/sites/${site.slug}/comments`, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({scope:{siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main"}},clientRequestId:crypto.randomUUID(),anchor:{schemaVersion:1,kind:"document",filePath:"index.html"},body:"New arrival"})});
      if(!r.ok)throw Error(await r.text());
    },site);
    let detailChecks = 0;
    await page.setRequestInterception(true);
    const intercept = (request: import("puppeteer-core").HTTPRequest) => {
      const path = new URL(request.url()).pathname;
      if (new RegExp(`/comments/(?!aggregate$|permissions$|settings$|options$)[^/]+$`).test(path)) {
        detailChecks++;
        if (detailChecks === 1) { void request.respond({status:503,contentType:"application/json",body:JSON.stringify({error:"Temporary failure"})}); return; }
      }
      void request.continue();
    };
    page.on("request",intercept);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(()=>document.querySelector(".comment-updates")!==null);
    expect(await page.$(".comment-error")).toBeNull();
    await Promise.all([page.waitForResponse(r=>r.url().includes(`/comments/`) && new URL(r.url()).pathname.endsWith("/aggregate") && r.ok()),page.evaluate(()=>window.dispatchEvent(new Event("focus")))]);
    await page.waitForFunction(()=>!document.querySelector(".comment-error"));
    // Once a displaced row has been verified, repeated focus events do not refetch it.
    await page.waitForNetworkIdle({idleTime:50});
    const verified = detailChecks;
    await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname.endsWith("/aggregate") && r.ok()),page.evaluate(()=>window.dispatchEvent(new Event("focus")))]);
    await page.waitForNetworkIdle({idleTime:50});
    expect(detailChecks).toBe(verified);
    page.off("request",intercept);await page.setRequestInterception(false);
    expect(await page.$$eval(".comment-summary-body", els=>els.map(e=>e.textContent))).toEqual(before);
    await page.click('.comment-header-actions button[aria-label="Refresh comments"]');
    await page.waitForFunction(()=>document.querySelector(".comment-summary-body")?.textContent==="New arrival");
  });
  it("keeps automatic refresh quiet, permits explicit retry, and protects rollback drafts", async () => {
    await page.evaluateOnNewDocument(() => {
      class Feed extends EventTarget {
        static CLOSED = 2; readyState = 1; onerror = null;
        constructor() { super(); Object.assign(window, { testVersionFeed: this }); }
        close() { this.readyState = 2; }
      }
      Object.assign(window, { EventSource: Feed });
    });
    await page.goto(`${url}/s/${site.slug}#comment=${threadId}`); await page.reload();
    // This case exercises refresh/rollback after navigation, so finish the initial deep link
    // and iframe load before starting selection (a load resets the preview channel).
    await page.waitForSelector(".comment-conversation");
    await page.waitForFunction(() => {
      const frame = document.querySelector("iframe.fs-frame");
      return !!frame && (window as Window & { __artifactPreviewLoads?: WeakSet<EventTarget> }).__artifactPreviewLoads?.has(frame);
    });
    await page.waitForSelector('button[aria-label="Add comment"]'); await page.click('button[aria-label="Add comment"]');
    // PR2 offers anchored selection; the basic workspace opens the composer directly.
    await page.waitForFunction(() => document.querySelector(".comment-selection") || document.querySelector(".comment-composer"));
    if (await page.$(".comment-selection")) await click("Whole file");
    await page.type('textarea[aria-label="Comment"]', "Keep my draft");
    let prompts = 0; const dismiss = async (dialog: import("puppeteer-core").Dialog) => { prompts++; await dialog.dismiss(); }; page.on("dialog", dismiss);
    const before = await page.$("iframe.fs-frame");
    await page.evaluate(() => {
      const feed = (window as unknown as { testVersionFeed: EventTarget }).testVersionFeed;
      feed.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ versionId: "next-snapshot", versionNumber: 3 }) }));
      feed.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ versionId: "next-snapshot", versionNumber: 3 }) }));
    });
    expect(prompts).toBe(0);
    // Closing a composer saves it; it must not release the automatic refresh.
    await page.click('button[aria-label="Close composer"]');
    expect(await before!.evaluate(node => node.isConnected)).toBe(true);
    await click("Refresh to view");
    await page.waitForFunction(node => !node.isConnected, {}, before!);
    expect(prompts).toBe(0);
    await page.click('button[aria-label="Add comment"]');
    await page.waitForFunction(()=>document.querySelector(".comment-selection") || document.querySelector("textarea")); if(await page.$(".comment-selection"))await click("Whole file");
    await page.waitForSelector("textarea");
    expect(await page.$eval("textarea", el => (el as HTMLTextAreaElement).value)).toBe("Keep my draft");
    page.off("dialog", dismiss);
    let rollbackPosts = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/rollback")) rollbackPosts++; });
    const confirmRollback = async (dialog: import("puppeteer-core").Dialog) => { if (dialog.message().includes("Discard")) await dialog.dismiss(); else await dialog.accept(); };
    page.on("dialog", confirmRollback);
    await page.mouse.move(700, 10);
    await page.click('button[aria-label="More"]'); await click("Version history");
    const snapshot = await page.$eval("iframe.fs-frame", el => new URL((el as HTMLIFrameElement).src).searchParams.get("v"));
    let officialPrompts = 0;
    const officialDialog = async (dialog: import("puppeteer-core").Dialog) => { officialPrompts++; await dialog.dismiss(); };
    page.off("dialog", confirmRollback); page.on("dialog", officialDialog);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".ver-row:not(.is-current) button")].some(button => button.textContent?.trim() === "Set as official version" && !button.disabled));
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ver-row:not(.is-current) button")].find(button => button.textContent?.trim() === "Set as official version")!.click());
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Remove official designation"));
    expect(officialPrompts).toBe(0);
    expect(await page.$eval("iframe.fs-frame", el => new URL((el as HTMLIFrameElement).src).searchParams.get("v"))).toBe(snapshot);
    expect(await page.$eval('textarea[aria-label="Comment"]', el => (el as HTMLTextAreaElement).value)).toBe("Keep my draft");
    page.off("dialog", officialDialog); page.on("dialog", confirmRollback);
    await click("Roll back to this version");
    await page.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/rollback") && r.ok());
    expect(rollbackPosts).toBe(1);
    page.off("dialog", confirmRollback);
    await page.waitForSelector(".comment-draft-recovery summary");await page.click(".comment-draft-recovery summary");
    await page.click(".comment-draft-recovery a"); await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Keep my draft");
    // Discarding the saved draft releases the deferred refresh without another confirmation.
    await click("Discard draft");
    expect(prompts).toBe(0);
  });
});
