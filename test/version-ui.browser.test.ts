import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSite, listVersions } from "@/lib/sites";
import { closeDbForTests } from "@/lib/db";
import { GET, POST } from "@/app/api/sites/[slug]/versions/route";
import { GET as me } from "@/app/api/auth/me/route";

describe.skipIf(!process.env.E2E_CHROME)("version upload browser acceptance", () => {
  let browser: Browser, page: Page, server: Server, base: string, slug: string, token: string, dir: string;
  let conflict = false, loseResponse = false, rejectStatus = 0;
  const postKeys: string[] = [];
  let releaseAuth: (() => void) | undefined, delayedAuth = false;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "version-ui-")); writeFileSync(path.join(dir, "new.html"), "<h1>New report</h1>");
    const site = await createSite({ mode: "paste", html: "<h1>Original</h1>" }); slug = site.site.slug; token = site.site.editToken;
    const output = await build({ configFile: false, logLevel: "silent", resolve: { alias: { "next/navigation": path.resolve("test/fixtures/feedback-router.ts"), "@": path.resolve("src") } }, define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": "{}" }, build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/version-ui.tsx"), name: "VersionUI", formats: ["iife"] } } });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(i => i.type === "chunk")!.code!;
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (url.pathname === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(code); return; }
        if (url.pathname === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/app/globals.css")); return; }
        if (url.pathname.startsWith("/api/")) {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const headers = new Headers(); for (const [k,v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k,v);
          const request = new Request(url, { method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
          if (req.method === "POST") postKeys.push(headers.get("idempotency-key")!);
          if (rejectStatus && req.method === "POST") { const status = rejectStatus; rejectStatus = 0; res.writeHead(status, { "content-type": "application/json" }); res.end('{"error":"Rejected file"}'); return; }
          if (conflict && req.method === "POST") { conflict = false; res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ currentVersionId: "newer" })); return; }
          if (url.pathname === "/api/auth/me" && delayedAuth) {
            await new Promise<void>(resolve => { releaseAuth = resolve; });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ user: { id: "delayed-user" }, oidcEnabled: true })); return;
          }
          const result = url.pathname === "/api/auth/me" ? await me(request) : await (req.method === "POST" ? POST : GET)(request, { params: Promise.resolve({ slug }) });
          if (loseResponse && req.method === "POST" && result.ok) { loseResponse = false; res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":"Response interrupted"}'); return; }
          res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return;
        }
        res.setHeader("content-type", "text/html"); res.end('<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
      } catch (e) { console.error(e); res.statusCode = 500; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve)); base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: ["--host-resolver-rules=MAP version-ui.test 127.0.0.1", "--no-proxy-server", ...(process.env.CI ? ["--no-sandbox"] : [])] }); page = await browser.newPage(); page.on("pageerror", e => console.error("BROWSER", e));
    await page.setCookie({ name: "ah_anon", value: "version-ui-browser", url: base });
  },60000);
  beforeEach(async () => { conflict = false; loseResponse = false; rejectStatus = 0; delayedAuth = false; postKeys.length = 0; await page.goto(`${base}/?slug=${slug}&token=${token}`); await page.waitForSelector("#upload"); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await closeDbForTests(); if (dir) rmSync(dir,{recursive:true,force:true}); });
  async function pick() { await page.click("#upload"); await page.waitForSelector("dialog[open]"); await (await page.$('input[type="file"]'))!.uploadFile(path.join(dir,"new.html")); }
  async function publish() { await page.waitForSelector("dialog footer .solid:not(:disabled)"); await page.click("dialog footer .solid"); }
  it("preserves history and avoids duplicate versions after a lost response", async () => {
    const before = (await listVersions(slug))!; loseResponse = true;
    await pick(); await publish(); await page.waitForSelector('dialog [role="alert"]');
    expect((await listVersions(slug))!.length).toBe(before.length+1);
    expect(await page.$eval(".version-file-picker button", el => (el as HTMLButtonElement).disabled)).toBe(true);
    await publish(); await page.waitForFunction(() => document.body.dataset.published === "true");
    expect((await listVersions(slug))!.length).toBe(before.length+1);
    expect((await listVersions(slug))!.some(v => v.id === before[0].id)).toBe(true);
    expect((await listVersions(slug))!.some(v => v.official)).toBe(false);
    expect(postKeys[1]).toBe(postKeys[0]);
  });
  it("uploads on a non-secure HTTP origin without randomUUID", async () => {
    const errors: string[] = [];
    const onError = (e: unknown) => { errors.push(e instanceof Error ? e.message : String(e)); };
    page.on("pageerror", onError);
    try {
      const insecureBase = base.replace("127.0.0.1", "version-ui.test");
      await page.setCookie({ name: "ah_anon", value: "version-ui-browser", url: insecureBase });
      await page.goto(`${insecureBase}/?slug=${slug}&token=${token}`);
      expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: "undefined" });
      await pick(); await publish();
      await page.waitForFunction(() => document.body.dataset.published === "true" || document.querySelector('dialog [role="alert"]'));
      expect(await page.evaluate(() => ({ published: document.body.dataset.published, error: document.querySelector('dialog [role="alert"]')?.textContent }))).toEqual({ published: "true" });
      expect(errors).toEqual([]);
    } finally { page.off("pageerror", onError); }
  });
  it.each([400, 413, 415, 422])("allows replacement after a definitive %i rejection with a new operation key", async status => {
    rejectStatus = status;
    const before = (await listVersions(slug))!.length;
    await pick(); await publish(); await page.waitForSelector('dialog [role="alert"]');
    expect(await page.$eval(".version-file-picker button", el => (el as HTMLButtonElement).disabled)).toBe(false);
    expect(await page.$eval('dialog input[type="checkbox"]', el => (el as HTMLInputElement).disabled)).toBe(false);
    const replacement = path.join(dir, "replacement.html"); writeFileSync(replacement, "<h1>Corrected report</h1>");
    await (await page.$('input[type="file"]'))!.uploadFile(replacement);
    await page.click('dialog input[type="checkbox"]'); await publish();
    await page.waitForFunction(() => document.body.dataset.published === "true");
    expect((await listVersions(slug))!.length).toBe(before + 1);
    expect(postKeys[1]).not.toBe(postKeys[0]);
  });
  it("requires explicit conflict acknowledgement and fits a mobile viewport", async () => {
    await page.setViewport({width:390,height:844}); conflict = true; await pick(); await publish();
    await page.waitForSelector('dialog [role="alert"]');
    expect(await page.$eval("dialog footer .solid", el => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval("dialog", el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
    await page.click('dialog [role="alert"] button'); await page.waitForFunction(() => !(document.querySelector("dialog footer .solid") as HTMLButtonElement).disabled);
    await publish(); await page.waitForFunction(() => document.body.dataset.published === "true");
  });
  it("retains learning before auth resolves under the account key with a stable callback", async () => {
    delayedAuth = true;
    try {
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(`${base}/?slug=${slug}&token=${token}`);
      await page.waitForSelector("#learn"); await page.click("#learn");
      expect(await page.evaluate(() => localStorage.getItem("artifact:hint:browser:test"))).toBeNull();
      expect(releaseAuth).toBeDefined(); releaseAuth!();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("artifact:hint:delayed-user:test") ?? "null")?.learned === true);
      expect(await page.evaluate(() => document.body.dataset.stableLearn)).toBe("true");
      expect(await page.evaluate(() => localStorage.getItem("artifact:hint:browser:test"))).toBeNull();
      expect(await page.$(".coachmark")).toBeNull();
    } finally { releaseAuth?.(); releaseAuth = undefined; delayedAuth = false; }
  });
  it("only renders an interactive visibility chip when a contextual action exists", async () => {
    expect(await page.$eval(".vis-unlisted", el => el.tagName)).toBe("SPAN");
    expect(await page.$eval(".vis-private", el => el.tagName)).toBe("BUTTON");
  });
  it("auto-dismisses teaching but keeps explicitly opened guidance available", async () => {
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await page.reload();
    await page.waitForSelector(".coachmark"); await page.hover(".coachmark");
    await new Promise(resolve => setTimeout(resolve,1200)); expect(await page.$(".coachmark")).not.toBeNull();
    await page.mouse.move(600,600); await page.waitForFunction(() => !document.querySelector(".coachmark"), {timeout:4000});
    await page.click("#hint"); await page.waitForSelector(".coachmark");
    await new Promise(resolve => setTimeout(resolve,1200)); expect(await page.$(".coachmark")).not.toBeNull();
    await page.click(".coachmark button"); await page.reload();
    await page.waitForSelector("#hint"); expect(await page.$(".coachmark")).toBeNull();
  });
});
