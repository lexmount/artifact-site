import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import puppeteer, { type Browser } from "puppeteer-core";
import { createServer, type Server } from "node:http";
import path from "node:path";

describe.skipIf(!process.env.E2E_CHROME)("browser account recovery", () => {
  let browser: Browser, server: Server, base: string;
  beforeAll(async () => {
    const output = await build({ configFile: false, logLevel: "silent",
      resolve: { alias: { "next/navigation": path.resolve("test/fixtures/auth-recovery-router.ts"), "@": path.resolve("src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": JSON.stringify({ NEXT_PUBLIC_ARTIFACT_BASE_PATH: "/artifact-site" }) },
      build: { write: false, minify: false, lib: { entry: path.resolve("test/fixtures/auth-recovery-browser.tsx"), name: "AuthRecoveryFixture", formats: ["iife"] } },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    server = createServer((req, res) => {
      if (req.url === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(code); }
      else if (req.url?.startsWith("/artifact-site/api/")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ tenants: [], sites: [], jobs: [], hasUnread: false }));
      } else if (req.url === "/artifact-site/me") {
        res.setHeader("content-type", "text/html");
        res.end('<meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each(["failed", "malformed", "stalled"])("recovers a %s check in the original tab without refreshing the route", async failure => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(String(error)));
      let attempts = 0, navigations = 0;
      await page.setRequestInterception(true);
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
        if (new URL(request.url()).pathname !== "/artifact-site/api/auth/me") { void request.continue(); return; }
        attempts++;
        if (attempts === 1) {
          if (failure === "failed") void request.respond({ status: 503, contentType: "application/json", body: '{"error":"Unavailable"}' });
          if (failure === "malformed") void request.respond({ status: 200, contentType: "text/html", body: "<html>Gateway unavailable</html>" });
          // Leave the first request unresolved to exercise the real fetch AbortSignal.
          return;
        }
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "reader", displayName: "Reader", email: null, avatarUrl: null }, oidcEnabled: true }) });
      });
      await page.goto(`${base}/artifact-site/me`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector('.page-note[role="alert"]')?.textContent?.includes("Could not verify your account"), { timeout: 15_000 });
      expect(await page.$(".auth-slot.is-loading")).toBeNull();
      expect(await page.$eval("[data-refreshes]", el => el.textContent)).toBe("0");
      expect(attempts).toBe(1);
      // The page's own retry must revalidate identity, rather than repeat router.refresh().
      await page.$eval('.page-note[role="alert"] + button', el => (el as HTMLButtonElement).click());
      await page.waitForSelector(".avatar");
      await page.waitForFunction(() => document.getElementById("me-tab-owned")?.textContent?.includes("33"));
      expect(await page.$('.page-note[role="alert"]')).toBeNull();
      expect(await page.$eval("[data-refreshes]", el => el.textContent)).toBe("0");
      expect(navigations).toBe(1);
      expect(attempts).toBeLessThanOrEqual(3); // Remounting account content may revalidate once.
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
