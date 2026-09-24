// Real-browser regression: run against an isolated production build with open creation enabled.
// VIEWER_E2E_URL=http://localhost:4391 npx vitest run test/recent-home.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.VIEWER_E2E_URL || "").replace(/\/+$/, "");
interface Published { slug: string; versionId: string; editToken: string }
async function api<T>(page: Page, path: string, body: object, method = "POST"): Promise<T> {
  return page.evaluate(async ({ path, body, method }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }, { path, body, method }) as Promise<T>;
}
const content = (title: string) => ({ mode: "paste", title, html: `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>` });

describe.skipIf(!base)("home shelves and shared history", () => {
  let browser: Browser;
  let owner: Page;
  let reader: Page;
  let first: Published;
  let second: Published;
  let shared: Published;
  let token: string;
  const errors: string[] = [];
  beforeAll(async () => {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
    const ownerContext = await browser.createBrowserContext();
    const readerContext = await browser.createBrowserContext();
    owner = await ownerContext.newPage();
    reader = await readerContext.newPage();
    for (const page of [owner, reader]) {
      await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(base, { waitUntil: "networkidle0" });
    }
    first = await api<Published>(owner, "/api/sites", content("History older"));
    second = await api<Published>(owner, "/api/sites", content("History newer"));
    shared = await api<Published>(owner, "/api/sites", content("History private snapshot"));
    await api(owner, `/api/sites/${shared.slug}/sharing`, { visibility: "private" }, "PUT");
    const share = await api<{ token: string }>(owner, `/api/sites/${shared.slug}/shares`, { policy: "public", versionId: shared.versionId });
    token = share.token;
    await api(owner, `/api/sites/${first.slug}`, { title: "History updated first" }, "PATCH");
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("shows only browser-owned sites in update order, with keyboard and mobile tabs", async () => {
    await owner.setViewport({ width: 1280, height: 900 });
    await owner.goto(base, { waitUntil: "networkidle0" });
    await owner.click("#home-tab-updated");
    const links = await owner.$$eval("#home-sites-panel .artifact-card-link", nodes => nodes.map(n => n.getAttribute("href")));
    expect(links).toEqual([`/s/${first.slug}`, `/s/${shared.slug}`, `/s/${second.slug}`]);
    await owner.focus("#home-tab-updated");
    await owner.keyboard.press("ArrowLeft");
    expect(await owner.$eval("#home-tab-recent", n => n.getAttribute("aria-selected"))).toBe("true");
    await reader.goto(base, { waitUntil: "networkidle0" });
    await reader.click("#home-tab-updated");
    expect(await reader.$$("#home-sites-panel .artifact-card")).toHaveLength(0);
    expect(await reader.$eval("#home-sites-panel", n => n.textContent)).toContain("No sites of your own yet");
    await owner.setViewport({ width: 390, height: 844 });
    await owner.click("#home-tab-updated");
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.E2E_ARTIFACT_DIR) {
      mkdirSync(process.env.E2E_ARTIFACT_DIR, { recursive: true });
      await owner.screenshot({ path: join(process.env.E2E_ARTIFACT_DIR, "home-updated-mobile.png"), fullPage: true });
      await owner.setViewport({ width: 1280, height: 900 });
      await owner.screenshot({ path: join(process.env.E2E_ARTIFACT_DIR, "home-updated-desktop.png"), fullPage: true });
    }
  });

  it("remembers a private fixed-version share and reopens that exact entrance after updates", async () => {
    await reader.goto(`${base}/v/${token}`, { waitUntil: "networkidle0" });
    await reader.waitForFunction(() => !!localStorage.getItem("sites:recent:v1"));
    await api(owner, `/api/sites/${shared.slug}/versions`, content("A later snapshot"));
    await reader.goto(base, { waitUntil: "networkidle0" });
    const href = `/v/${token}?version=${encodeURIComponent(shared.versionId)}`;
    expect(await reader.$eval("#home-sites-panel .artifact-card-link", n => n.getAttribute("href"))).toBe(href);
    expect(await reader.$("#home-sites-panel .artifact-cover")).not.toBeNull();
    await reader.$eval("#home-sites-panel .artifact-card", e => e.scrollIntoView({block:"center",behavior:"instant"}));
    await reader.waitForSelector('#home-sites-panel [data-preview-state="ready"] iframe');
    const previewFrame = await (await reader.$('#home-sites-panel iframe'))!.contentFrame();
    expect(await previewFrame!.$eval("h1", n => n.textContent)).toBe("History private snapshot");
    await reader.click("#home-sites-panel .artifact-card-link");
    await reader.waitForSelector("iframe.fs-frame");
    expect(await reader.$eval("iframe.fs-frame", n => n.getAttribute("src"))).toContain(`v=${shared.versionId}`);
    const frame = await (await reader.$("iframe.fs-frame"))!.contentFrame();
    await frame!.waitForSelector("h1");
    expect(await frame!.$eval("h1", n => n.textContent)).toBe("History private snapshot");
    await reader.goto(`${base}/me?tab=recent`, { waitUntil: "networkidle0" });
    expect(await reader.$eval(".site-name strong a", n => n.getAttribute("href"))).toBe(href);
  });

  it("does not turn a rename and server refresh into another visit", async () => {
    await owner.setViewport({ width: 1280, height: 900 });
    await owner.goto(`${base}/s/${first.slug}`, { waitUntil: "domcontentloaded" });
    await owner.waitForSelector(".header-title.as-title");
    await owner.waitForFunction(slug => JSON.parse(localStorage.getItem("sites:recent:v1") || '{"items":[]}').items[0]?.slug === slug, {}, first.slug);
    const before = await owner.evaluate(() => JSON.parse(localStorage.getItem("sites:recent:v1")!).items[0].visitedAt);
    await owner.click(".header-title.as-title");
    await owner.waitForSelector(".title-input");
    await owner.$eval(".title-input", input => (input as HTMLInputElement).select());
    await owner.type(".title-input", "Renamed without visiting");
    await owner.keyboard.press("Enter");
    await owner.waitForFunction(() => JSON.parse(localStorage.getItem("sites:recent:v1")!).items[0].title === "Renamed without visiting");
    expect(await owner.evaluate(() => JSON.parse(localStorage.getItem("sites:recent:v1")!).items[0].visitedAt)).toBe(before);
    await owner.goto(`${base}/s/${second.slug}`, { waitUntil: "domcontentloaded" });
    await owner.waitForFunction(slug => JSON.parse(localStorage.getItem("sites:recent:v1")!).items[0]?.slug === slug, {}, second.slug);
    await owner.goto(base, { waitUntil: "networkidle0" });
    const history = await owner.evaluate(() => JSON.parse(localStorage.getItem("sites:recent:v1")!).items as {slug: string; visitedAt: number}[]);
    expect(history.map(v => v.slug)).toEqual([second.slug, first.slug]);
    expect(history.find(v => v.slug === first.slug)?.visitedAt).toBe(before);
    expect(errors).toEqual([]);
  });

  it("keeps both visits when two browser tabs open different sites together", async () => {
    const tabs = await Promise.all([reader.browserContext().newPage(), reader.browserContext().newPage()]);
    try {
      await Promise.all(tabs.map((page, i) => page.goto(`${base}/s/${i ? second.slug : first.slug}`, { waitUntil: "domcontentloaded" })));
      await reader.waitForFunction(slugs => {
        const items = JSON.parse(localStorage.getItem("sites:recent:v1") || '{"items":[]}').items as {slug: string}[];
        return slugs.every(slug => items.some(item => item.slug === slug));
      }, { polling: 100 }, [first.slug, second.slug, shared.slug]);
    } finally { await Promise.all(tabs.map(page => page.close())); }
  });

  it("forgets a deleted direct site after visiting its not-found page", async () => {
    const doomed = await api<Published>(owner, "/api/sites", content("Deleted recent site"));
    await reader.goto(`${base}/s/${doomed.slug}`, { waitUntil: "domcontentloaded" });
    await reader.waitForFunction(slug => JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, doomed.slug);
    await api(owner, `/api/sites/${doomed.slug}`, {}, "DELETE");
    await reader.goto(`${base}/s/${doomed.slug}`, { waitUntil: "networkidle0" });
    expect(await reader.$eval("h1", n => n.textContent)).toBe("Site not found");
    await reader.waitForFunction(slug => !JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, doomed.slug);
  });

  it("preserves history at login/passcode gates, then forgets a revoked share", async () => {
    const artifact = await api<Published>(owner, "/api/sites", content("Revoked recent share"));
    const link = await api<{ token: string; share: { id: string } }>(owner, `/api/sites/${artifact.slug}/shares`, { policy: "public", versionId: artifact.versionId });
    await reader.goto(`${base}/v/${link.token}`, { waitUntil: "networkidle0" });
    const hasEntry = () => reader.evaluate(slug => JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), artifact.slug);
    expect(await hasEntry()).toBe(true);
    await api(owner, `/api/sites/${artifact.slug}/shares/${link.share.id}`, { policy: "login" }, "PATCH");
    await reader.reload({ waitUntil: "networkidle0" });
    expect(await reader.$eval("h1", n => n.textContent)).toBe("Sign in to view");
    expect(await hasEntry()).toBe(true);
    await api(owner, `/api/sites/${artifact.slug}/shares/${link.share.id}`, { policy: "passcode", passcode: "test-code-123" }, "PATCH");
    await reader.reload({ waitUntil: "networkidle0" });
    expect(await reader.$('input[name="passcode"]')).not.toBeNull();
    expect(await hasEntry()).toBe(true);
    await api(owner, `/api/sites/${artifact.slug}/shares/${link.share.id}`, {}, "DELETE");
    await reader.reload({ waitUntil: "networkidle0" });
    expect(await reader.$eval("h1", n => n.textContent)).toBe("This link is no longer valid");
    await reader.waitForFunction(slug => !JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, artifact.slug);
    expect(errors).toEqual([]);
  });

  it("forgets an access-denied direct entrance without revealing whether the site exists", async () => {
    const artifact = await api<Published>(owner, "/api/sites", content("Permission-masked history"));
    await reader.goto(`${base}/s/${artifact.slug}`, { waitUntil: "domcontentloaded" });
    await reader.waitForFunction(slug => JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, artifact.slug);
    await api(owner, `/api/sites/${artifact.slug}/sharing`, { visibility: "private" }, "PUT");
    await reader.reload({ waitUntil: "networkidle0" });
    expect(await reader.$eval("h1", n => n.textContent)).toBe("Site not found");
    await reader.waitForFunction(slug => !JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, artifact.slug);
    // It still exists and can be opened and recorded by its owner.
    await owner.goto(`${base}/s/${artifact.slug}`, { waitUntil: "domcontentloaded" });
    await owner.waitForSelector("iframe.fs-frame");
    await owner.waitForFunction(slug => JSON.parse(localStorage.getItem("sites:recent:v1")!).items.some((item: { slug: string }) => item.slug === slug), { polling: 100 }, artifact.slug);
  });

});
