import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSite } from "@/lib/sites";
import { closeDbForTests } from "@/lib/db";
import { GET as preview } from "@/app/api/preview/[slug]/[[...path]]/route";
import { buildPdf } from "./fixtures/feedback-pdf";

// Real Chromium exercises opaque origins, PDF rendering and modal focus; no deployed service needed.
describe.skipIf(!process.env.E2E_CHROME)("artifact feedback browser regressions", () => {
  let browser: Browser, page: Page, server: Server, base: string, slug: string;
  let deletes = 0;
  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/sync-pdfjs.mjs"], { stdio: "pipe" });
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
    const site = await createSite({ mode: "folder", files: [
      { relpath: "index.html", bytes: new TextEncoder().encode('<html><body><a id="home" href="/">Library</a><a id="pdf" href="docs/报告.pdf">PDF</a></body></html>') },
      { relpath: "docs/报告.pdf", bytes: buildPdf(1) },
    ] }); slug = site.site.slug;
    const output = await build({ configFile: false, logLevel: "silent", resolve: { alias: { "next/navigation": path.resolve("test/fixtures/feedback-router.ts"), "@": path.resolve("src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/feedback-browser.tsx"), name: "FeedbackFixture", formats: ["iife"] } },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, base);
        if (url.pathname === "/bundle.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(code); return; }
        if (url.pathname === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/app/globals.css")); return; }
        if (url.pathname.startsWith("/vendor/pdfjs/")) {
          res.setHeader("access-control-allow-origin", "*"); res.setHeader("content-type", url.pathname.endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
          res.end(readFileSync(path.join("public", url.pathname))); return;
        }
        if (url.pathname.startsWith("/api/preview/")) {
          const [, , , segment, ...file] = url.pathname.split("/");
          const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
          const result = await preview(new Request(url, { headers }), { params: Promise.resolve({ slug: segment, path: file.filter(Boolean).map(decodeURIComponent) }) });
          res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return;
        }
        if (url.pathname === "/api/sites/fixture" && req.method === "DELETE") {
          deletes++; await new Promise(resolve => setTimeout(resolve, 150));
          res.writeHead(deletes === 1 ? 500 : 200, { "content-type": "application/json" }); res.end("{}"); return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        if (url.pathname === "/") { res.end(`<h1>${req.headers.cookie?.includes("fixture_session=active") ? "Signed in" : "Signed out"}</h1>`); return; }
        res.end('<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
      } catch (error) { console.error(error); res.statusCode = 500; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    page = await browser.newPage();
    await page.setCookie({ name: "fixture_session", value: "active", url: base, httpOnly: true, sameSite: "Lax" });
  }, 60000);
  beforeEach(async () => {
    deletes = 0;
    await page.setViewport({ width: 800, height: 800 });
    await page.goto(`${base}/fixture?preview=${encodeURIComponent(`/api/preview/${slug}/`)}`);
    await page.waitForSelector("#delete");
  });
  afterAll(async () => {
    await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await closeDbForTests(); delete process.env.ARTIFACT_DEFAULT_VISIBILITY;
  });
  const artifact = async () => {
    const frame = await (await page.waitForSelector("iframe"))!.contentFrame();
    await frame!.waitForSelector("#home"); return frame!;
  };
  it("cancels deletion without requests and keeps failures retryable", async () => {
    await page.click("#delete"); await page.waitForSelector("dialog[open]");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Cancel");
    await page.keyboard.press("Escape"); expect(deletes).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("delete");
    await page.setViewport({ width: 360, height: 780 });
    await page.click("#delete"); await page.waitForSelector("dialog[open]");
    expect(await page.$eval("dialog", el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(360);
    await page.click('dialog button[type="submit"]');
    await page.waitForSelector('dialog [role="alert"]'); expect(deletes).toBe(1);
    await page.click('dialog button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector("dialog[open]")); expect(deletes).toBe(2);
  });
  it("keeps a forced-closed pending dialog visible and retryable", async () => {
    await page.click("#delete");
    await page.click('dialog button[type="submit"]');
    await page.$eval("dialog", el => (el as HTMLDialogElement).close());
    await page.waitForSelector('dialog[open] [role="alert"]');
    expect(deletes).toBe(1);
    await page.click('dialog button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector("dialog"));
    expect(deletes).toBe(2);
  });
  it("lets artifact handlers and alternate browsing gestures take priority", async () => {
    const frame = await artifact();
    const prevented = await frame.evaluate(() => {
      const anchor = document.querySelector<HTMLAnchorElement>("#home")!;
      const handled = (e: Event) => e.preventDefault();
      anchor.addEventListener("click", handled);
      anchor.click();
      anchor.removeEventListener("click", handled);
      const results: boolean[] = [];
      // Prevent the actual browser default after checking whether the bridge consumed it.
      window.addEventListener("click", e => { results.push(e.defaultPrevented); e.preventDefault(); });
      anchor.target = "_blank"; anchor.click(); anchor.target = "";
      for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
        anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, [key]: true }));
      }
      return results;
    });
    expect(prevented).toEqual([false, false, false, false, false]);
    expect(await page.$("dialog")).toBeNull();
  });
  it("returns through the host with its session and rejects arbitrary navigation messages", async () => {
    await artifact();
    await page.click("#reload");
    const frame = await artifact();
    await page.evaluate(() => window.postMessage({ type: "artifact:platform-navigation", path: "/" }, "*"));
    await frame.evaluate(() => parent.postMessage({ type: "artifact:platform-navigation", path: "/api/auth/logout" }, "*"));
    expect(await page.$("dialog[open]")).toBeNull();
    await frame.click("#home"); await page.waitForSelector("dialog[open]");
    expect(page.url()).toContain("/fixture"); expect(await frame.$("#home")).not.toBeNull();
    await Promise.all([page.waitForNavigation(), page.click('dialog button[type="submit"]')]);
    expect(page.url()).toBe(`${base}/`); expect(await page.$eval("h1", el => el.textContent)).toBe("Signed in");
  });
  it("renders a same-package PDF after a real link click in the sandbox", async () => {
    const frame = await artifact();
    await frame.click("#pdf");
    await frame.waitForFunction(() => Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas")).some(canvas => canvas.width > 300 && canvas.height > 300), { timeout: 30000 });
    expect(await frame.$eval("#dl", el => el.getAttribute("href"))).toContain("__artifact_download=1");
    expect(await frame.evaluate(() => { try { localStorage.getItem("x"); return false; } catch { return true; } })).toBe(false); // storage shim only; opaque origin is unchanged
    expect(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
  });
});
