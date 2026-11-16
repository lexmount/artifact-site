import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "puppeteer-core";
import { closeDbForTests, createId, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

// Runs only against the disposable image database, with real preview, identity and collection APIs.
const base = process.env.SHARING_E2E_URL;
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)("platform navigation in the production image", () => {
  let browser: Browser, context: BrowserContext, slug: string, collectionUrl: string;
  beforeAll(async () => {
    const user = await upsertUser({ authProvider: "navigation-test", providerSubject: createId("reader"), displayName: "Navigation reader" });
    const pair = (await mintSession(new Request(base!), user.id)).cookie.split(";")[0], split = pair.indexOf("=");
    const headers = { cookie: pair, origin: new URL(base!).origin, "content-type": "application/json" };
    async function api(path: string, body?: unknown) {
      const response = await fetch(base + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    const change = { folderId: null, enabled: true, policy: { audience: "login", comments: true } };
    const preview = await api("/api/me/sharing/scopes", change);
    await api("/api/me/sharing/scopes", { ...change, confirmation: preview.confirmation });
    collectionUrl = (await api("/api/me/sharing/scopes")).url;
    expect(collectionUrl).toMatch(/\/c\/[A-Za-z0-9_-]+$/);
    const site = await api("/api/sites", { mode: "paste", title: "Navigation regression report",
      html: `<!doctype html><html><head><title>Reports</title></head><body><a id="all-reports" href="${collectionUrl}" target="_blank">All reports</a></body></html>` });
    slug = site.slug;
    browser = await (await import("puppeteer-core")).launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    context = await browser.createBrowserContext();
    await context.setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), domain: new URL(base!).hostname, path: "/", httpOnly: true, sameSite: "Lax" },
      { name: "ah_locale", value: "en", domain: new URL(base!).hostname, path: "/" });
  });
  afterAll(async () => { await browser?.close(); await closeDbForTests(); });
  it.each([false, true])("opens a signed-in collection and survives refresh (presentation=%s)", async presentation => {
    const page = await context.newPage();
    try {
      await page.goto(`${base}/s/${slug}${presentation ? "?presentation=1" : ""}`, { waitUntil: "networkidle2" });
      const frame = (await (await page.waitForSelector("iframe"))!.contentFrame())!;
      await frame.waitForSelector("#all-reports");
      await frame.click("#all-reports"); await page.waitForSelector("dialog[open]", { timeout: 5000 });
      const target = context.waitForTarget(t => t.url() === new URL(collectionUrl, base).href);
      await page.click('dialog button[type="submit"]');
      const popup = (await (await target).page())!;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await popup.waitForSelector(".collection-row", { timeout: 10000 });
          expect(await popup.$eval(".collection-heading", el => el.textContent)).toContain("Navigation reader");
          expect(await popup.$eval(".collection-row", el => el.textContent)).toContain("Navigation regression report");
          expect(await popup.evaluate(() => ({ origin: window.origin, opener: window.opener !== null }))).toEqual({ origin: new URL(base!).origin, opener: false });
          const identity = await popup.evaluate(async () => (await fetch(new URL("../api/auth/me", location.href))).json());
          expect(identity.user?.displayName).toBe("Navigation reader");
          if (!attempt) await popup.reload();
        }
        expect(await frame.evaluate(() => window.origin)).toBe("null");
      } finally { await popup.close(); }
    } finally { await page.close(); }
  });
});
