import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { Browser, Page } from "puppeteer-core";
import { commentPreviewBootstrap } from "@/lib/comments/preview-bootstrap";

// Real opaque iframe: COMMENT_PREVIEW_E2E=1 npx vitest run test/comment-preview.e2e.test.ts
const enabled = process.env.COMMENT_PREVIEW_E2E === "1";
describe.skipIf(!enabled)("sandbox comment selection in Chrome", () => {
  let server: Server, browser: Browser, page: Page, origin: string;
  const channelId = "dc41869c-e1dd-46a2-93e1-7c58217737ae";
  const scope = { siteId: "site", versionId: "v1", entry: { kind: "main" } };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/frame") {
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html><head><base href="${origin}/">${commentPreviewBootstrap("index.html", origin)}</head><body style="margin:0"><a id="target" href="/navigated" style="display:block;margin:40px;width:240px;height:60px">Original\n   target</a><form><input value="PRIVATE_VALUE"><textarea>PRIVATE_FORM</textarea></form><div style="height:1200px"></div><canvas data-comment-page="2" data-comment-file="preview.pdf" data-comment-rotation="90" width="400" height="200" style="display:block;width:400px;height:200px;margin:20px"></canvas><img src="/pixel.svg" style="width:400px;height:400px;object-fit:contain"></body>`);
      } else if (req.url === "/pixel.svg") { res.setHeader("content-type", "image/svg+xml"); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/></svg>'); }
      else { res.setHeader("content-type", "text/html"); res.end('<iframe sandbox="allow-scripts" src="/frame" style="width:800px;height:600px;border:0"></iframe><script>window.events=[];addEventListener("message",e=>events.push(e.data));</script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage(); await page.goto(origin);
  }, 30000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function command(value: Record<string, unknown>) {
    await page.evaluate(payload => document.querySelector("iframe")!.contentWindow!.postMessage(payload, "*"), { protocol: "artifact-comments", schemaVersion: 1, channelId, scope, command: value });
  }
  async function next(type: string, from: number) {
    await page.waitForFunction((type, from) => (window as unknown as { events: { event?: { type: string } }[] }).events.slice(from).some(x => x.event?.type === type), {}, type, from);
    return page.evaluate((type, from) => (window as unknown as { events: { event?: { type: string; anchor?: unknown; outcome?: string } }[] }).events.slice(from).find(x => x.event?.type === type)!.event!, type, from);
  }
  async function count() { return page.evaluate(() => (window as unknown as { events: unknown[] }).events.length); }
  it("starts hidden, selects HTML without navigating, and excludes form values", async () => {
    await command({ type: "markers", markers: [], visible: false }); await next("ready", 0);
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    expect(await frame.$eval("[data-artifact-comment-overlay]", x => x.textContent)).toBe("");
    const at = await count(); await command({ type: "select" });
    const selectingFrame = page.frames().find(frame=>frame.url().endsWith("/frame"))!;
    await selectingFrame.waitForFunction(()=>getComputedStyle(document.querySelector("#target")!).cursor.includes("data:image/svg+xml")); await frame.click("#target");
    const event = await next("selected", at);
    expect(event.anchor).toMatchObject({ kind: "html", filePath: "index.html", quote: { exact: "Original target" } });
    expect(frame.url()).toBe(`${origin}/frame`);
    const locatedAt = await count(); await command({ type: "locate", threadId: "html", anchor: event.anchor });
    expect((await next("located", locatedAt)).outcome).toBe("exact");
    const at2 = await count(); await command({ type: "select" }); await frame.click("input");
    expect(JSON.stringify(await next("selected", at2))).not.toContain("PRIVATE_VALUE");
  });
  it("offers an authorized text-selection action, preserves quote context and excludes forms", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await command({type:"cancel"});
    const select = async (selector:string) => frame.$eval(selector,el=>{
      const range=document.createRange();range.selectNodeContents(el);
      const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);
    });
    await select("#target");
    await command({type:"text-selection",enabled:false,label:"Add comment"});
    expect(await frame.$("[data-comment-selection]")).toBeNull();
    await command({type:"text-selection",enabled:true,label:"Add comment"});
    await frame.waitForSelector("[data-comment-selection]");
    const at=await count();await frame.focus("[data-comment-selection]");await page.keyboard.press("Enter");
    const event=await next("text-selected",at);
    expect(event.anchor).toMatchObject({kind:"html",quote:{exact:"Original target",prefix:"",suffix:""}});
    const located=await count();await command({type:"locate",threadId:"text",anchor:event.anchor});
    expect((await next("located",located)).outcome).toBe("exact");
    await select("textarea");await command({type:"text-selection",enabled:true,label:"Add comment"});
    expect(await frame.$("[data-comment-selection]")).toBeNull();
    await command({type:"text-selection",enabled:false,label:""});
    await frame.evaluate(()=>getSelection()?.removeAllRanges());
  });
  it("locates selected words beyond the old excerpt limit and across inline nodes", async () => {
    const frame=page.frames().find(x=>x.url().endsWith("/frame"))!;
    await command({type:"cancel"});await command({type:"text-selection",enabled:true,label:"Add comment"});
    await frame.evaluate(()=>{
      const paragraph=document.createElement("p");paragraph.id="long-quote";
      paragraph.append(document.createTextNode("earlier ".repeat(310)));
      const span=document.createElement("span");span.textContent="chosen words";paragraph.append(span,document.createTextNode(" after"));
      document.body.prepend(paragraph);span.scrollIntoView();
      const range=document.createRange();range.setStart(span.firstChild!,0);range.setEnd(paragraph.lastChild!,6);
      getSelection()!.removeAllRanges();getSelection()!.addRange(range);
    });
    await frame.waitForSelector("[data-comment-selection]");
    const at=await count();await frame.click("[data-comment-selection]");const event=await next("text-selected",at);
    expect(event.anchor).toMatchObject({kind:"html",quote:{exact:"chosen words after",suffix:""}});
    const located=await count();await command({type:"locate",threadId:"long-quote",anchor:event.anchor});
    expect((await next("located",located)).outcome).toBe("exact");
    await command({type:"cancel"});await command({type:"text-selection",enabled:false,label:""});
    await frame.evaluate(()=>{document.querySelector("#long-quote")?.remove();scrollTo(0,0);});
  });
  it.each([
    ["paragraphs", "<p>foo</p><p>bar</p>", "foo bar"],
    ["inline divs", '<div style="display:inline">foo</div><div style="display:inline">bar</div>', "foobar"],
    ["block spans", '<span style="display:block">foo</span><span style="display:block">bar</span>', "foo bar"],
    ["line break", "line1<br>line2", "line1 line2"],
    ["disclosure", "<details open><summary>Heading</summary>Content</details>", "Heading Content"],
    ["excluded neighbours", "Click <button>private</button> to continue<i contenteditable>secret</i>", "to continue"],
  ])("relocates selections across %s with consistent context", async (_name, html, exact) => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await command({type:"cancel"});
    await frame.evaluate(html => {
      const el = document.createElement("div"); el.id = "review-selection"; el.innerHTML = html;
      el.style.margin = "50px"; document.body.prepend(el); el.scrollIntoView();
      const range = document.createRange();
      if (el.querySelector("button")) { range.setStart(el.childNodes[2],1); range.setEnd(el.childNodes[2],12); }
      else range.selectNodeContents(el);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    }, html);
    await command({type:"text-selection",enabled:true,label:"Add comment"});
    await frame.waitForSelector("[data-comment-selection]");
    const at = await count(); await frame.click("[data-comment-selection]");
    const event = await next("text-selected", at);
    expect(event.anchor).toMatchObject({kind:"html",quote:{exact}});
    expect(JSON.stringify(event.anchor)).not.toMatch(/private|secret/);
    if (_name === "excluded neighbours") expect(event.anchor).toMatchObject({quote:{prefix:"Click",suffix:""}});
    const located = await count(); await command({type:"locate",threadId:"review-selection",anchor:event.anchor});
    expect((await next("located",located)).outcome).toBe("exact");
    await command({type:"cancel"});await command({type:"text-selection",enabled:false,label:""});
    await frame.evaluate(()=>{document.querySelector("#review-selection")?.remove();scrollTo(0,0);});
  });
  it("keeps legacy element quotes compatible without weakening new selection quotes", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await command({type:"markers",markers:[],visible:false});await next("ready",0);
    await frame.evaluate(() => {
      const el=document.createElement("section");el.id="legacy";el.innerHTML="line1<br>line2";
      document.body.prepend(el);
    });
    const base={schemaVersion:1,kind:"html",filePath:"index.html",selector:"#legacy",viewport:{width:800,height:600}};
    for (const [quote,outcome] of [
      [{exact:"line1line2"},"exact"],
      [{exact:"line1line2",prefix:"",suffix:""},"missing"],
      [{exact:"line1 line2",prefix:"",suffix:""},"exact"],
      [{exact:"line 1line2"},"missing"],
    ] as const) {
      const at=await count();await command({type:"locate",threadId:"legacy",anchor:{...base,quote}});
      expect((await next("located",at)).outcome).toBe(outcome);
    }
    await command({type:"cancel"});await frame.evaluate(()=>document.querySelector("#legacy")?.remove());
  });
  it("bounds selection DOM comparisons and refreshes geometry after resizing", async () => {
    const frame=page.frames().find(x=>x.url().endsWith("/frame"))!;
    await command({type:"cancel"});
    await frame.evaluate(()=>{
      const el=document.createElement("p");el.id="bounded-selection";
      el.append(document.createTextNode("prefix ".repeat(9000)));
      const chosen=document.createElement("span");chosen.textContent="chosen";el.append(chosen,document.createTextNode(" words"));document.body.prepend(el);
      chosen.scrollIntoView({block:"center"});
      const state=window as unknown as {comparisons:number; restoreComparison:()=>void};state.comparisons=0;
      const original=Range.prototype.comparePoint;
      Range.prototype.comparePoint=function(node,offset){state.comparisons++;return original.call(this,node,offset);};
      state.restoreComparison=()=>{Range.prototype.comparePoint=original;};
      const range=document.createRange();range.setStart(chosen.firstChild!,0);range.setEnd(el.lastChild!,6);
      getSelection()!.removeAllRanges();getSelection()!.addRange(range);
    });
    await command({type:"text-selection",enabled:true,label:"Add comment"});await frame.waitForSelector("[data-comment-selection]");
    const initialComparisons=await frame.evaluate(()=>(window as unknown as {comparisons:number}).comparisons);
    expect(initialComparisons).toBeLessThan(100);
    await page.$eval("iframe",el=>el.style.width="700px");
    await frame.waitForFunction(()=>innerWidth===700);
    await frame.$eval("#bounded-selection span",el=>el.scrollIntoView({block:"center"}));
    await frame.waitForFunction(before=>(window as unknown as {comparisons:number}).comparisons>before,{},initialComparisons);
    await frame.waitForSelector("[data-comment-selection]");
    const at=await count();await frame.click("[data-comment-selection]");
    expect((await next("text-selected",at)).anchor).toMatchObject({viewport:{width:700},quote:{exact:"chosen words"}});
    await command({type:"cancel"});await command({type:"text-selection",enabled:false,label:""});
    await frame.evaluate(()=>{(window as unknown as {restoreComparison:()=>void}).restoreComparison();document.querySelector("#bounded-selection")?.remove();scrollTo(0,0);});
    await page.$eval("iframe",el=>el.style.width="800px");
  });
  it("captures PDF geometry after long scrolling, reverses page rotation and relocates", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await frame.$eval("canvas", el => el.scrollIntoView());
    const at = await count(); await command({ type: "select" });
    const canvas = await frame.$("canvas"); const box = (await canvas!.boundingBox())!;
    await page.mouse.click(box.x + 100, box.y + 100);
    const event = await next("selected", at);
    expect(event.anchor).toMatchObject({ kind: "pdf", page: 2, region: { kind: "point", point: { x: .5, y: .75 } } });
    const at2 = await count(); await command({ type: "locate", threadId: "thread", anchor: event.anchor });
    expect((await next("located", at2)).outcome).toBe("exact");
    await frame.$eval("canvas", el => (el as HTMLCanvasElement).style.width = "200px");
    await command({ type: "markers", markers: [{ threadId: "thread", anchor: event.anchor }], visible: true });
    await frame.waitForSelector("[data-artifact-comment-overlay] button");
  });
  it("uses intrinsic image bounds, supports drag regions and reports missing HTML", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await frame.$eval("img", el => el.scrollIntoView());
    const at = await count(); await command({ type: "select" });
    const img = (await (await frame.$("img"))!.boundingBox())!;
    await page.mouse.move(img.x + 80, img.y + 140); await page.mouse.down();
    await page.mouse.move(img.x + 240, img.y + 220, { steps: 5 }); await page.mouse.up();
    const event = await next("selected", at);
    expect(event.anchor).toMatchObject({ kind: "image", filePath: "pixel.svg", region: { kind: "rect", rect: { x: .2, y: .2 } } });
    const at2 = await count(); await command({ type: "locate", threadId: "missing", anchor: { schemaVersion: 1, kind: "html", filePath: "index.html", selector: "#not-here", viewport: { width: 800, height: 600 } } });
    expect((await next("located", at2)).outcome).toBe("missing");
  });
  it("opens a chooser for overlapping markers so every discussion remains reachable", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await frame.evaluate(() => scrollTo(0, 0));
    const anchor = { schemaVersion: 1, kind: "html", filePath: "index.html", selector: "#target", viewport: { width: 800, height: 600 } };
    await command({ type: "cancel" });
    await command({ type: "markers", visible: true, markers: [{ threadId: "first", anchor }, { threadId: "second", anchor }] });
    await frame.waitForFunction(() => document.querySelector("[data-artifact-comment-overlay] button")?.textContent === "2");
    let at = await count(); await frame.click("[data-artifact-comment-overlay] button");
    await frame.click("[data-comment-cluster] button:first-child");
    expect(await next("activated", at)).toMatchObject({ threadId: "first" });
    at = await count(); await frame.click("[data-artifact-comment-overlay] button");
    await frame.click("[data-comment-cluster] button:nth-child(2)");
    expect(await next("activated", at)).toMatchObject({ threadId: "second" });
  });

  it("keeps a large marker chooser open through scroll, DOM updates and marker refresh", async () => {
    const frame=page.frames().find(x=>x.url().endsWith("/frame"))!;
    await frame.evaluate(()=>scrollTo(0,0));
    const anchor={schemaVersion:1,kind:"html",filePath:"index.html",selector:"#target",viewport:{width:800,height:600}};
    const markers=Array.from({length:8},(_,i)=>({threadId:`cluster${i}`,anchor}));
    await command({type:"markers",visible:true,markers});
    await frame.waitForFunction(()=>document.querySelector("[data-artifact-comment-overlay] button")?.textContent==="8");
    await frame.click("[data-artifact-comment-overlay] button");
    await frame.evaluate(()=>{const menu=document.querySelector("[data-comment-cluster]")!;menu.scrollTop=menu.scrollHeight;menu.dispatchEvent(new Event("scroll",{bubbles:true}));document.body.dataset.tick="1";});
    await command({type:"markers",visible:true,markers});
    await frame.waitForFunction(()=>document.querySelectorAll("[data-comment-cluster] button").length===8);
    const at=await count();await frame.click("[data-comment-cluster] button:last-child");
    expect(await next("activated",at)).toMatchObject({threadId:"cluster7"});
    await frame.click("[data-artifact-comment-overlay] button");
    await frame.evaluate(()=>scrollTo(0,20));
    await frame.waitForFunction(()=>document.querySelector<HTMLElement>("[data-comment-cluster]")?.style.top==="20px");
    await frame.evaluate(()=>scrollTo(0,300));
    await frame.waitForFunction(()=>!document.querySelector("[data-comment-cluster]"));
    await frame.evaluate(()=>scrollTo(0,0));await frame.waitForSelector("[data-artifact-comment-overlay] button");
    await frame.click("[data-artifact-comment-overlay] button");await command({type:"select"});
    await frame.waitForFunction(()=>!document.querySelector("[data-comment-cluster]"));
    await command({type:"cancel"});
  });

  it("reuses verified HTML targets for geometry-only repaints and invalidates changed text", async () => {
    const frame = page.frames().find(x => x.url().endsWith("/frame"))!;
    await frame.evaluate(() => {
      const state = window as unknown as { commentTextScans: number };
      state.commentTextScans = 0;
      const scan = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => { state.commentTextScans++; return scan(...args); };
    });
    await command({ type: "cancel" });
    const anchor = { schemaVersion: 1, kind: "html", filePath: "index.html", selector: "html>body:nth-of-type(1)>a:nth-of-type(1)", quote: { exact: "Original" }, viewport: { width: 800, height: 600 } };
    await command({ type: "markers", visible: true, markers: [{ threadId: "cache", anchor }] });
    await frame.waitForSelector("[data-artifact-comment-overlay] button");
    const readScans = () => frame.evaluate(() => (window as unknown as { commentTextScans: number }).commentTextScans);
    await frame.waitForFunction(() => (window as unknown as { commentTextScans: number }).commentTextScans > 0);
    const before = await readScans();
    await frame.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        window.scrollTo(0,i);
        window.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
      }
    });
    expect(await readScans()).toBe(before);
    await frame.evaluate(() => { document.querySelector("#target")!.firstChild!.textContent = "Changed target"; });
    await frame.waitForFunction(() => !document.querySelector("[data-artifact-comment-overlay] button"));
    expect(await readScans()).toBeGreaterThan(before);
    await frame.evaluate(() => document.querySelector("#target")!.setAttribute("data-review", "one"));
    await command({ type: "markers", visible: true, markers: [{ threadId: "arbitrary", anchor: { ...anchor, selector: 'a[data-review="one"]', quote: { exact: "Changed target" } } }] });
    await frame.waitForSelector("[data-artifact-comment-overlay] button");
    await frame.evaluate(() => document.querySelector("#target")!.setAttribute("data-review", "two"));
    await frame.waitForFunction(() => !document.querySelector("[data-artifact-comment-overlay] button"));
  });

  it("keeps selection active when markers are hidden", async()=>{
    const frame=page.frames().find(x=>x.url().endsWith("/frame"))!;
    await frame.evaluate(()=>scrollTo(0,0));
    await command({type:"markers",visible:true,markers:[]});
    await command({type:"select"});
    await command({type:"markers",visible:false,markers:[]});
    await frame.waitForFunction(()=>document.documentElement.hasAttribute("data-artifact-comment-select"));
    const at=await count();
    await frame.click("#target");
    expect((await next("selected",at)).anchor).toMatchObject({kind:"html"});
  });
  it("hides every marker immediately and fades a hidden location without restoring markers", async () => {
    const frame=page.frames().find(x=>x.url().endsWith("/frame"))!;
    const anchor={schemaVersion:1,kind:"html",filePath:"index.html",selector:"#target",viewport:{width:800,height:600}};
    await frame.evaluate(()=>scrollTo(0,0));
    await command({type:"markers",visible:true,markers:[{threadId:"fade",anchor}]});
    await command({type:"locate",threadId:"fade",anchor});
    await frame.waitForSelector('[data-comment-thread="fade"]');
    await command({type:"markers",visible:false,markers:[{threadId:"fade",anchor}]});
    await frame.waitForFunction(()=>!document.querySelector('[data-comment-thread]'));
    await command({type:"locate",threadId:"fade",anchor});
    await frame.waitForSelector('[data-comment-thread="fade"]');
    await frame.waitForFunction(()=>{const pin=document.querySelector<HTMLElement>('[data-comment-thread="fade"]');return pin && Number(getComputedStyle(pin).opacity)<0.8 && Number(getComputedStyle(pin).opacity)>0;});
    await frame.waitForFunction(()=>!document.querySelector('[data-comment-thread]'));
    expect(await frame.$eval('[data-artifact-comment-overlay] > div',el=>(el as HTMLElement).style.display)).toBe("none");
  });

});
