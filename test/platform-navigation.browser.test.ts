import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { PREVIEW_SANDBOX_CSP } from "@/lib/preview";
import { previewNavigationBootstrap } from "@/lib/preview-navigation";
import type { CommentThreadDetail } from "@/lib/comments/contracts";
import { shareDiscussionUrl } from "@/components/share-model";

const token = "a".repeat(32);
function discussion(shared: boolean): CommentThreadDetail {
  return {
    space: { id: "space_1", siteId: "fixture", versionId: "ver_1", entry: shared ? { kind: "share", shareId: "share_1" } : { kind: "main" }, createdAt: 1 },
    thread: { id: "thread_1", spaceId: "space_1", createdBy: "reader", anchor: { schemaVersion: 1, kind: "document", filePath: "index.html" }, context: { schemaVersion: 1, excerpt: null, originalFilePath: null, rendition: null, assetIds: [] }, resolution: { status: "open" }, revision: 1, createdAt: 1, updatedAt: 1 },
    messages: { items: ["root_1", "msg_1"].map((id, index) => ({ id, threadId: "thread_1", authorUserId: "reader", authorDisplayName: "Reader", isRoot: index === 0, content: { state: "visible", body: index === 0 ? "Review this report" : "Linked reply evidence" }, reactions: [], revision: 1, createdAt: index + 1, editedAt: null })), total: 2, nextCursor: null },
    permissions: { canReply: true, canResolve: true, canReopen: false, messages: {} },
  };
}
describe.skipIf(!process.env.E2E_CHROME)("platform links from opaque previews", () => {
  let browser: Browser, server: Server, origin: string;
  const apiRequests: Array<{ path: string; origin?: string; cookie?: string }> = [];
  beforeAll(async () => {
    const bundles = new Map<string, string>();
    for (const mount of ["", "/artifact-site"]) {
      const output = await build({ configFile: false, logLevel: "silent",
        resolve: { alias: { "next/navigation": path.resolve("test/fixtures/auth-recovery-router.ts"), "@": path.resolve("src") } },
        define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": JSON.stringify({ NEXT_PUBLIC_ARTIFACT_BASE_PATH: mount }) },
        build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/platform-navigation-browser.tsx"), name: "PlatformNavigationFixture", formats: ["iife"] } },
      });
      const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
      bundles.set(mount, bundle.output.find(item => item.type === "chunk")!.code!);
    }
    server = createServer((req, res) => {
      const url = new URL(req.url!, origin), mount = url.pathname.startsWith("/artifact-site/") ? "/artifact-site" : "";
      const route = url.pathname.slice(mount.length);
      res.setHeader("cache-control", "no-store");
      if (route === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(bundles.get(mount)); return; }
      if (route.startsWith("/api/preview/")) {
        res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", PREVIEW_SANDBOX_CSP);
        res.end(`<base href="${origin}${mount}/api/preview/fixture/"><script>addEventListener('message',e=>{if(e.data?.type==='artifact:platform-navigation-enabled')document.documentElement.dataset.ready='yes'})</script>
          ${url.searchParams.has("raw") ? "" : previewNavigationBootstrap(mount)}
          <a id="collection" target="_blank" href="${mount}/c/${token}">All reports</a><a id="local" href="#section">Local</a><h2 id="section">Section</h2>`); return;
      }
      if (route.startsWith("/api/")) {
        apiRequests.push({ path: url.pathname, origin: req.headers.origin, cookie: req.headers.cookie });
        const signedIn = req.headers.cookie?.includes("fixture_session=active");
        res.setHeader("content-type", "application/json");
        if (route.startsWith("/api/sites/fixture/")) {
          const endpoint = route.slice("/api/sites/fixture/".length);
          const detail = discussion(Boolean(req.headers["x-artifact-share"]));
          const body = endpoint === "comments/permissions" ? { canRead: true, canCreate: true, canReply: true, canAggregate: false, canReadVersions: true, userId: "reader", isAuthenticated: true, draftsEnabled: false }
            : endpoint === "comments/options" ? { versions: [], shares: [], authors: [] }
            : endpoint === "comments" ? { items: [detail], total: 1, nextCursor: null }
            : endpoint === "comments/thread_1" ? detail
            : endpoint === "likes" ? { count: 0, liked: false }
            : { initialized: true, since: 1, snapshotAt: 1, hasMore: false, messages: [] };
          res.end(JSON.stringify(body));
        }
        else if (route === "/api/auth/me") res.end(JSON.stringify({ user: signedIn ? { id: "reader", displayName: "Reader", email: null, avatarUrl: null } : null, oidcEnabled: true }));
        else if (route.startsWith("/api/collections/")) res.end(JSON.stringify({ state: signedIn ? "ready" : "needsLogin", name: "Report collection", owner: "Author", items: signedIn ? Array.from({ length: 33 }, (_, i) => ({ slug: `report-${i}`, title: `Report ${i}`, folderId: null, tenantName: "", updatedAt: 0, comments: false })) : [] }));
        else res.end(JSON.stringify({ hasUnread: false }));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<div id="root"></div><script src="${mount}/bundle.js"></script>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function open(mount: string, query = "") {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await context.setCookie({ name: "fixture_session", value: "active", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" });
    await page.goto(`${origin}${mount}/host${query}`);
    const frame = (await (await page.waitForSelector("iframe"))!.contentFrame())!;
    await frame.waitForSelector("#collection");
    if (!query.includes("raw")) await frame.waitForFunction(() => document.documentElement.dataset.ready === "yes", { timeout: 5000 });
    return { context, page, frame };
  }
  async function signedInCollection(page: Page) {
    await page.waitForSelector(".avatar", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".collection-heading")?.textContent?.includes("33 accessible documents"), { timeout: 5000 });
    expect(await page.evaluate(() => ({ origin: window.origin, opener: window.opener !== null }))).toEqual({ origin, opener: false });
    expect(await page.$('[role="alert"]')).toBeNull();
  }

  it("reproduces the original inherited-sandbox failure, including reload", async () => {
    const { context, frame } = await open("/artifact-site", "?raw=1");
    try {
      const target = context.waitForTarget(t => t.url() === `${origin}/artifact-site/c/${token}`);
      await frame.click("#collection"); const popup = (await (await target).page())!;
      for (let i = 0; i < 2; i++) {
        await popup.waitForSelector('[role="alert"]', { timeout: 5000 });
        expect(await popup.evaluate(() => window.origin)).toBe("null");
        expect(await popup.$eval('body', el => el.textContent)).toContain("Could not load this collection.");
        if (i === 0) await popup.reload();
      }
      const fresh = await context.newPage(); await fresh.goto(`${origin}/artifact-site/c/${token}`);
      await signedInCollection(fresh);
    } finally { await context.close(); }
  });

  for (const mount of ["", "/artifact-site"]) {
    it.each(["blank", "self", "middle", "modifier", "presentation", "share", "stop-click", "stop-auxclick", "stop-capture", "stop-bubble"])(`keeps login and collection loading outside the sandbox (${mount || "root"}, %s)`, async gesture => {
      const { context, page, frame } = await open(mount, ["presentation", "share"].includes(gesture) ? `?${gesture}=1` : "");
      try {
        apiRequests.length = 0;
        if (["self", "middle", "modifier"].includes(gesture)) await frame.$eval("#collection", el => el.setAttribute("target", "_self"));
        if (gesture.startsWith("stop-")) await frame.$eval("#collection", (el, gesture) => {
          const node = ["stop-capture", "stop-bubble"].includes(gesture) ? el.parentElement! : el;
          node.addEventListener(gesture === "stop-auxclick" ? "auxclick" : "click", event => event.stopPropagation(), gesture === "stop-capture");
        }, gesture);
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        if (gesture === "modifier") await page.keyboard.down(modifier);
        await frame.click("#collection", { button: ["middle", "stop-auxclick"].includes(gesture) ? "middle" : "left" });
        if (gesture === "modifier") await page.keyboard.up(modifier);
        await page.waitForSelector("dialog[open]", { timeout: 5000 });
        expect(await context.pages()).toHaveLength(1);
        expect(apiRequests.filter(r => r.path.endsWith(`/api/collections/${token}`))).toEqual([]);
        let destination: Page;
        if (gesture === "self") {
          await Promise.all([page.waitForNavigation(), page.click('dialog button[type="submit"]')]); destination = page;
        } else {
          const target = context.waitForTarget(t => t.url() === `${origin}${mount}/c/${token}`);
          await page.click('dialog button[type="submit"]'); destination = (await (await target).page())!;
        }
        await signedInCollection(destination);
        await destination.reload(); await signedInCollection(destination);
        const reads = apiRequests.filter(r => r.path.endsWith("/api/auth/me") || r.path.endsWith(`/api/collections/${token}`));
        expect(reads.length).toBeGreaterThanOrEqual(4);
        expect(reads.every(r => r.origin !== "null" && r.cookie?.includes("fixture_session=active"))).toBe(true);
        if (gesture !== "self") {
          expect(await frame.evaluate(() => window.origin)).toBe("null");
          expect(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
          expect(await page.$eval("iframe", el => el.getAttribute("sandbox"))).not.toMatch(/allow-same-origin|allow-popups-to-escape-sandbox/);
        }
      } finally { await context.close(); }
    });
    it.each(["click", "auxclick", "capture"])(`respects cancellation after propagation stops (${mount || "root"}, %s)`, async kind => {
      const { context, page, frame } = await open(mount);
      try {
        await frame.$eval("#collection", (el, kind) => {
          const node = kind === "capture" ? el.parentElement! : el;
          const type = kind === "auxclick" ? "auxclick" : "click", capture = kind === "capture";
          node.addEventListener(type, event => event.stopPropagation(), capture);
          node.addEventListener(type, event => event.preventDefault(), capture);
        }, kind);
        await frame.click("#collection", { button: kind === "auxclick" ? "middle" : "left" });
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
        expect(await context.pages()).toHaveLength(1);
        expect(await page.$("dialog[open]")).toBeNull();
        expect(page.url()).toBe(`${origin}${mount}/host`);
      } finally { await context.close(); }
    });
    it(`opens platform-generated discussion links with the sidebar visible (${mount || "root"})`, async () => {
      const { context, page, frame } = await open(mount);
      try {
        const href = shareDiscussionUrl(`${origin}${mount}/v/share_1`);
        await frame.$eval("#collection", (el, href) => el.setAttribute("href", href), href);
        await frame.click("#collection"); await page.waitForSelector("dialog[open]", { timeout: 5000 });
        const target = context.waitForTarget(t => t.url().startsWith(`${origin}${mount}/v/share_1`));
        await page.click('dialog button[type="submit"]'); const destination = (await (await target).page())!;
        await destination.waitForSelector('.comment-panel .comment-summary[data-thread-id="thread_1"]', { visible: true, timeout: 5000 });
        expect(destination.url()).toBe(href);
        expect(await destination.evaluate(() => window.origin)).toBe(origin);
      } finally { await context.close(); }
    });
    it.each(["/s/report_1?version=ver_1&message=msg_1&comments=all#comment=thread_1", "/v/share_1?thread=thread_1&message=msg_1&comments=all"])(`opens the linked discussion and reply in the real viewer (${mount || "root"}, %s)`, async route => {
      const { context, page, frame } = await open(mount);
      try {
        await frame.$eval("#collection", (el, href) => el.setAttribute("href", href), mount + route);
        await frame.click("#collection"); await page.waitForSelector("dialog[open]", { timeout: 5000 });
        const target = context.waitForTarget(t => t.url().startsWith(origin + mount + route.split("?")[0]));
        await page.click('dialog button[type="submit"]'); const destination = (await (await target).page())!;
        await destination.waitForSelector('.comment-panel .comment-conversation [data-message-id="msg_1"]', { timeout: 5000 });
        expect(await destination.$eval('[data-message-id="msg_1"]', el => el.textContent)).toContain("Linked reply evidence");
        const url = new URL(destination.url());
        expect(url.searchParams.get("message")).toBe("msg_1");
        expect(url.searchParams.get("comments")).toBe("all");
        expect(url.hash).toBe(new URL(route, origin).hash);
        if (route.startsWith("/v/")) expect(url.searchParams.get("thread")).toBe("thread_1");
        expect(await destination.evaluate(() => window.origin)).toBe(origin);
      } finally { await context.close(); }
    });
    it.each([`/s/report_1?version=ver_1&collection=${token}&presentation=1`, "/v/share_1?version=ver_2"])(`preserves artifact view parameters (${mount || "root"}, %s)`, async route => {
      const { context, page, frame } = await open(mount);
      try {
        await frame.$eval("#collection", (el, href) => el.setAttribute("href", href), mount + route);
        await frame.click("#collection"); await page.waitForSelector("dialog[open]", { timeout: 5000 });
        const target = context.waitForTarget(t => t.url() === origin + mount + route);
        await page.click('dialog button[type="submit"]'); const destination = (await (await target).page())!;
        await destination.waitForSelector(".avatar", { timeout: 5000 });
        expect(await destination.evaluate(() => window.origin)).toBe(origin);
        expect(destination.url()).toBe(origin + mount + route);
      } finally { await context.close(); }
    });
  }
  it("rejects forged senders and unsafe destinations, and cancellation opens nothing", async () => {
    const { context, page, frame } = await open("/artifact-site");
    try {
      await page.evaluate(token => window.postMessage({ type: "artifact:platform-navigation", path: `/c/${token}`, newTab: true }, "*"), token);
      await page.evaluate(token => new Promise<void>(resolve => {
        const sibling = document.createElement("iframe");
        sibling.sandbox.add("allow-scripts");
        sibling.srcdoc = `<script>parent.postMessage({type:'artifact:platform-navigation',path:'/c/${token}',newTab:true},'*')</script>`;
        sibling.onload = () => resolve(); document.body.append(sibling);
      }), token);
      await frame.evaluate(() => {
        for (const path of ["/api/auth/logout", "//evil.example", "/s/site/edit", "/c/%2e%2e"]) parent.postMessage({ type: "artifact:platform-navigation", path, newTab: true }, "*");
      });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
      expect(await page.$("dialog[open]")).toBeNull();
      await frame.click("#collection"); await page.waitForSelector("dialog[open]", { timeout: 5000 });
      await page.keyboard.press("Escape");
      expect(await context.pages()).toHaveLength(1); expect(page.url()).toBe(`${origin}/artifact-site/host`);
      expect(await frame.evaluate(async () => { try { await fetch('/artifact-site/api/auth/me'); return true; } catch { return false; } })).toBe(false);
    } finally { await context.close(); }
  });
});
