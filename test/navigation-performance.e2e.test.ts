import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, HTTPRequest } from "puppeteer-core";
import { closeDbForTests, createId, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
const base = process.env.RBAC_E2E_URL;
let browser: Browser;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)(
  "navigation performance acceptance",
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
    });
    afterAll(async () => {
      await browser?.close();
      await closeDbForTests();
    });
    it("loads list previews without moving focus or changing rows, preserves complete menus and pagination", async () => {
      const user = await upsertUser({
        authProvider: "perf-e2e",
        providerSubject: createId("u"),
      });
      const { cookie } = await mintSession(new Request(base!), user.id);
      const pair = cookie.split(";")[0];
      const [name, ...value] = pair.split("=");
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`${base}/api/sites`, {
          method: "POST",
          headers: {
            cookie: pair,
            origin: base!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "paste",
            title: `Performance ${String(i).padStart(2, "0")}`,
            html: '<h1>Progressive preview content</h1><script>throw new Error("thumbnail executed")</script>',
          }),
        });
        const body = await res.json();
        expect(res.status, JSON.stringify(body)).toBe(200);
        if (i < 13) {
          const sharing = await fetch(`${base}/api/sites/${body.slug}/sharing`, {
            method:"PUT", headers:{cookie:pair,origin:base!,"content-type":"application/json"},
            body:JSON.stringify({visibility:"public"}),
          });
          expect(sharing.status,await sharing.text()).toBe(200);
        }
      }
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      await page.setCookie({ name, value: value.join("="), url: base! });
      await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
      const paths: string[] = [];
      const errors: string[] = [];
      page.on("request", (r) => paths.push(new URL(r.url()).pathname));
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${base}/me?sort=title`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".site-row .row-more", {visible:true});
      expect(await page.$$(".mini iframe")).toHaveLength(0);
      await page.focus('input[type="search"]');
      const rowBefore = await page.$eval('.site-row', e => ({width:e.clientWidth,height:e.clientHeight}));
      await page.waitForSelector('.mini [data-preview-state="ready"] iframe');
      expect(await page.$eval('input[type="search"]', e => e === document.activeElement)).toBe(true);
      expect(await page.$eval('.site-row', e => ({width:e.clientWidth,height:e.clientHeight}))).toEqual(rowBefore);
      const listFrame = await (await page.$('.mini [data-preview-state="ready"] iframe'))!.contentFrame();
      expect(await listFrame!.evaluate(() => document.body.innerText)).toContain('Progressive preview content');
      expect(await page.$$(".site-row")).toHaveLength(12);
      await page.click(".site-row .row-more");
      const menu = await page.$eval(
        '[role="menu"]:not([hidden])',
        (e) => e.textContent,
      );
      expect(menu).toContain("Download");
      expect(menu).toContain("Upload new version");
      expect(menu).toContain("Delete");
      expect(
        paths.filter(
          (p) =>
            p.includes("/permissions") ||
            p === "/api/me/sites" ||
            p === "/api/me/folders",
        ),
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        document
          .querySelector(".site-header")!
          .setAttribute("data-preserved", "yes");
      });
      await page.click('.site-header a[href="/for-agents"]');
      await page.waitForSelector(".guide");
      expect(await page.$("article.prose")).toBeNull();
      await page.click('.site-header a[href="/me"]');
      await page.waitForSelector(".site-row");
      expect(
        await page.$eval(".site-header", (e) =>
          e.getAttribute("data-preserved"),
        ),
      ).toBe("yes");
      const meRequests = paths.filter(p => p === "/me").length;
      await page.click('.site-header a[href="/for-agents"]');
      await page.waitForSelector(".guide");
      await page.click('.site-header a[href="/me"]');
      await page.waitForSelector(".site-row");
      expect(paths.filter(p => p === "/me")).toHaveLength(meRequests);
      await page.click('button[aria-label="Grid view"]');
      await page.waitForSelector(".result-grid .artifact-cover");
      expect(paths.filter(p => p === "/me")).toHaveLength(meRequests);
      await page.click('button[aria-label="List view"]');
      await page.waitForSelector(".site-row");
      await page.click('button[aria-label="Next"]');
      await page.waitForFunction(
        () => document.querySelectorAll(".site-row").length === 3,
      );
      expect(await page.$eval(".pager-current", (e) => e.textContent)).toBe(
        "2",
      );
      for (const folder of ["folder_deleted", ""]) {
        await page.goto(`${base}/me?${new URLSearchParams({folder,sort:"title"})}`, {waitUntil:"networkidle0"});
        expect(await page.$$(".site-row")).toHaveLength(12);
        await page.click('button[aria-label="Next"]');
        await page.waitForFunction(() => document.querySelectorAll(".site-row").length === 3);
        expect(await page.$eval(".pager-current", e => e.textContent)).toBe("2");
        expect(await page.$eval(".site-row", e => e.textContent)).toContain("Performance 12");
      }
      await page.type('input[type="search"]', "Performance 00");
      await page.waitForFunction(
        () => document.querySelectorAll(".site-row").length === 1,
      );
      expect(await page.$eval(".site-row", (e) => e.textContent)).toContain(
        "Performance 00",
      );
      expect(
        await page.$eval(
          'input[type="search"]',
          (e) => e === document.activeElement,
        ),
      ).toBe(true);
      for (const width of [390, 1440]) {
        await page.setViewport({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      paths.length = 0;
      await page.click('.site-header a[href="/explore"]');
      await page.waitForSelector(".result-grid", {visible:true});
      expect(await page.$$(".result-grid .artifact-card")).toHaveLength(12);
      expect(await page.$$("iframe")).toHaveLength(0);
      expect(paths.filter(p => p.includes("/permissions") || p.startsWith("/api/preview/"))).toEqual([]);
      expect(errors).toEqual([]);
      await mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/navigation-directory.png",
        fullPage: true,
      });
      await page.close();
    }, 120000);
    it("renders real sandboxed previews without stealing focus or changing card size", async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({width:1440,height:1000});
        await page.goto(`${base}/explore`, {waitUntil:"domcontentloaded"});
        await page.waitForSelector('.artifact-card', {visible:true});
        await page.focus('input[type="search"]');
        const before = await page.$eval('.preview', e => ({width:e.clientWidth,height:e.clientHeight}));
        await page.waitForSelector('[data-preview-state="ready"] iframe');
        expect(await page.$eval('input[type="search"]', e => e === document.activeElement), await page.evaluate(() => document.activeElement?.tagName)).toBe(true);
        expect(await page.$eval('.preview', e => ({width:e.clientWidth,height:e.clientHeight}))).toEqual(before);
        const iframe = await page.$('[data-preview-state="ready"] iframe');
        const frame = await iframe!.contentFrame();
        expect(await frame!.evaluate(() => document.body.innerText)).toContain('Progressive preview content');
        await mkdir('test-results', {recursive:true});
        await page.screenshot({path:'test-results/progressive-previews-desktop.png'});
        await page.setViewport({width:390,height:844});
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({path:'test-results/progressive-previews-mobile.png'});
      } finally { await page.close(); }
    });
    it("progressively loads visible card previews without blocking navigation", async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({width:390,height:650});
        await page.setRequestInterception(true);
        const held: HTTPRequest[] = [];
        page.on("request", request => {
          if (new URL(request.url()).pathname.startsWith("/api/preview/")) held.push(request);
          else void request.continue();
        });
        await page.goto(`${base}/explore`, {waitUntil:"domcontentloaded"});
        await page.waitForSelector(".artifact-card", {visible:true});
        expect(await page.$$(".preview iframe")).toHaveLength(0);
        await page.waitForFunction(() => document.querySelectorAll('.preview iframe').length === 1);
        await expect.poll(() => held.length).toBe(1);
        await page.focus('input[type="search"]');
        const frame = await page.$eval('.preview iframe', e => ({sandbox:e.getAttribute('sandbox'),inert:e.hasAttribute('inert'),tab:e.getAttribute('tabindex')}));
        expect(frame).toEqual({sandbox:"",inert:true,tab:"-1"});
        await held[0].respond({status:200,contentType:"text/html",body:'<h1>Preview loaded</h1><input autofocus><script>parent.postMessage("UNSAFE", "*")</script>'});
        await page.waitForSelector('[data-preview-state="ready"]');
        expect(await page.$eval('input[type="search"]', e => e === document.activeElement), await page.evaluate(() => document.activeElement?.tagName)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
        // Only viewport cards are eligible; scrolling admits a later card.
        await page.evaluate(() => document.querySelectorAll('.artifact-card')[5].scrollIntoView());
        await page.waitForSelector('.artifact-card:nth-child(6) [data-preview-state="loading"] iframe');
        await expect.poll(() => held.length).toBeGreaterThan(1);
        const slowSrc = await page.$eval('.artifact-card:nth-child(6) [data-preview-state="loading"] iframe', e => e.getAttribute('src'));
        await page.waitForFunction(src => !Array.from(document.querySelectorAll('.preview iframe')).some(e => e.getAttribute('src') === src), {timeout:15000}, slowSrc);
        await page.evaluate(() => document.querySelectorAll('.artifact-card')[9].scrollIntoView());
        await page.waitForSelector('[data-preview-state="loading"] iframe');
        await page.click('.site-header a[href="/for-agents"]');
        await page.waitForSelector('.guide');
        expect(await page.$$('.preview iframe')).toHaveLength(0);
        const count = held.length;
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1800)));
        expect(held).toHaveLength(count);
      } finally { await page.close(); }
    }, 45000);
    it("preserves search drafts across delayed responses and view/sort changes in both directories", async () => {
      const user = await upsertUser({authProvider:"perf-e2e",providerSubject:createId("search")});
      const {cookie} = await mintSession(new Request(base!), user.id);
      const [name, ...value] = cookie.split(";")[0].split("=");
      const page = await browser.newPage();
      await page.setCookie({name,value:value.join("="),url:base!});
      await page.setExtraHTTPHeaders({"accept-language":"en-US"});
      for (const route of ["/me", "/explore"]) {
        await page.goto(`${base}${route}`, {waitUntil:"networkidle0"});
        await page.waitForSelector('input[type="search"]');
        await page.setRequestInterception(true);
        let held: HTTPRequest | undefined;
        const intercept = (request: HTTPRequest) => {
          const url = new URL(request.url());
          if (url.pathname === route && url.searchParams.get("q") === "ab") held = request;
          else void request.continue();
        };
        page.on("request", intercept);
        await page.type('input[type="search"]', "ab");
        for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
        expect(held).toBeDefined();
        await page.type('input[type="search"]', "c ");
        const oldResponse = page.waitForResponse(response => response.request() === held);
        await held!.continue();
        await oldResponse;
        await page.waitForNetworkIdle();
        expect(await page.$eval('input[type="search"]', e => (e as HTMLInputElement).value)).toBe("abc ");
        await page.type('input[type="search"]', "d");
        if (route === "/me") await page.click('button[aria-label="Grid view"]');
        await page.select('select[aria-label="Sort"]', "title");
        await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "abc d");
        expect(await page.$eval('input[type="search"]', e => (e as HTMLInputElement).value)).toBe("abc d");
        await page.waitForNetworkIdle();
        page.off("request", intercept);
        await page.setRequestInterception(false);
      }
      await page.close();
    }, 60000);
    it("keeps local view changes when an already-sent search finishes without another list request", async () => {
      const user = await upsertUser({authProvider:"perf-e2e",providerSubject:createId("view")});
      const {cookie} = await mintSession(new Request(base!), user.id);
      const [name, ...value] = cookie.split(";")[0].split("=");
      const page = await browser.newPage();
      try {
        await page.setCookie({name,value:value.join("="),url:base!});
        await page.setExtraHTTPHeaders({"accept-language":"en-US"});
        await page.goto(`${base}/me`, {waitUntil:"networkidle0"});
        await page.waitForSelector('input[type="search"]');
        await page.setRequestInterception(true);
        let held: HTTPRequest | undefined;
        let requests = 0;
        const observed: string[] = [];
        page.on("framenavigated", frame => { if (frame === page.mainFrame()) observed.push(`navigate ${frame.url()}`); });
        page.on("request", request => {
          const url = new URL(request.url());
          if (url.pathname === "/me" && url.searchParams.has("q")) { observed.push(`request ${url}`); requests++; if (!held) held = request; else void request.continue(); }
          else void request.continue();
        });
        for (const view of ["grid", "list"]) {
          held = undefined;
          const before = requests;
          await page.type('input[type="search"]', view);
          for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
          expect(held).toBeDefined();
          const selector = `button[aria-label="${view === "grid" ? "Grid" : "List"} view"]`;
          await page.click(selector);
          await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-pressed") === "true", {}, selector);
          await page.evaluate(selector => {
            document.documentElement.dataset.viewReverted = "false";
            const button = document.querySelector(selector)!;
            const observer = new MutationObserver(records => {
              if (records.some(record => record.oldValue === "false") || button.getAttribute("aria-pressed") !== "true") {
                document.documentElement.dataset.viewReverted = "true";
              }
            });
            observer.observe(button, {attributes:true,attributeFilter:["aria-pressed"],attributeOldValue:true});
            Object.assign(window, {stopViewObserver: () => observer.disconnect()});
          }, selector);
          await held!.continue();
          await page.waitForFunction(view => {
            const params = new URL(location.href).searchParams;
            return params.get("view") === view && params.get("q")?.endsWith(view);
          }, {timeout:5000}, view).catch(async error => { throw new Error(`${error}: ${JSON.stringify({observed,url:page.url(),value:await page.$eval('input[type="search"]', e => (e as HTMLInputElement).value)})}`); });
          await page.waitForNetworkIdle();
          expect(requests - before).toBe(1);
          expect(await page.$eval(selector, e => e.getAttribute("aria-pressed"))).toBe("true");
          expect(await page.evaluate(() => document.documentElement.dataset.viewReverted)).toBe("false");
          await page.evaluate(() => (window as unknown as {stopViewObserver: () => void}).stopViewObserver());
        }
      } finally { await page.close(); }
    }, 60000);
    it("invalidates warm home and personal directories after upload and viewer copy", async () => {
      const user = await upsertUser({authProvider:"perf-e2e",providerSubject:createId("publish")});
      const {cookie} = await mintSession(new Request(base!), user.id);
      const [name, ...value] = cookie.split(";")[0].split("=");
      const page = await browser.newPage();
      const folder = await mkdtemp(join(tmpdir(), "navigation-upload-"));
      try {
        await page.setCookie({name,value:value.join("="),url:base!});
        await page.setExtraHTTPHeaders({"accept-language":"en-US"});
        await page.goto(`${base}/me`, {waitUntil:"networkidle0"});
        await page.click('.site-header a[href="/"]');
        await page.waitForSelector('.hero-upload input[type="file"]');
        const title = `Cache upload ${Date.now()}`;
        const file = join(folder, "index.html");
        await writeFile(file, `<html><title>${title}</title><body>New upload</body></html>`);
        const started = Date.now();
        const input = await page.$('.hero-upload input[type="file"]');
        await input!.uploadFile(file);
        await page.waitForSelector('dialog[open] .btn.solid');
        await page.click('dialog[open] .btn.solid');
        await page.waitForFunction(() => location.pathname.startsWith("/s/"));
        const originalPath = new URL(page.url()).pathname;
        await page.waitForSelector('a[aria-label="Back to sites"]');
        await page.click('a[aria-label="Back to sites"]');
        await page.waitForFunction(title => document.querySelector(".owned-shelf")?.textContent?.includes(title) || Array.from(document.querySelectorAll(".artifact-card")).some(e => e.textContent?.includes(title)), {}, title);
        await page.click('.site-header a[href="/me"]');
        await page.waitForSelector(".site-row");
        expect(await page.$$(".site-row")).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(30000);
        await page.click(`.site-row a[href="${originalPath}"]`);
        await page.waitForSelector('button[aria-label="More"]');
        await page.click('button[aria-label="More"]');
        const copied = Date.now();
        await page.evaluate(() => (Array.from(document.querySelectorAll('button[role="menuitem"]')).find(e => e.textContent?.trim() === "Save as new site") as HTMLButtonElement).click());
        await page.waitForFunction(original => location.pathname.startsWith("/s/") && location.pathname !== original, {}, originalPath);
        await page.waitForSelector('a[aria-label="Back to sites"]');
        await page.click('a[aria-label="Back to sites"]');
        await page.waitForSelector('.site-header a[href="/me"]');
        await page.click('.site-header a[href="/me"]');
        await page.waitForFunction(() => document.querySelectorAll(".site-row").length === 2);
        expect(Date.now() - copied).toBeLessThan(30000);
      } finally { await page.close(); await rm(folder, {recursive:true,force:true}); }
    }, 60000);
    it("validates a browser-only receipt on a direct public visit", async () => {
      const res = await fetch(`${base}/api/sites`, {
        method: "POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({mode:"paste",html:"<html><title>Receipt recovery</title><body>Hello</body></html>"}),
      });
      expect(res.status).toBe(200);
      const created = await res.json();
      // Explicitly publish this fixture; the reader has no server-side creator cookie.
      const visibility = await fetch(`${base}/api/sites/${created.slug}/sharing`, {
        method:"PUT", headers:{"x-edit-token":created.editToken,"content-type":"application/json"},
        body:JSON.stringify({visibility:"public"}),
      });
      expect(visibility.status).toBe(200);
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await page.evaluateOnNewDocument((slug, token) => localStorage.setItem(`sites:editToken:${slug}`, token), created.slug, created.editToken);
        await page.goto(`${base}/s/${created.slug}`,{waitUntil:"domcontentloaded"});
        await page.waitForSelector(`a[href^="/s/${created.slug}/edit"]`);
      } finally {
        await context.close();
      }
    });
  },
);
