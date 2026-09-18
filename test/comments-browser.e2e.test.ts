import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Browser, Page } from "puppeteer-core";
import { createId, upsertUser, createShare, closeDbForTests } from "@/lib/db";
import { createSite, replaceSiteContent } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { testAudit } from "./helpers";
import { hashToken } from "@/lib/share";
import { buildCommentPdf } from "./fixtures/comment-pdf";
import { zipSync, strToU8 } from "fflate";
import type { Site } from "@/lib/types";

// Production server + real Postgres (start the isolated server with ARTIFACT_RATE_LIMIT_BURST=200). Share the server's isolated directory via COMMENTS_E2E_DATA.
// COMMENTS_E2E_URL=http://127.0.0.1:4392 COMMENTS_E2E_DATA=.data/comment-browser ARTIFACT_DB_DRIVER=postgres ARTIFACT_DATABASE_URL=... npx vitest run test/comments-browser.e2e.test.ts
const url = process.env.COMMENTS_E2E_URL;
function previewVersion(value: string) {
  const query = new URL(value, "http://preview.invalid").searchParams;
  return query.get("__artifact_version") ?? query.get("v");
}
describe.skipIf(!url)("real comment UI with the production API", () => {
  let browser: Browser, page: Page, html: Site, pdf: Site, office: Site, slow: Site, shareToken: string, ownerId: string, ownerCookie: string;
  const errors: string[] = [];
  beforeAll(async () => {
    process.env.ARTIFACT_DATA_DIR = resolve(process.env.COMMENTS_E2E_DATA || ".data/comment-browser");
    process.env.ARTIFACT_PUBLIC_URL = url!;
    process.env.ARTIFACT_CREATE_POLICY = "open";
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
    const user = await upsertUser({ authProvider: "browser", providerSubject: createId("subject"), email: "browser@example.test", displayName: "Browser Reviewer", emailVerified: true });
    const { cookie } = await mintSession(new Request(url!), user.id);
    ownerCookie = cookie;
    ownerId = user.id;
    const owner = { ownerId: user.id };
    html = (await createSite({ mode: "folder", title: "Comment interaction acceptance", files: [
      { relpath: "index.html", bytes: strToU8('<!doctype html><html><head><title>Review fixture</title></head><body style="font:18px system-ui;margin:48px;background:#fafbf7"><h1 id="headline">Quarterly artifact review</h1><p>Discuss the original evidence here.</p><img src="chart.svg" style="width:500px;height:300px;object-fit:contain"><div style="height:1000px"></div><a href="other.html">Second page</a></body></html>') },
      { relpath: "other.html", bytes: strToU8('<html><body><h1>Second page</h1><a href="index.html">Back</a></body></html>') },
      { relpath: "heavy.html", bytes: strToU8('<html><head><script src="slow.js"></script></head><body><h1>Heavy page heading</h1><img src="slow.svg"></body></html>') },
      { relpath: "slow.js", bytes: strToU8("window.slowScriptLoaded = true;") },
      { relpath: "slow.svg", bytes: strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>') },
      { relpath: ".docs/page.html", bytes: strToU8('<html><body><h1>Dot folder</h1><img src=".assets/chart.svg" width="300" height="200"></body></html>') },
      { relpath: ".assets/chart.svg", bytes: strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="green"/></svg>') },
      { relpath: "chart.svg", bytes: strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="250"><rect width="500" height="250" fill="#edf2e5"/><rect x="80" y="130" width="80" height="120" fill="#5b7646"/><rect x="210" y="70" width="80" height="180" fill="#5b7646"/><rect x="340" y="20" width="80" height="230" fill="#5b7646"/></svg>') },
    ] }, owner)).site;
    slow = (await createSite({ mode: "file", filename: "late.html", bytes: strToU8('<html><body><h1>Late original heading</h1></body></html>') }, owner)).site;
    pdf = (await createSite({ mode: "file", title: "PDF comment acceptance", filename: "report.pdf", bytes: buildCommentPdf(2) }, owner)).site;
    office = (await createSite({ mode: "file", filename: "fallback.docx", bytes: zipSync({ "[Content_Types].xml": strToU8('<Types/>'), "word/document.xml": strToU8('<document>Fallback</document>') }) }, owner)).site;
    shareToken = createId("share");
    await createShare({ id: createId("shr"), siteId: html.id, tokenHash: hashToken(shareToken), policy: "public", mode: "comment", passcodeHash: null, label: "Browser review", createdBy: user.id, createdAnonId: null, expiresAt: null, versionId: null });
    await writeFile("/tmp/comment-anchored-browser-fixture.json", JSON.stringify({ html: html.slug, pdf: pdf.slug, office: office.slug, cookie }), { mode: 0o600 });
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const split = cookie.split(";")[0].indexOf("=");
    await browser.defaultBrowserContext().setCookie({ name: cookie.slice(0, split), value: cookie.split(";")[0].slice(split + 1), domain: new URL(url!).hostname, path: "/" });
    await mkdir(resolve("output/acceptance"), { recursive: true });
    page = await browser.newPage();
    page.setDefaultTimeout(Number(process.env.COMMENTS_E2E_TIMEOUT || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.COMMENTS_E2E_TIMEOUT || 30000));
    await page.evaluateOnNewDocument(() => {
      // Only the host owns this preference; avoid opaque sandbox and about:blank storage.
      if (window === window.top && location.protocol.startsWith("http")) localStorage.setItem("artifact-comment-rail-collapsed", "false");
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    page.on("pageerror", error => errors.push(String(error)));
    page.on("dialog", dialog => void dialog.accept());
  }, 30000);
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  afterEach(async ({task}) => {
    if(task.result?.state!=="fail" || !page || page.isClosed()) return;
    await page.screenshot({path:resolve("output/acceptance/comment-failure.png")}).catch(()=>{});
    console.error("Comment UI failure state",await page.evaluate(()=>({path:location.pathname.startsWith("/v/")?"/v/[redacted]":location.pathname,viewport:innerWidth,text:document.body.innerText.slice(0,2000),frames:[...document.querySelectorAll("iframe")].map(frame=>new URL(frame.src,location.href).pathname)})).catch(()=>null));
  });
  it("groups refresh controls and places expanded filters above read tabs", async () => {
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${url}/s/${html.slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('.comment-rail button[aria-label="Comments"]');
      await page.click('.comment-rail button[aria-label="Comments"]');
      await page.waitForSelector('.comment-header-actions button[aria-label="Refresh comments"]');
      expect(await page.$eval('.comment-header-actions button[aria-label="Refresh comments"]', el => el.textContent)).toBe("");
      await page.waitForSelector('.comment-rail button[aria-label="Show comment markers"], .comment-rail button[aria-label="Hide comment markers"]');
      // The narrow-screen sheet hides the entire rail; its header owns the visible toggle.
      const toggle = width >= 900 ? ".comment-rail" : ".comment-header-actions";
      await page.click(`${toggle} button[aria-label="Show comment markers"], ${toggle} button[aria-label="Hide comment markers"]`);
      expect(await page.$eval('.comment-rail button[aria-pressed][aria-label$="comment markers"]', el => el.getAttribute("aria-pressed")))
        .toBe(await page.$eval('.comment-header-actions button[aria-pressed]', el => el.getAttribute("aria-pressed")));
      await page.click('button[aria-label="Filters"]');
      const bounds = await page.evaluate(() => {
        const bottom = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().bottom;
        const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
        return { toolbar: bottom(".comment-toolbar"), filtersTop: top(".comment-filter-drawer"), filtersBottom: bottom(".comment-filter-drawer"), tabs: top(".comment-tabs") };
      });
      expect(bounds.filtersTop).toBeGreaterThanOrEqual(bounds.toolbar);
      expect(bounds.filtersBottom).toBeLessThanOrEqual(bounds.tabs);
      await page.waitForFunction(() => !(document.querySelector('.comment-header-actions button[aria-label="Refresh comments"]') as HTMLButtonElement)?.disabled);
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/permissions") && response.ok()),
        page.click('.comment-header-actions button[aria-label="Refresh comments"]'),
      ]);
      await page.waitForFunction(() => !(document.querySelector('.comment-header-actions button[aria-label="Refresh comments"]') as HTMLButtonElement)?.disabled);
      expect(await page.$(".comment-error")).toBeNull();
      await page.screenshot({ path: resolve(`output/acceptance/comment-controls-${width}.png`) });
    }
    await page.setViewport({ width: 1440, height: 1000 });
  });
  async function click(text: string) {
    await page.waitForFunction(text => Array.from(document.querySelectorAll("button")).some(b => b.textContent?.trim() === text && !b.disabled), {}, text);
    await page.evaluate(text => (Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === text && !b.disabled) as HTMLButtonElement).click(), text);
  }
  async function chooseThread(text: string) {
    if (await page.$(".comment-conversation")) await click("All comments");
    await page.waitForFunction(text=>Array.from(document.querySelectorAll(".comment-summary")).some(el=>el.textContent?.includes(text)),{},text);
    await page.evaluate(text=>(Array.from(document.querySelectorAll(".comment-summary")).find(el=>el.textContent?.includes(text)) as HTMLButtonElement).click(),text);
    await page.waitForSelector(".comment-conversation");
  }
  async function begin(path: string) {
    await page.goto(url! + path); await page.waitForSelector('button[aria-label="Add comment"]');
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow !== null);
    // The iframe bridge initializes asynchronously; wait for its acknowledged marker layer.
    const frame = page.frames().find(f => f.url().includes("/api/preview/"))!;
    await frame.waitForSelector("[data-artifact-comment-overlay]");
    await page.click('button[aria-label="Add comment"]');
    await page.waitForSelector(".comment-selection");
    return frame;
  }
  async function settle() {
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
  }
  async function submit(body: string) {
    await page.waitForSelector('textarea[aria-label="Comment"]'); await page.type('textarea[aria-label="Comment"]', body); await click("Send");
    await page.waitForFunction(body => Array.from(document.querySelectorAll(".comment-body")).some(el => el.textContent === body), {}, body);
    await page.waitForFunction(() => !document.querySelector(".comment-composer"));
  }
  it("creates HTML and image anchors through the shared sandbox and opens original context", async () => {
    let frame = await begin(`/v/${shareToken}`);
    await frame.evaluate(() => { (window as unknown as { fixtureState: string }).fixtureState = "preserved"; });
    await frame.click("#headline", { offset: { x: 20, y: 20 } }); await submit("Clarify this heading");
    expect(await frame.evaluate(() => (window as unknown as { fixtureState: string }).fixtureState)).toBe("preserved");
    expect(await page.$eval('.comment-header-actions button[aria-label="Show comment markers"]',el=>el.getAttribute("aria-pressed"))).toBe("false");
    await page.click(".comment-overflow summary");
    await page.click(".comment-original-context summary");
    expect(await page.$eval(".comment-original-context", el => el.textContent)).toContain("Quarterly artifact review");
    await page.click('button[aria-label="Add comment"]');
    frame = page.frames().find(f => f.url().includes("/api/preview/"))!;
    await frame.waitForFunction(()=>document.documentElement.dataset.artifactCommentSelect === "true");
    const img = (await (await frame.$("img"))!.boundingBox())!;
    await page.mouse.move(img.x + 60, img.y + 90); await page.mouse.down(); await page.mouse.move(img.x + 220, img.y + 180, { steps: 4 }); await page.mouse.up();
    await submit("Explain this chart region");
    await mkdir(resolve("output/acceptance"), { recursive: true });
    await settle(); await page.screenshot({ path: resolve("output/acceptance/comments-shared.png") });
    await page.goto(url! + `/v/${shareToken}`);
    await page.waitForSelector('button[aria-label="Show comment markers"]');
    await page.click('button[aria-label="Show comment markers"]');
    frame = page.frames().find(f => f.url().includes("/api/preview/"))!;
    await frame.waitForSelector("[data-artifact-comment-overlay] button");
    expect(await page.$(".comment-panel")).toBeNull();
    expect(errors).toEqual([]);
  });
  it("shows share feedback to the owner on main and refreshes empty views quietly", async () => {
    await page.goto(url! + `/s/${html.slug}`);
    await page.waitForSelector('button[aria-label="Comments"]');
    await page.click('button[aria-label="Comments"]');
    await page.waitForFunction(() => document.querySelector(".comment-panel")?.textContent?.includes("Clarify this heading"));
    expect(await page.$eval(".comment-source-filter select", el => (el as HTMLSelectElement).value)).toBe("all");
    await page.select(".comment-source-filter select", "main");
    await page.waitForSelector(".comment-empty");
    let held: import("puppeteer-core").HTTPRequest | undefined;
    await page.setRequestInterception(true);
    const intercept = (request: import("puppeteer-core").HTTPRequest) => {
      if (request.url().includes("/comments/permissions")) held = request;
      else void request.continue();
    };
    page.on("request", intercept);
    try {
      const started = page.waitForRequest(request => request.url().includes("/comments/permissions"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await started;
      expect(await page.$(".comment-loading")).toBeNull();
      expect(await page.$(".comment-empty")).not.toBeNull();
      await held!.continue(); held = undefined;
    } finally {
      if (held && !held.isInterceptResolutionHandled()) await held.continue();
      page.off("request", intercept); await page.setRequestInterception(false);
    }
    await page.select(".comment-source-filter select", "all");
    await page.waitForFunction(() => document.querySelector(".comment-panel")?.textContent?.includes("Clarify this heading"));
    await chooseThread("Clarify this heading"); await click("Reply");
    await page.waitForSelector("textarea");await page.type("textarea","Owner reply from main viewer");
    await page.evaluate(()=>history.replaceState(null,"",location.pathname));await page.reload();await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Owner reply from main viewer");
    await click("Send");await page.waitForFunction(()=>!document.querySelector(".comment-composer"));
    await settle(); await page.screenshot({ path: resolve("output/acceptance/comments-owner-overview.png") });
    await page.goto(url! + `/v/${shareToken}`);
    await page.waitForSelector('button[aria-label="Comments"]'); await page.click('button[aria-label="Comments"]');
    await chooseThread("Clarify this heading");
    await page.waitForFunction(() => document.querySelector(".comment-panel")?.textContent?.includes("Owner reply from main viewer"));
    expect(await page.$(".comment-source-filter")).toBeNull();
    expect(await page.$eval(".comment-conversation-toolbar", el => el.textContent)).toContain("Shared discussion");
  });
  it("keeps anonymous share pin clicks and deep links working after polling", async () => {
    const site=(await createSite({mode:"paste",html:'<h1>First guest marker</h1><h2>Second guest marker</h2>'},{ownerId})).site;
    const token=createId("share"), shareId=createId("shr");
    await createShare({id:shareId,siteId:site.id,tokenHash:hashToken(token),policy:"public",mode:"comment",passcodeHash:null,label:null,createdBy:ownerId,createdAnonId:null,expiresAt:null,versionId:null});
    await page.goto(url!+`/s/${site.slug}`);
    const ids=await page.evaluate(async({site,shareId,token})=>{
      const ids:string[]=[];
      for(const [selector,body] of [["h1","First guest marker"],["h2","Second guest marker"]]) {
        const result=await fetch(`/api/sites/${site.slug}/comments`,{method:"POST",headers:{"content-type":"application/json","x-artifact-share":token},body:JSON.stringify({
          scope:{siteId:site.id,versionId:site.currentVersionId,entry:{kind:"share",shareId}},
          anchor:{schemaVersion:1,kind:"html",filePath:"index.html",selector,quote:{exact:body},viewport:{width:1440,height:1000}},
          body,clientRequestId:crypto.randomUUID(),
        })});
        if(!result.ok)throw Error(`Seed failed: ${result.status}`);
        ids.push((await result.json()).thread.id);
      }
      return ids;
    },{site,shareId,token});
    const context=await browser.createBrowserContext();
    const guest=await context.newPage();
    try {
      await guest.setViewport({width:1440,height:1000});
      await guest.setExtraHTTPHeaders({"accept-language":"en-US"});
      await guest.evaluateOnNewDocument(()=>{if(window===window.top&&location.protocol.startsWith("http"))localStorage.setItem("artifact-comment-rail-collapsed","false");});
      const [permission]=await Promise.all([
        guest.waitForResponse(r=>r.url().includes("/comments/permissions")&&r.ok()),
        guest.goto(url!+`/v/${token}`),
      ]);
      expect((await permission.json()).userId).toBeNull();
      await guest.waitForSelector('button[aria-label="Comments"]');await guest.click('button[aria-label="Comments"]');
      await guest.waitForSelector(".comment-summary");
      // Observe a real quiet poll after the initial list load, not a synthetic auth response.
      await guest.waitForResponse(r=>r.url().includes("/comments/permissions")&&r.ok());
      await guest.click('.comment-header-actions button[aria-label="Show comment markers"]');
      const frame=await guest.waitForFrame(f=>f.url().includes("/api/preview/"));
      await frame.waitForSelector(`[data-comment-thread="${ids[0]}"]`);
      await frame.$eval(`[data-comment-thread="${ids[0]}"]`,el=>(el as HTMLButtonElement).click());
      await guest.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="First guest marker");
      await guest.evaluate(id=>{location.hash=`comment=${id}`;},ids[1]);
      await guest.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Second guest marker");
      expect(await guest.$("textarea")).toBeNull();
    } finally {await context.close();await page.bringToFront();}
  });

  it("creates page-2 PDF coordinates using the real PDF.js viewer", async () => {
    const frame = await begin(`/s/${pdf.slug}`);
    // PDF pages render lazily: scroll the placeholder into view before waiting for its anchor metadata.
    await frame.waitForSelector('canvas[data-page="2"]');
    await frame.$eval('canvas[data-page="2"]', el => el.scrollIntoView());
    await frame.waitForSelector('canvas[data-comment-page="2"]');
    const canvas = (await (await frame.$('canvas[data-comment-page="2"]'))!.boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width * .4, canvas.y + Math.min(canvas.height * .2, 180));
    await submit("Check page two");
    const result = await page.evaluate(async slug => (await fetch(`/api/sites/${slug}/comments/aggregate`)).json(), pdf.slug);
    expect(result.items[0].thread.anchor).toMatchObject({ kind: "pdf", page: 2, filePath: "original/report.pdf" });
    await page.evaluate(() => window.dispatchEvent(new Event("artifact:refresh")));
    await page.waitForFunction(() => new URL((document.querySelector("iframe") as HTMLIFrameElement).src).searchParams.get("r") === "1");
    const refreshed = await page.waitForFrame(f => f.url().includes("/api/preview/") && new URL(f.url()).searchParams.get("r") === "1");
    await refreshed.waitForSelector("[data-artifact-comment-overlay]");
    expect(previewVersion(refreshed.url())).toBe(pdf.currentVersionId);
    await page.click('button[aria-label="Add comment"]');
    await refreshed.waitForSelector('canvas[data-comment-page="1"]');
    const firstPage = (await (await refreshed.$('canvas[data-comment-page="1"]'))!.boundingBox())!;
    await page.mouse.click(firstPage.x + 70, firstPage.y + 100);
    await submit("Comment after snapshot refresh");
    await settle(); await page.screenshot({ path: resolve("output/acceptance/comments-pdf.png") });
  });
  it("falls back for Office without conversion, and aggregates into exact original previews", async () => {
    const frame = await begin(`/s/${office.slug}`);
    await frame.click(".fname"); await submit("Review the whole Office file");
    const result = await page.evaluate(async slug => (await fetch(`/api/sites/${slug}/comments/aggregate`)).json(), office.slug);
    expect(result.items[0].thread.anchor.kind).toBe("document");
    await page.goto(url! + `/s/${html.slug}/comments`);
    await chooseThread("Explain this chart region");
    await page.waitForSelector(".comment-thread");
    expect(await page.$eval(".comment-conversation-toolbar", el => el.textContent)).toContain("Browser review");
    expect(await page.$eval("iframe", el => new URL((el as HTMLIFrameElement).src).searchParams.get("__artifact_version"))).toBe(html.currentVersionId);
    const original = await page.waitForFrame(f => f.url().includes("__artifact_image=1"));
    expect(original.url()).toContain("__artifact_image=1");
    await original.waitForSelector("[data-artifact-comment-overlay] button");
    await settle(); await page.screenshot({ path: resolve("output/acceptance/comments-review.png") });
    await page.setViewport({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
  it("keeps deep-linked navigation on the chosen file and preserves review drafts on list failure", async () => {
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(url! + `/v/${shareToken}`);
    const { firstId, otherId } = await page.evaluate(async ({ slug, token }) => {
      const existing = await (await fetch(`/api/sites/${slug}/comments/aggregate`)).json();
      const first = existing.items.find((item: { thread: { anchor: { kind: string } } }) => item.thread.anchor.kind === "html");
      const { siteId, versionId, entry } = first.space;
      const response = await fetch(`/api/sites/${slug}/comments`, { method: "POST", headers: { "content-type": "application/json", "x-artifact-share": token }, body: JSON.stringify({ scope: { siteId, versionId, entry }, body: "Other file feedback", clientRequestId: crypto.randomUUID(), anchor: { schemaVersion: 1, kind: "html", filePath: "other.html", selector: "h1", quote: { exact: "Second page" }, viewport: { width: 1440, height: 900 } } }) });
      if (!response.ok) throw new Error(await response.text());
      return { firstId: first.thread.id, otherId: (await response.json()).thread.id };
    }, { slug: html.slug, token: shareToken });
    await page.goto(url! + `/v/${shareToken}#comment=${firstId}`);
    await page.waitForSelector(".comment-thread");
    await chooseThread("Other file feedback");
    const other = await page.waitForFrame(frame => frame.url().includes("other.html"));
    await other.waitForSelector("[data-artifact-comment-overlay] button");
    expect(await other.$eval("h1", el => el.textContent)).toBe("Second page");
    let markerWindowReads = 0;
    const countWindowRead = (request: import("puppeteer-core").HTTPRequest) => { if (new URL(request.url()).pathname === `/api/sites/${html.slug}/comments` && request.method() === "GET") markerWindowReads++; };
    page.on("request", countWindowRead);
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/comments/${otherId}`)),
      other.$eval("[data-artifact-comment-overlay] button", el => (el as HTMLButtonElement).click()),
    ]);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(markerWindowReads).toBe(0); page.off("request", countWindowRead);
    await page.click('button[aria-label="Close comments"]');
    await other.click('a[href="index.html"]');
    const afterMarker = await page.waitForFrame(frame => frame.url().includes("/index.html"));
    await afterMarker.waitForSelector("[data-artifact-comment-overlay]");
    expect(await page.$(".comment-panel")).toBeNull();
    await page.click('button[aria-label="Comments"]');
    await page.waitForSelector(".comment-thread");
    await chooseThread("Clarify this heading");
    const original = await page.waitForFrame(frame => frame.url().includes("/index.html"));
    await original.waitForSelector("[data-artifact-comment-overlay] button");
    // The iframe's src attribute stays index.html after an in-artifact navigation.
    await original.click('a[href="other.html"]');
    const navigated = await page.waitForFrame(frame => frame.url().includes("other.html"));
    await navigated.waitForSelector("[data-artifact-comment-overlay]");
    await page.evaluate(() => (Array.from(document.querySelectorAll(".comment-thread")).find(el => el.textContent?.includes("Clarify this heading"))!.querySelector(".comment-location") as HTMLButtonElement).click());
    const returned = await page.waitForFrame(frame => frame.url().includes("/index.html"));
    await returned.waitForSelector("[data-artifact-comment-overlay] button");
    await click("All comments");
    await Promise.all([
      page.waitForResponse(response=>response.url().includes("/other.html")),
      page.evaluate(()=>{const items=Array.from(document.querySelectorAll(".comment-summary"));(items.find(el=>el.textContent?.includes("Other file feedback")) as HTMLButtonElement).click();(items.find(el=>el.textContent?.includes("Clarify this heading")) as HTMLButtonElement).click();}),
    ]);
    const latestChoice = await page.waitForFrame(frame => frame.url().includes("/index.html"));
    await latestChoice.waitForSelector("[data-artifact-comment-overlay] button");
    await page.goto(url! + `/s/${html.slug}/comments?thread=${firstId}`);
    await page.waitForSelector(".comment-thread"); await click("Reply");
    await page.type('textarea[aria-label="Comment"]', "Keep my unsent review");
    await page.setRequestInterception(true);
    const rejectAggregate = (request: import("puppeteer-core").HTTPRequest) => { if (request.url().includes("/comments/aggregate")) void request.respond({ status: 503, contentType: "application/json", body: '{"error":"Temporarily unavailable"}' }); else void request.continue(); };
    page.on("request", rejectAggregate);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.waitForSelector('.comment-panel [role="alert"]');
    expect(await page.$eval('textarea[aria-label="Comment"]', el => (el as HTMLTextAreaElement).value)).toBe("Keep my unsent review");
    page.off("request", rejectAggregate); await page.setRequestInterception(false);
    await click("Discard draft");
    expect(errors).toEqual([]);
  });

  it("bounds blocked dot-path and mismatched preview navigation", async () => {
    await page.goto(url! + `/s/${html.slug}`);
    const ids = await page.evaluate(async ({ slug, siteId, versionId }) => {
      const ids: string[] = [];
      for (const [filePath, exact] of [[".docs/page.html", "Dot folder"], ["other.html", "Second page"]]) {
        const response = await fetch(`/api/sites/${slug}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { siteId, versionId, entry: { kind: "main" } }, body: "Path review", clientRequestId: crypto.randomUUID(), anchor: { schemaVersion: 1, kind: "html", filePath, selector: "h1", quote: { exact }, viewport: { width: 1440, height: 900 } } }) });
        if (!response.ok) throw new Error(await response.text());
        ids.push((await response.json()).thread.id);
      }
      return ids;
    }, { slug: html.slug, siteId: html.id, versionId: html.currentVersionId });
    await page.goto("about:blank");
    await page.setRequestInterception(true);
    let dotAttempts = 0, redirectedAttempts = 0, redirectOther = true;
    const redirect = (request: import("puppeteer-core").HTTPRequest) => {
      const pathname = new URL(request.url()).pathname;
      if (request.isNavigationRequest() && pathname.endsWith("/.docs/page.html")) dotAttempts++;
      if (redirectOther && request.isNavigationRequest() && pathname.endsWith("/other.html")) {
        redirectedAttempts++; void request.respond({ status: 302, headers: { location: `${url}/api/preview/${html.slug}/index.html?__artifact_version=${html.currentVersionId}` } });
      } else void request.continue();
    };
    page.on("request", redirect);
    try {
      // The existing preview resource gate intentionally rejects dotfiles, even though storage
      // and comment paths permit them. A missing bridge must end in a notice, not a reload loop.
      await page.goto(url! + `/s/${html.slug}#comment=${ids[0]}`);
      await page.waitForFunction(() => document.querySelector(".comment-inline-notice")?.textContent?.includes("original position could not be found"));
      expect(dotAttempts).toBe(1);
      redirectOther = false;
      await page.evaluate(id => { window.location.hash = `comment=${id}`; }, ids[1]);
      const recovered = await page.waitForFrame(frame => frame.url().includes("/other.html"));
      await recovered.waitForSelector("[data-artifact-comment-overlay] button");
      expect(dotAttempts).toBe(1);
      redirectOther = true;
      await page.goto("about:blank");
      await page.goto(url! + `/s/${html.slug}#comment=${ids[1]}`);
      await page.waitForFunction(() => document.querySelector(".comment-inline-notice")?.textContent?.includes("original position could not be found"));
      expect(redirectedAttempts).toBe(1);
    } finally { page.off("request", redirect); await page.setRequestInterception(false); }
    expect(errors).toEqual([]);
  });

  async function seedLocation(site: Site, filePath: string, quote: string) {
    await page.goto(url! + `/s/${site.slug}`);
    return page.evaluate(async ({ site, filePath, quote }) => {
      const response = await fetch(`/api/sites/${site.slug}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        scope: { siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" } },
        body: quote, clientRequestId: crypto.randomUUID(), anchor: { schemaVersion: 1, kind: "html", filePath, selector: "h1", quote: { exact: quote }, viewport: { width: 1440, height: 900 } },
      }) });
      if (!response.ok) throw new Error(`Could not seed location: ${response.status}`);
      return (await response.json()).thread.id as string;
    }, { site, filePath, quote });
  }

  it("retains an initial location when the preview head arrives after five seconds", async () => {
    const id = await seedLocation(slow, "index.html", "Late original heading");
    await page.goto("about:blank");
    await page.setRequestInterception(true);
    let held: import("puppeteer-core").HTTPRequest | undefined;
    let delayed = false;
    const hold = (request: import("puppeteer-core").HTTPRequest) => {
      if (!delayed && request.isNavigationRequest() && new URL(request.url()).pathname.startsWith(`/api/preview/${slow.slug}`)) { delayed = true; held = request; }
      else void request.continue();
    };
    page.on("request", hold);
    try {
      const navigation = page.goto(url! + `/s/${slow.slug}#comment=${id}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".comment-inline-notice")?.textContent?.includes("still loading"));
      expect(held).toBeDefined();
      await held!.continue(); held = undefined;
      await navigation;
      const frame = await page.waitForFrame(frame => frame.url().includes(`/api/preview/${slow.slug}`));
      await frame.waitForSelector("[data-artifact-comment-overlay] button");
      await page.waitForFunction(() => !document.querySelector(".comment-inline-notice"));
      expect(await frame.$eval("h1", el => el.textContent)).toBe("Late original heading");
    } finally {
      if (held && !held.isInterceptResolutionHandled()) await held.continue();
      page.off("request", hold); await page.setRequestInterception(false);
    }
  });

  it("locates after host navigation before a slow image lets the iframe load finish", async () => {
    await seedLocation(html, "heavy.html", "Heavy page heading");
    await page.goto("about:blank");
    await page.goto(url! + `/s/${html.slug}`);
    await page.waitForSelector('button[aria-label="Comments"]');
    await page.click('button[aria-label="Comments"]');
    await page.setRequestInterception(true);
    let held: import("puppeteer-core").HTTPRequest | undefined;
    let script: import("puppeteer-core").HTTPRequest | undefined;
    const hold = (request: import("puppeteer-core").HTTPRequest) => {
      if (new URL(request.url()).pathname.endsWith("/slow.svg")) held = request;
      else if (new URL(request.url()).pathname.endsWith("/slow.js")) script = request;
      else void request.continue();
    };
    page.on("request", hold);
    try {
      const imageStarted = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/slow.svg"));
      await chooseThread("Heavy page heading");
      await page.waitForFunction(() => document.querySelector(".comment-inline-notice")?.textContent?.includes("still loading"));
      expect(script).toBeDefined();
      await script!.continue(); script = undefined;
      await imageStarted;
      const frame = await page.waitForFrame(frame => frame.url().includes("/heavy.html"));
      await frame.waitForSelector("[data-artifact-comment-overlay] button");
      expect(await frame.evaluate(() => document.readyState)).not.toBe("complete");
      expect(held).toBeDefined();
      await held!.continue(); held = undefined;
      await frame.waitForFunction(() => document.readyState === "complete");
      await frame.waitForSelector("[data-artifact-comment-overlay] button");
      expect(errors).toEqual([]);
    } finally {
      if (script && !script.isInterceptResolutionHandled()) await script.continue();
      if (held && !held.isInterceptResolutionHandled()) await held.continue();
      page.off("request", hold); await page.setRequestInterception(false);
    }
  });

  it.each(["main", "share"] as const)("ends bridgeless %s positioning when iframe load precedes hydration", async (entry) => {
    await page.goto(url! + `/v/${shareToken}`);
    const id = await page.evaluate(async ({ slug, token, entry }) => {
      const response = await fetch(`/api/sites/${slug}/comments/aggregate`, { headers: { "x-artifact-share": token } });
      return (await response.json()).items.find((item: { space: { entry: { kind: string } } }) => item.space.entry.kind === entry).thread.id as string;
    }, { slug: html.slug, token: shareToken, entry });
    await page.goto("about:blank");
    const scripts: import("puppeteer-core").HTTPRequest[] = [];
    let hold = true, attempts = 0;
    await page.setRequestInterception(true);
    const intercept = (request: import("puppeteer-core").HTTPRequest) => {
      if (hold && request.resourceType() === "script" && request.url().includes("/_next/")) scripts.push(request);
      else if (request.isNavigationRequest() && request.url().includes("/api/preview/")) {
        attempts++; void request.respond({ status: 400, contentType: "text/html", body: "Preview unavailable" });
      } else void request.continue();
    };
    page.on("request", intercept);
    try {
      const navigation = page.goto(url! + (entry === "share" ? `/v/${shareToken}` : `/s/${html.slug}`) + `#comment=${id}`);
      await page.waitForFunction(() => {
        const frame = document.querySelector("iframe");
        return !!frame && (window as Window & { __artifactPreviewLoads?: WeakSet<EventTarget> }).__artifactPreviewLoads?.has(frame);
      });
      hold = false;
      await Promise.all(scripts.map(request => request.continue()));
      await navigation;
      await page.waitForFunction(() => document.querySelector(".comment-inline-notice")?.textContent?.includes("original position could not be found"));
      expect(attempts).toBe(2); // Initial document plus the one allowed location navigation.
    } finally {
      hold = false;
      await Promise.all(scripts.filter(request => !request.isInterceptResolutionHandled()).map(request => request.continue()));
      page.off("request", intercept); await page.setRequestInterception(false);
    }
  });

  it("restores a create draft after reload and retries with its original request identity", async () => {
    const frame = await begin(`/s/${html.slug}`);
    await frame.click("#headline", {offset:{x:20,y:20}});
    await page.waitForSelector('textarea[aria-label="Comment"]');
    await page.type('textarea[aria-label="Comment"]', "Persistent create draft");
    await page.reload();
    await page.waitForSelector('.comment-composer-floating textarea');
    expect(await page.$eval("textarea", el=>(el as HTMLTextAreaElement).value)).toBe("Persistent create draft");
    const ids:string[]=[];
    let failOnce=true;
    await page.setRequestInterception(true);
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      if(request.method()==="POST" && new URL(request.url()).pathname===`/api/sites/${html.slug}/comments`) {
        ids.push(JSON.parse(request.postData()!).clientRequestId);
        if(failOnce){failOnce=false;void request.respond({status:503,contentType:"application/json",body:'{"error":"Unavailable"}'});return;}
      }
      void request.continue();
    };
    page.on("request",intercept);
    try {
      await click("Send");await page.waitForSelector('.comment-composer [role="alert"]');
      await page.reload();await page.waitForSelector('.comment-composer-floating textarea');
      expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Persistent create draft");
      await click("Send");await page.waitForFunction(()=>!document.querySelector(".comment-composer"));
      expect(ids).toHaveLength(2);expect(ids[1]).toBe(ids[0]);
      await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Persistent create draft");
      expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith("artifact:comment-drafts")).every(k=>sessionStorage.getItem(k)==="{}"))).toBe(true);
    } finally {page.off("request",intercept);await page.setRequestInterception(false);}
  });

  it("preserves a reply through close/reload and supports resolve, undo and explicit draft discard", async () => {
    await click("Reply");await page.waitForSelector("textarea");await page.type("textarea", "A reply worth keeping");
    await page.click('button[aria-label="Close comments"]');
    await page.click('button[aria-label="Comments"]');
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("A reply worth keeping");
    await page.reload();await page.waitForSelector('.comment-composer-inline textarea');
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("A reply worth keeping");
    await click("Send");await page.waitForFunction(()=>!document.querySelector(".comment-composer"));
    await page.waitForFunction(()=>Array.from(document.querySelectorAll(".comment-body")).some(el=>el.textContent==="A reply worth keeping"));
    await click("End discussion");await page.waitForSelector(".comment-undo");await page.waitForSelector(".comment-resolved");
    expect(await page.$eval(".comment-resolved",el=>el.textContent)).toContain("Browser Reviewer");
    await click("Undo");await page.waitForFunction(()=>!document.querySelector(".comment-resolved"));
    await click("Reply");await page.waitForSelector("textarea");await page.type("textarea","Discard me");await click("Discard draft");
    await page.reload();await page.waitForSelector('button[aria-label="Comments"]');
    expect(await page.$("textarea")).toBeNull();
    expect(errors).toEqual([]);
  });

  it("filters all versions and main discussions, previews history and returns to the current artifact", async () => {
    const site=(await createSite({mode:"file",filename:"history.html",bytes:strToU8('<h1>Original version heading</h1>')},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Original version heading");
    const replacement=await replaceSiteContent(site.slug,{mode:"file",filename:"history.html",bytes:strToU8('<h1>Current version heading</h1>')},testAudit(),site.currentVersionId);
    if(!replacement || "conflict" in replacement)throw new Error("Fixture replacement failed");
    await page.goto(url!+`/s/${site.slug}?comments=all`);
    await page.waitForSelector('.comment-summary');
    await page.select('.comment-source-filter select',"main");
    await page.waitForFunction(()=>document.querySelector(".comment-summary")?.textContent?.includes("Original version heading"));
    await page.select('select[aria-label="Version"]',"current");
    await page.waitForSelector(".comment-empty");
    await page.select('select[aria-label="Version"]',"all");
    await chooseThread("Original version heading");
    await page.waitForSelector(".comment-history-banner");
    const original=await page.waitForFrame(f=>previewVersion(f.url())===site.currentVersionId);
    await original.waitForSelector("[data-artifact-comment-overlay] button");
    expect(await original.$eval("h1",el=>el.textContent)).toBe("Original version heading");
    await page.waitForFunction(()=>document.querySelector(".official-version-number")?.textContent === "v1");
    expect(await page.$('button[aria-label="Add comment"]')).toBeNull();
    const oldFrame = await page.$("iframe.fs-frame");
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("artifact:refresh",{cancelable:true,detail:{automatic:false}})));
    await page.waitForFunction(node=>!node.isConnected,{},oldFrame!);
    const refreshedHistory=await page.waitForFrame(f=>previewVersion(f.url())===site.currentVersionId);
    await refreshedHistory.waitForSelector("h1");
    expect(await refreshedHistory.$eval("h1",el=>el.textContent)).toBe("Original version heading");
    expect(await page.$(".comment-history-banner")).not.toBeNull();
    // The bare viewer hash must restore the immutable original version on reload.
    await page.goto(url!+`/s/${site.slug}#comment=${id}`);
    await page.waitForSelector(".comment-history-banner");
    await page.waitForSelector(".comment-body");
    await click("Reply");await submit("Reply stays on the original version");
    const historicalFrame=page.frames().find(f=>previewVersion(f.url())===site.currentVersionId)!;
    await historicalFrame.evaluate(()=>addEventListener("message",event=>{if(event.data?.protocol==="artifact-comments")document.documentElement.dataset.observedCommentVersion=event.data.scope?.versionId;}));
    await page.setRequestInterception(true);
    let heldReturn: import("puppeteer-core").HTTPRequest | undefined;
    const holdReturn=(request:import("puppeteer-core").HTTPRequest)=>{if(request.isNavigationRequest()&&previewVersion(request.url())===replacement.version.id)heldReturn=request;else void request.continue();};
    page.on("request",holdReturn);
    try {
      const requested=page.waitForRequest(r=>r.isNavigationRequest()&&previewVersion(r.url())===replacement.version.id);
      await click("Return to current version"); await requested;
      await historicalFrame.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      expect(await historicalFrame.$eval("html",el=>(el as HTMLElement).dataset.observedCommentVersion)).not.toBe(replacement.version.id);
    } finally {
      if(heldReturn&&!heldReturn.isInterceptResolutionHandled())await heldReturn.continue();
      page.off("request",holdReturn);await page.setRequestInterception(false);
    }
    const current=await page.waitForFrame(f=>previewVersion(f.url())===replacement.version.id);
    await current.waitForSelector("h1");expect(await current.$eval("h1",el=>el.textContent)).toBe("Current version heading");
    await page.goto(url!+`/s/${site.slug}/comments?thread=${id}`);
    await page.waitForSelector(".comment-history-banner");
    await page.waitForFunction(()=>Array.from(document.querySelectorAll(".comment-body")).some(el=>el.textContent==="Reply stays on the original version"));
    await settle(); await page.screenshot({path:resolve("output/acceptance/comment-history.png")});
    expect(errors).toEqual([]);
  });

  it("keeps non-entry historical files through refresh, return and rollback", async () => {
    const files=(label:string)=>[
      {relpath:"index.html",bytes:strToU8(`<h1>${label} entry</h1><a href="other.html">Other</a>`)},
      {relpath:"other.html",bytes:strToU8(`<h1>${label} other</h1>`)},
    ];
    const site=(await createSite({mode:"folder",files:files("Old")},{ownerId})).site;
    await seedLocation(site,"other.html","Old other");
    await seedLocation(site,"index.html","Old entry");
    const secondId=await seedLocation(site,"other.html","Second old comment");
    const replacement=await replaceSiteContent(site.slug,{mode:"folder",files:files("New")},testAudit(),site.currentVersionId);
    if(!replacement||"conflict" in replacement)throw Error("Replacement failed");
    await page.goto(url!+`/s/${site.slug}?comments=all`);await page.waitForSelector(".comment-summary");
    const current=await page.waitForFrame(f=>f.url().includes(`/api/preview/${site.slug}`));
    await current.waitForSelector("a");await current.click("a");
    await current.waitForFunction(()=>document.querySelector("h1")?.textContent==="New other");
    await chooseThread("Old entry");await page.waitForSelector(".comment-history-banner");
    await click("All comments");await chooseThread("Old other");
    let original=await page.waitForFrame(f=>f.url().includes("other.html")&&previewVersion(f.url())===site.currentVersionId);
    await original.waitForFunction(()=>document.querySelector("h1")?.textContent==="Old other");
    await original.waitForSelector("[data-artifact-comment-overlay] button");
    await original.evaluate(()=>{Object.assign(window,{commentDocumentSentinel:"same-document"});});
    await page.evaluate(id=>{
      window.addEventListener("message",function located(event){
        if(event.data?.event?.type==="located" && event.data.event.threadId===id){
          Object.assign(window,{secondCommentLocated:true});window.removeEventListener("message",located);
        }
      });
    },secondId);
    await click("All comments");await chooseThread("Second old comment");
    await page.waitForFunction(()=>(window as unknown as {secondCommentLocated?:boolean}).secondCommentLocated);
    expect(await original.evaluate(()=>(window as unknown as {commentDocumentSentinel?:string}).commentDocumentSentinel)).toBe("same-document");
    const mounted=await page.$("iframe.fs-frame");
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("artifact:refresh",{cancelable:true,detail:{automatic:false}})));
    await page.waitForFunction(node=>!node.isConnected,{},mounted!);
    original=await page.waitForFrame(f=>f.url().includes("other.html")&&previewVersion(f.url())===site.currentVersionId);
    await original.waitForFunction(()=>document.querySelector("h1")?.textContent==="Old other");
    await click("Return to current version");
    const returned=await page.waitForFrame(f=>f.url().includes("other.html")&&previewVersion(f.url())===replacement.version.id);
    await returned.waitForFunction(()=>document.querySelector("h1")?.textContent==="New other");
    await page.goto(url!+`/s/${site.slug}?comments=all`);
    await page.waitForSelector(".comment-summary");await chooseThread("Old other");
    await page.waitForSelector(".comment-history-banner");
    await page.mouse.move(700,10);await page.click('button[aria-label="More"]');await click("Version history");
    // The new root can redirect to the selected historical comment before response.json resolves.
    const seenVersions=new Set<string>();
    const remember=(frame:import("puppeteer-core").Frame)=>{const version=previewVersion(frame.url());if(version)seenVersions.add(version);};
    page.on("framenavigated",remember);
    const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==="POST"&&r.url().endsWith("/rollback")&&r.ok()),click("Roll back to this version")]);
    const rollback=await response.json();
    expect(rollback.versionId).not.toBe(site.currentVersionId);
    expect(rollback.versionId).not.toBe(replacement.version.id);
    // Wait for the new root before checking the linked original; never match pre-rollback UI.
    try {if(!seenVersions.has(rollback.versionId)) await page.waitForFrame(f=>previewVersion(f.url())===rollback.versionId);}
    finally {page.off("framenavigated",remember);}
    // A selected comment's hash intentionally reopens its immutable original snapshot.
    await page.waitForSelector(".comment-history-banner");
    const linked=await page.waitForFrame(f=>previewVersion(f.url())===site.currentVersionId);
    await linked.waitForSelector("[data-artifact-comment-overlay] button");
    await click("Return to current version");
    const rolled=await page.waitForFrame(f=>previewVersion(f.url())===rollback.versionId);
    await page.waitForFunction(()=>!document.querySelector(".comment-history-banner"));
    await rolled.waitForSelector("h1");
    expect(await rolled.$eval("h1",el=>el.textContent)).toContain("Old");
  });

  it("locates a current thread after an unavailable historical runtime", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Old runtime</h1>"},{ownerId})).site;
    await seedLocation(site,"index.html","Old runtime");
    const next=await replaceSiteContent(site.slug,{mode:"paste",html:"<h1>Current runtime</h1>"},testAudit(),site.currentVersionId);
    if(!next||"conflict" in next)throw Error("Replacement failed");
    await seedLocation({...site,currentVersionId:next.version.id},"index.html","Current runtime");
    await page.setRequestInterception(true);
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      if(request.isNavigationRequest()&&request.url().includes("/api/preview/")&&previewVersion(request.url())===site.currentVersionId)
        void request.respond({status:200,contentType:"text/html",body:"<h1>Old runtime</h1>"});
      else void request.continue();
    };
    page.on("request",intercept);
    try {
      await page.goto(url!+`/s/${site.slug}?comments=all`);await page.waitForSelector(".comment-summary");
      await chooseThread("Old runtime");
      await page.waitForFunction(()=>[...document.querySelectorAll(".comment-error, .comment-inline-notice")].some(el=>el.textContent?.includes("original position could not be found")));
      await click("All comments");await chooseThread("Current runtime");
      const current=await page.waitForFrame(f=>previewVersion(f.url())===next.version.id);
      await current.waitForSelector("[data-artifact-comment-overlay] button");
      expect(await page.$(".comment-error")).toBeNull();
    } finally {page.off("request",intercept);await page.setRequestInterception(false);}
  });

  it("retries initial permission discovery without opening the sidebar", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Permission retry</h1>"},{ownerId})).site;
    await page.setRequestInterception(true);let failures=0;
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      if(request.url().includes(`/api/sites/${site.slug}/comments/permissions`)&&failures++===0)
        void request.respond({status:503,contentType:"application/json",body:JSON.stringify({error:"Temporary failure"})});
      else void request.continue();
    };
    page.on("request",intercept);
    try {
      await page.goto(url!+`/s/${site.slug}`);
      await page.waitForSelector('button[aria-label="Add comment"]');
      expect(failures).toBeGreaterThan(1);
      expect(await page.$(".comment-panel")).toBeNull();
      expect(await page.evaluate(()=>window.dispatchEvent(new CustomEvent("artifact:before-comment-scope-change",{cancelable:true,detail:{automatic:true}})))).toBe(true);
    } finally {page.off("request",intercept);await page.setRequestInterception(false);}
  });

  it("settles denied discovery and recovers expired identity on focus with the panel closed", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Denied discovery</h1>"},{ownerId})).site;
    await page.setRequestInterception(true);let denied=true, requests=0;
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      if(request.url().includes(`/api/sites/${site.slug}/comments/permissions`)) {
        requests++;
        if(denied){void request.respond({status:401,contentType:"application/json",body:'{"error":"Expired session"}'});return;}
      }
      void request.continue();
    };
    page.on("request",intercept);
    try {
      await Promise.all([
        page.waitForResponse(r=>r.url().includes(`/api/sites/${site.slug}/comments/permissions`)&&r.status()===401),
        page.goto(url!+`/s/${site.slug}`),
      ]);
      await page.waitForFunction(()=>window.dispatchEvent(new CustomEvent("artifact:before-comment-scope-change",{cancelable:true,detail:{automatic:true}})));
      expect(requests).toBe(1);
      expect(await page.$('button[aria-label="Add comment"]')).toBeNull();
      denied=false;
      await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
      await page.waitForSelector('button[aria-label="Add comment"]');
      expect(requests).toBe(2);
      expect(await page.$(".comment-panel")).toBeNull();
    } finally {page.off("request",intercept);await page.setRequestInterception(false);}
  });

  it("preserves denied drafts without blocking refresh and serializes recovery after sign-in", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Restore after sign-in</h1>"},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Restore after sign-in");
    await page.goto(url!+`/s/${site.slug}?thread=${id}`);
    await page.waitForSelector(".comment-conversation");await click("Reply");
    await page.waitForSelector("textarea");await page.type("textarea","Keep denied draft");
    await page.click('button[aria-label="Close composer"]');
    await page.setRequestInterception(true);
    let denial=403, holdDetail=true;
    const held:import("puppeteer-core").HTTPRequest[]=[];
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      const path=new URL(request.url()).pathname;
      if(path===`/api/sites/${site.slug}/comments/permissions` && denial){
        void request.respond({status:denial,contentType:"application/json",body:'{"error":"Denied"}'});return;
      }
      if(path===`/api/sites/${site.slug}/comments/${id}` && holdDetail){held.push(request);return;}
      void request.continue();
    };
    page.on("request",intercept);
    try {
      for(const status of [403,404,401]) {
        denial=status;
        await Promise.all([
          page.waitForResponse(r=>r.url().includes(`/api/sites/${site.slug}/comments/permissions`)&&r.status()===status),
          page.reload(),
        ]);
        await page.waitForFunction(()=>window.dispatchEvent(new CustomEvent("artifact:before-comment-scope-change",{cancelable:true,detail:{automatic:true}})));
        expect(await page.$('button[aria-label="Comments"]')).toBeNull();
        expect(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith("artifact:comment-drafts")&&sessionStorage.getItem(k)?.includes("Keep denied draft")))).toBe(true);
      }
      denial=0;
      await Promise.all([
        page.waitForRequest(r=>new URL(r.url()).pathname===`/api/sites/${site.slug}/comments/${id}`),
        page.evaluate(()=>window.dispatchEvent(new Event("focus"))),
      ]);
      // Let effects flush while the restore's detail read is held. Deep-link location must wait.
      await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())))));
      expect(held).toHaveLength(1);
      holdDetail=false;await held[0].continue();
      await page.waitForSelector("textarea");
      expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Keep denied draft");
      await click("Discard draft");
    } finally {
      holdDetail=false;
      for(const request of held)if(!request.isInterceptResolutionHandled())await request.continue();
      page.off("request",intercept);await page.setRequestInterception(false);
    }
  });

  it("preserves the active draft when browser storage rejects writes", async () => {
    await page.goto(url!+`/s/${html.slug}?comments=all`);
    await chooseThread("Persistent create draft"); await click("Reply"); await page.waitForSelector("textarea");
    await page.evaluate(()=>{ Object.assign(window,{restoreCommentStorage:Storage.prototype.setItem}); Storage.prototype.setItem=function(){throw new DOMException("Quota exceeded","QuotaExceededError");}; });
    try {
      await page.type("textarea","Only in memory");
      await page.click('button[aria-label="Close composer"]');
      await page.waitForFunction(()=>!document.querySelector("textarea"));
      await click("All comments"); await chooseThread("Persistent create draft"); await click("Reply");
      expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Only in memory");
      expect(await page.$eval(".comment-notice",el=>el.textContent)).toContain("Keep this page open");
      expect(await page.$eval(".comment-notice",el=>el.parentElement===document.body)).toBe(true);
      const allowed = await page.evaluate(()=>window.dispatchEvent(new Event("artifact:before-comment-scope-change",{cancelable:true})));
      expect(allowed).toBe(false);
    } finally {
      await page.evaluate(()=>{Storage.prototype.setItem=(window as unknown as {restoreCommentStorage:Storage["setItem"]}).restoreCommentStorage;});
      await click("Discard draft");
    }
  });
  it("keeps the original edit revision until the user adopts the conflict", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Edit conflict</h1>"},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Editable thread");
    await page.goto(url!+`/s/${site.slug}#comment=${id}`);
    await page.waitForSelector(".comment-message-menu summary"); await page.click(".comment-message-menu summary"); await click("Edit"); await page.waitForSelector("textarea");
    await page.$eval("textarea",el=>(el as HTMLTextAreaElement).select()); await page.type("textarea","Local edited draft");
    await page.click('button[aria-label="Close composer"]');
    await page.evaluate(async ({slug,id})=>{
      const d=await(await fetch(`/api/sites/${slug}/comments/${id}`)).json();const m=d.messages.items[0];
      const r=await fetch(`/api/sites/${slug}/comments/${id}/messages/${m.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({body:"Edited in another tab",expectedRevision:m.revision})});if(!r.ok)throw Error(await r.text());
      window.dispatchEvent(new Event("focus"));
    },{slug:site.slug,id});
    await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Edited in another tab");
    const menu=await page.$(".comment-message-menu");if(!await menu!.evaluate(el=>(el as HTMLDetailsElement).open))await page.click(".comment-message-menu summary");
    await click("Edit"); await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Local edited draft");
    await click("Send"); await page.waitForSelector(".comment-conflict");
    await click("Keep my draft and use this revision"); await page.reload();await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Local edited draft");
    await click("Send");await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Local edited draft");
    expect(await page.$(".comment-conflict")).toBeNull();
  });

  it("reactivates the same pin and restores whole-file drafts beneath a thread hash", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Draft selection</h1>"},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Draft selection");
    await page.goto(url!+`/s/${site.slug}#comment=${id}`);await page.waitForSelector(".comment-thread");
    const frame=await page.waitForFrame(f=>f.url().includes(`/api/preview/${site.slug}`));
    await frame.waitForSelector("[data-artifact-comment-overlay] button");
    await click("All comments");await frame.$eval("[data-artifact-comment-overlay] button", el => (el as HTMLButtonElement).click());
    await page.waitForSelector(".comment-thread");
    await page.focus(".comment-panel-content"); await page.keyboard.press("Escape");
    await frame.$eval("[data-artifact-comment-overlay] button", el => (el as HTMLButtonElement).click());
    await page.waitForSelector(".comment-panel");
    await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Draft selection");
    await page.evaluate(id=>history.replaceState(null,"",`#comment=${id}`),id);
    for(let attempt=0;attempt<2;attempt++) {
      await page.click('button[aria-label="Add comment"]');await page.waitForSelector(".comment-selection");await click("Whole file");await page.waitForSelector("textarea");
      if(!attempt){await page.type("textarea","Whole-file saved draft");await page.click('button[aria-label="Close composer"]');}
      else expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Whole-file saved draft");
    }
    await page.reload();await page.waitForSelector(".comment-thread");
    expect(await page.$("textarea")).toBeNull();
    await page.click(".comment-draft-recovery summary");
    await page.click(".comment-draft-recovery a");
    await page.waitForSelector(".comment-composer-floating textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Whole-file saved draft");
    await click("Send");await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Whole-file saved draft");
    expect(await page.$(".comment-error")).toBeNull();
  });

  it("recovers from a missing draft thread and follows subsequent hash links", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Recovery</h1>"},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Available discussion");
    await page.goto(url!+`/s/${html.slug}`);
    await page.evaluate(({user,site})=>{
      const scope={siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main"}};
      const draft={kind:"reply",scope,threadId:"deleted-thread",body:"Unavailable draft",requestId:null,updatedAt:Date.now()};
      sessionStorage.setItem(`artifact:comment-drafts:v1:${JSON.stringify([user,site.id])}`,JSON.stringify({[JSON.stringify([scope.versionId,scope.entry,draft.kind,draft.threadId,""])]:draft}));
    },{user:ownerId,site});
    await page.goto(url!+`/s/${site.slug}`); await page.waitForSelector(".comment-panel");
    await page.evaluate(id=>{location.hash=`comment=${id}`;},id);
    await page.waitForFunction(()=>document.querySelector(".comment-body")?.textContent==="Available discussion");
    expect(await page.$("textarea")).toBeNull();
  });

  it("does not open a share sidebar or block refresh for another discussion's drafts", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Separate discussions</h1>"},{ownerId})).site;
    const token=createId("share");
    await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),policy:"public",mode:"comment",passcodeHash:null,label:null,createdBy:ownerId,createdAnonId:null,expiresAt:null,versionId:null});
    await page.goto(url!+`/s/${site.slug}`);await page.waitForSelector('button[aria-label="Add comment"]');
    await page.click('button[aria-label="Add comment"]');
    await page.waitForFunction(()=>Boolean(document.querySelector(".comment-selection")||document.querySelector("textarea")));
    if(await page.$(".comment-selection"))await click("Whole file");
    await page.type("textarea","Main-only draft");
    // pagehide must flush without relying on beforeunload (mobile Safari).
    await page.evaluate(()=>window.dispatchEvent(new Event("pagehide")));
    await page.goto(url!+`/v/${token}?welcome=0`);await page.waitForSelector('button[aria-label="Add comment"]');
    expect(await page.$(".comment-panel")).toBeNull();
    expect(await page.evaluate(()=>window.dispatchEvent(new CustomEvent("artifact:before-comment-scope-change",{cancelable:true,detail:{automatic:true}})))).toBe(true);
  });

  it("preserves document drafts through a blocked upload and retry of the same file", async () => {
    const site=(await createSite({mode:"file",filename:"draft.pdf",bytes:buildCommentPdf(1)},{ownerId})).site;
    await page.goto(url!+`/s/${site.slug}`);await page.waitForSelector('button[aria-label="Add comment"]');
    await page.click('button[aria-label="Add comment"]');
    await page.waitForFunction(()=>Boolean(document.querySelector(".comment-selection")||document.querySelector("textarea")));
    if(await page.$(".comment-selection"))await click("Whole file");
    await page.type("textarea","Document draft survives upload");
    const upload=()=>page.evaluate(bytes=>{
      const input=document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],"draft.pdf",{type:"application/pdf"}));
      input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));
    },Array.from(buildCommentPdf(2)));
    await page.evaluate(()=>{Object.assign(window,{restoreCommentStorage:Storage.prototype.setItem});Storage.prototype.setItem=()=>{throw Error("Storage unavailable")};});
    try {
      await upload();
      expect(await page.$eval('input[type="file"]',el=>(el as HTMLInputElement).value)).toBe("");
      expect(await page.$("dialog.upload-confirmation")).toBeNull();
      expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Document draft survives upload");
    } finally {await page.evaluate(()=>{Storage.prototype.setItem=(window as unknown as {restoreCommentStorage:Storage["setItem"]}).restoreCommentStorage;});}
    await upload();await page.waitForSelector("dialog.upload-confirmation[open]");
    await Promise.all([page.waitForResponse(r=>r.request().method()==="POST"&&r.url().includes("/versions")&&r.ok()),click("Upload")]);
    // Wait for the refreshed version controls, not network idleness: PDF loading
    // and background polling can keep requests open.
    await page.waitForFunction(()=>Array.from(document.querySelectorAll(".comment-panel option")).some(option=>option.textContent?.startsWith("v2 ·")));
    await page.waitForSelector(".comment-draft-recovery summary");await page.click(".comment-draft-recovery summary");await page.click(".comment-draft-recovery a");
    await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Document draft survives upload");
    await click("Discard draft");
  });

  it("resumes a share create draft without requiring a document reload", async () => {
    await page.goto(url!+`/v/${shareToken}`);await page.waitForSelector('button[aria-label="Add comment"]');
    await page.click('button[aria-label="Add comment"]');
    await page.waitForFunction(()=>document.querySelector(".comment-selection")||document.querySelector("textarea"));
    if(await page.$(".comment-selection"))await click("Whole file");
    await page.type("textarea","Share create recovery");await page.click('button[aria-label="Close composer"]');
    await page.evaluate(()=>{history.replaceState(null,"",location.pathname+location.search+"#comment=unknown-thread");});
    await page.reload();await page.waitForSelector(".comment-draft-recovery summary");
    await page.click(".comment-draft-recovery summary");await page.click(".comment-draft-recovery a");await page.waitForSelector("textarea");
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("Share create recovery");
    await page.click('button[aria-label="Close composer"]');
    await page.evaluate(()=>history.replaceState(null,"",location.pathname+location.search));
    await page.setRequestInterception(true);
    const intercept=(request:import("puppeteer-core").HTTPRequest)=>{
      if(request.url().includes("/comments/permissions"))
        void request.respond({status:200,contentType:"application/json",body:JSON.stringify({userId:ownerId,isAuthenticated:true,canRead:true,canCreate:false,canReply:false,canAggregate:false,canReadVersions:false})});
      else void request.continue();
    };
    page.on("request",intercept);
    try {
      await page.reload();await page.waitForSelector(".comment-draft-recovery summary");
      expect(await page.$(".comment-notice")).toBeNull();
      await page.click(".comment-draft-recovery summary");await page.click(".comment-draft-recovery a");
      await page.waitForFunction(()=>document.querySelector(".comment-notice")?.textContent?.includes("Your draft is preserved"));
      expect(await page.$("textarea")).toBeNull();
      expect(await page.$eval(".comment-draft-recovery",el=>el.textContent)).toContain("Share create recovery");
    } finally {page.off("request",intercept);await page.setRequestInterception(false);}
    await page.reload();await page.waitForSelector("textarea");await click("Discard draft");
  });

  it("keeps new composition open on a legacy thread query link", async () => {
    const site=(await createSite({mode:"paste",html:"<h1>Query comment</h1>"},{ownerId})).site;
    const id=await seedLocation(site,"index.html","Query comment");
    await page.goto(url!+`/s/${site.slug}?thread=${id}`);await page.waitForSelector(".comment-thread");
    await page.click('button[aria-label="Add comment"]');
    await page.waitForFunction(()=>document.querySelector(".comment-selection")||document.querySelector("textarea"));
    if(await page.$(".comment-selection"))await click("Whole file");
    await page.type("textarea","New draft stays open");await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    expect(await page.$eval("textarea",el=>(el as HTMLTextAreaElement).value)).toBe("New draft stays open");
    await click("Discard draft");
  });

  it("keeps the mobile sheet and inline reply within the viewport", async () => {
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await page.goto(url!+`/s/${html.slug}?comments=all`);
    await page.waitForSelector(".comment-summary");
    await page.$eval(".comment-panel",async el=>{await Promise.all(el.getAnimations().map(animation=>animation.finished));});
    const bounds=await page.$eval(".comment-panel",el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.width);expect(bounds.bottom).toBeLessThanOrEqual(bounds.height+1);
    await settle(); await page.screenshot({path:resolve("output/acceptance/comment-mobile-list.png")});
    await chooseThread("Persistent create draft");await click("Reply");
    await page.type("textarea","Mobile reply draft");
    await settle(); await page.screenshot({path:resolve("output/acceptance/comment-mobile-reply.png")});
    expect(await page.$eval(".comment-composer-inline",el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
    await click("Discard draft");
    await page.setViewport({width:1440,height:1000});
    await page.goto(url!+`/s/${html.slug}?comments=all`);await page.waitForSelector(".comment-summary");
    await settle(); await page.screenshot({path:resolve("output/acceptance/comment-desktop-list.png")});
    await chooseThread("Persistent create draft");await settle(); await page.screenshot({path:resolve("output/acceptance/comment-desktop-detail.png")});
    expect(errors).toEqual([]);
  });

  it("keeps drafts and authorship isolated when the account changes in another tab", async () => {
    await page.goto(url!+`/s/${html.slug}?comments=all`);
    await chooseThread("Persistent create draft");await click("Reply");await page.waitForSelector("textarea");await page.type("textarea","Owner-only draft");
    const other=await upsertUser({authProvider:"browser",providerSubject:createId("subject"),email:"other@example.test",displayName:"Another reviewer",emailVerified:true});
    const {cookie}=await mintSession(new Request(url!),other.id);
    const switchCookie=async(value:string)=>{const first=value.split(";")[0],at=first.indexOf("=");await browser.defaultBrowserContext().setCookie({name:first.slice(0,at),value:first.slice(at+1),domain:new URL(url!).hostname,path:"/"});await page.evaluate(()=>window.dispatchEvent(new Event("focus")));};
    try {
      await switchCookie(cookie);
      await page.waitForFunction(()=>!document.querySelector("textarea")&&!document.querySelector(".comment-source-filter"));
      await page.waitForSelector('button[aria-label="Comments"]');
      if(!await page.$(".comment-panel"))await page.click('button[aria-label="Comments"]');await chooseThread("Persistent create draft");
      expect(await page.$eval(".comment-author",el=>el.textContent)).not.toContain("(you)");
      await click("Reply");await page.waitForSelector("textarea");await page.type("textarea","Other account draft");
      await switchCookie(ownerCookie);
      await page.waitForFunction(()=>(document.querySelector("textarea") as HTMLTextAreaElement)?.value==="Owner-only draft");
      await click("Discard draft");
    } finally {await switchCookie(ownerCookie);await page.evaluate(()=>sessionStorage.clear());}
    expect(errors).toEqual([]);
  });

  it("offers reactions, reports unread replies and dismisses a top copy toast", async () => {
    await page.setViewport({width:1440,height:1000});
    const site=(await createSite({mode:"paste",title:"Comment engagement acceptance",html:'<html><body style="font:24px system-ui;padding:48px"><h1>Review the next release</h1><p>Comments stay with their original context.</p></body></html>'},{ownerId})).site;
    const api=`${url}/api/sites/${site.slug}/comments`;
    const headers={cookie:ownerCookie.split(";")[0],origin:url!,"content-type":"application/json"};
    const response=await fetch(api,{method:"POST",headers,body:JSON.stringify({scope:{siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main"}},anchor:{schemaVersion:1,kind:"document",filePath:"index.html"},body:"Please clarify the release timing",clientRequestId:crypto.randomUUID()})});
    expect(response.status).toBe(201);
    const detail=await response.json();
    const initialized=page.waitForResponse(response=>response.url().endsWith("/comments/unread")&&response.request().method()==="POST"&&response.status()===200);
    await page.goto(`${url}/s/${site.slug}`);
    await initialized;
    expect(await page.$eval(".comment-rail",rail=>{
      const bounds=rail.getBoundingClientRect(),handle=rail.querySelector(".comment-rail-toggle")!.getBoundingClientRect();
      return Math.abs((bounds.top+bounds.bottom-handle.top-handle.bottom)/2)<2;
    })).toBe(true);
    const other=await upsertUser({authProvider:"browser",providerSubject:createId("subject"),displayName:"Alex Chen",email:"reaction@example.test",emailVerified:true});
    const {cookie}=await mintSession(new Request(url!),other.id);
    const reply=await fetch(`${api}/${detail.thread.id}/messages`,{method:"POST",headers:{...headers,cookie:cookie.split(";")[0]},body:JSON.stringify({body:"The updated release is scheduled for Friday.",clientRequestId:crypto.randomUUID()})});
    expect(reply.ok).toBe(true);
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForSelector('.comment-rail .comment-unread-dot',{timeout:20000});
    await page.click('button[aria-label="Comments"]');
    await page.waitForSelector('.comment-summary .comment-unread-dot');
    // Opening the list is not a receipt for a reply that has not been shown.
    expect(await page.$('.comment-rail .comment-unread-dot')).not.toBeNull();
    await chooseThread("Please clarify the release timing");
    await page.waitForFunction(()=>!document.querySelector('.comment-rail .comment-unread-dot'));
    // Hold a pre-mutation focus refresh until after the reaction write commits.
    let releaseStale: (()=>Promise<void>) | undefined;
    let captured!: ()=>void;
    const staleReady=new Promise<void>(resolve=>{captured=resolve;});
    await page.setRequestInterception(true);
    const holdList=async(request:import("puppeteer-core").HTTPRequest)=>{
      if(!releaseStale && request.url().startsWith(`${api}/aggregate?`)) {
        const response=await fetch(request.url(),{headers});
        const body=await response.text();
        releaseStale=()=>request.respond({status:response.status,contentType:"application/json",body});
        captured();
      } else await request.continue();
    };
    page.on("request",holdList);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await staleReady;
    await page.evaluate(()=>{Object.defineProperty(HTMLElement.prototype,"showPopover",{configurable:true,value:undefined});Object.defineProperty(HTMLElement.prototype,"hidePopover",{configurable:true,value:undefined});});
    await page.click('.comment-reaction-picker');
    await page.click('.comment-emoji-menu button[aria-label="👍"]');
    await page.waitForSelector('.comment-reactions > button[aria-pressed="true"]');
    expect(await page.$eval('.comment-reactions > button[aria-pressed]',el=>el.textContent)).toContain("1");
    expect(await page.$eval(".comment-reaction-picker",el=>document.activeElement===el)).toBe(true);
    await releaseStale!();
    await settle();
    expect(await page.$('.comment-reactions > button[aria-pressed="true"]')).not.toBeNull();
    page.off("request",holdList);await page.setRequestInterception(false);
    // Superseding a list must release its in-flight flag: later quiet loads still run.
    const laterReply=await fetch(`${api}/${detail.thread.id}/messages`,{method:"POST",headers:{...headers,cookie:cookie.split(";")[0]},body:JSON.stringify({body:"A new reply after the reaction race.",clientRequestId:crypto.randomUUID()})});
    expect(laterReply.ok).toBe(true);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(()=>document.querySelector(".comment-panel")?.textContent?.includes("A new reply after the reaction race."));
    await page.click('.comment-reactions > button[aria-pressed]');
    await page.waitForFunction(()=>!document.querySelector('.comment-reactions > button[aria-pressed]'));
    await page.click('.comment-reaction-picker');
    await page.click('.comment-emoji-menu button[aria-label="❤️"]');
    await page.waitForSelector('.comment-reactions > button[aria-pressed="true"]');
    await page.screenshot({path:resolve("output/acceptance/comment-reactions-desktop.png")});
    await page.click('.comment-reaction-picker');
    await page.waitForSelector('.comment-emoji-menu');
    expect(await page.$eval('.comment-emoji-menu',el=>{const rect=el.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight;})).toBe(true);
    await page.click('.comment-emoji-menu button[aria-label="More emoji"]');
    await page.waitForSelector('.comment-emoji-menu input');
    await page.setViewport({width:1440,height:700});
    await page.evaluate(()=>window.dispatchEvent(new Event("resize")));
    await page.waitForSelector('.comment-emoji-menu input');
    await page.type('.comment-emoji-menu input', 'otter');
    await page.waitForSelector('.comment-emoji-menu button[data-unified="1f9a6"]');
    await page.click('.comment-emoji-menu button[data-unified="1f9a6"]');
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.comment-reactions > button')).some(el=>el.textContent?.includes("🦦")));
    await page.click('.comment-reaction-picker');
    await page.click('.comment-emoji-menu button[aria-label="More emoji"]');
    await page.waitForSelector('.comment-emoji-menu .EmojiPickerReact');
    await page.$eval('.comment-emoji-menu .epr-body',el=>{el.scrollTop=100;});
    await settle();
    expect(await page.$('.comment-emoji-menu')).not.toBeNull();
    expect(await page.$eval('.comment-emoji-menu',el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})).toBe(true);
    await page.click('.comment-emoji-menu .epr-tone[aria-pressed="true"]');
    await page.waitForFunction(()=>document.querySelector('.epr-skin-tones')!.getAnimations({subtree:true}).every(a=>a.playState!=="running"));
    await page.click('.comment-emoji-menu .epr-tone-1f3fd');
    await page.waitForSelector('.comment-emoji-menu .epr-tone-1f3fd[aria-pressed="true"]');
    await page.type('.comment-emoji-menu input', 'technologist');
    await page.waitForSelector('.comment-emoji-menu button[data-unified="1f469-1f3fd-200d-1f4bb"]');
    await page.click('.comment-emoji-menu button[data-unified="1f469-1f3fd-200d-1f4bb"]');
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.comment-reactions > button')).some(el=>el.textContent?.includes("👩🏽‍💻")));
    await page.click('.comment-reaction-picker');
    await page.click('.comment-emoji-menu button[aria-label="More emoji"]');
    await page.waitForSelector('.comment-emoji-menu .EmojiPickerReact');
    await page.screenshot({path:resolve("output/acceptance/comment-reaction-picker.png")});
    await page.keyboard.press("Escape");
    expect(await page.$(".comment-panel")).not.toBeNull();
    expect(await page.$(".comment-emoji-menu")).toBeNull();
    await page.evaluate(()=>{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{}}});});
    await page.click('button[aria-label="Copy link"]');
    await page.waitForSelector('.comment-notice[data-success="true"]');
    expect(await page.$eval('.comment-notice',el=>el.getBoundingClientRect().top)).toBeLessThan(60);
    await page.waitForFunction(()=>!document.querySelector('.comment-notice'),{timeout:4500});
    await page.setViewport({width:390,height:844});
    await settle();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector(".comment-panel")!).opacity === "1");
    await page.click('.comment-reaction-picker');
    await page.click('.comment-emoji-menu button[aria-label="More emoji"]');
    await page.waitForSelector('.comment-emoji-menu .EmojiPickerReact');
    expect(await page.$eval('.comment-emoji-menu',el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})).toBe(true);
    await page.screenshot({path:resolve("output/acceptance/comment-reactions-mobile.png")});
    expect(errors).toEqual([]);
  });

});
