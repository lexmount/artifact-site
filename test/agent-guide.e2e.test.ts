import { mcpTools } from "@/lib/mcp-tools";
// Final-image acceptance. Uses the same disposable server and Chrome as document-viewer E2E.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
const base = process.env.VIEWER_E2E_URL;
let browser: Browser;
describe.skipIf(!base)("agent connection guide", () => {
  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: process.env.E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  });
  afterAll(async () => { await browser?.close(); });
  it("deep-links, keyboard tabs, copies exact config, and keeps the original guide reachable", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text; } } });
    });
    await page.goto(`${base}/for-agents#cli`, { waitUntil: "networkidle0" });
    await page.waitForSelector('#tab-cli[aria-selected="true"]');
    expect(await page.$eval("#cli", (el) => el.hasAttribute("hidden"))).toBe(false);
    // The disposable image has no OIDC. Never offer a browser login that cannot complete.
    expect(await page.$eval("#cli", (el) => el.textContent)).toContain("Browser sign-in is not configured");
    expect(await page.$$eval("#cli code", (els) => els.map((el) => el.textContent).join("\n"))).not.toContain("artifact-site login");
    const historyLength = await page.evaluate(() => history.length);
    await page.click("#tab-cli");
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.focus("#tab-cli"); await page.keyboard.press("ArrowRight");
    await page.waitForSelector('#tab-mcp[aria-selected="true"]');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tab-mcp");

    expect(await page.$$eval("#mcp .connection-tools dt", nodes => nodes.length)).toBe(mcpTools.length);
    expect(await page.$eval("#mcp", el => el.textContent)).toContain("What artifacts have I published?");
    await page.type('#mcp-access-token', "test-configuration-token");
    const code = await page.$eval('#mcp button[aria-label="Copy configuration"]', (el) => el.parentElement!.querySelector("code")!.textContent!);
    expect(JSON.parse(code).mcpServers["artifact-site"].url).toMatch(/\/mcp$/);
    await page.click('#mcp button[aria-label="Copy configuration"]');
    expect(await page.evaluate(() => document.documentElement.dataset.copied)).toBe(code);
    await page.goBack(); await page.waitForSelector('#tab-cli[aria-selected="true"]');
    await page.focus("#tab-cli"); await page.keyboard.press("Home");
    await page.waitForSelector('#tab-agent[aria-selected="true"]');
    await page.keyboard.press("ArrowLeft");
    await page.waitForSelector('#tab-mcp[aria-selected="true"]');
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('#tab-agent[aria-selected="true"]');
    await page.keyboard.press("End");
    await page.waitForSelector('#tab-mcp[aria-selected="true"]');
    await page.click('a[href="#full-guide"]');
    expect(await page.$eval("#full-guide", (el) => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await page.$eval("#full-guide article", (el) => el.textContent?.length)).toBeGreaterThan(1000);
    expect((await fetch(`${base}/for-agents.md`)).status).toBe(200);
    await page.close();
  });
  it("fits mobile layouts in both languages and exposes the home entry", async () => {
    for (const language of ["en-US", "zh-CN"]) {
      const page = await browser.newPage(); await page.setViewport({ width: 390, height: 844 });
      await page.setExtraHTTPHeaders({ "accept-language": language });
      await page.goto(`${base}/for-agents`, { waitUntil: "networkidle0" });
      for (const mode of ["agent", "cli", "mcp"]) {
        await page.click(`#tab-${mode}`);
        await page.evaluate(() => document.querySelectorAll("details").forEach((el) => { el.open = true; }));

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await page.$eval(`#${mode}`, (el) => el.getBoundingClientRect().width)).toBeGreaterThan(300);
      }
      expect(await page.$eval("h1", (el) => el.textContent)).toContain(language === "zh-CN" ? "发布" : "publish");
      await page.goto(`${base}/`, { waitUntil: "networkidle0" });
      expect(await page.$('a[href="/for-agents#cli"]')).not.toBeNull();
      await page.close();
    }
  });
  it("creates a named credential, copies authenticated config, and forgets plaintext after reload", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    await page.setRequestInterception(true);
    let named = "";
    page.on("request", (request) => {
      if (request.url().endsWith("/api/auth/me")) return void request.respond({ contentType: "application/json", body: JSON.stringify({ oidcEnabled: true, isAdmin: false, user: { id: "ui-test", displayName: "UI Test" } }) });
      if (request.url().endsWith("/api/me/tokens") && request.method() === "POST") {
        named = JSON.parse(request.postData()!).name;
        return void request.respond({ status: 201, contentType: "application/json", body: JSON.stringify({ token: "ahp_ui_fixture_only", id: "fixture" }) });
      }
      void request.continue();
    });
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text; } } }));
    await page.goto(`${base}/for-agents#mcp`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#mcp .connection-token-form input");
    expect(await page.$eval('#mcp button[aria-label="Copy configuration"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval('#mcp button[aria-label="Copy token"]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await page.type("#mcp .connection-token-form input", "My agent");
    await page.click("#mcp .connection-token-form button");
    await page.waitForFunction(() => (document.querySelector('#mcp-access-token') as HTMLInputElement)?.value === "ahp_ui_fixture_only");
    expect(named).toBe("My agent");
    expect(await page.$eval("#mcp-access-token", el => (el as HTMLInputElement).type)).toBe("text");
    await page.click('#mcp button[aria-label="Copy token"]');
    expect(await page.evaluate(() => document.documentElement.dataset.copied)).toBe("ahp_ui_fixture_only");
    expect(await page.$eval('#mcp button[aria-label="Copy token"]', el => el.textContent)).toBe("Copied");
    await page.screenshot({ path: "test-results/mcp-visible-token-mobile.png" });
    await page.click('#mcp button[aria-label="Copy configuration"]');
    const copied = await page.evaluate(() => document.documentElement.dataset.copied!);
    expect(JSON.parse(copied).mcpServers["artifact-site"].headers.Authorization).toBe("Bearer ahp_ui_fixture_only");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload({ waitUntil: "networkidle0" });
    expect(await page.$eval('#mcp-access-token', (el) => (el as HTMLInputElement).value)).toBe("");
    expect(await page.$eval('#mcp button[aria-label="Copy token"]', el => (el as HTMLButtonElement).disabled)).toBe(true);
    const pasted = `ahp_${"long-token-".repeat(20)}`;
    await page.type("#mcp-access-token", pasted);
    await page.click('#mcp button[aria-label="Copy token"]');
    expect(await page.evaluate(() => document.documentElement.dataset.copied)).toBe(pasted);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); }; });
    await page.click('#mcp button[aria-label="Copy token"]');
    await page.waitForFunction(() => document.querySelector("#mcp [role=alert]")?.textContent?.includes("copy it manually"));
    expect(await page.$eval("#mcp-access-token", el => (el as HTMLInputElement).value)).toBe(pasted);
    await page.close();
  });

  it("ignores old claim links and removes the claim action from account tools", async () => {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
    await page.setRequestInterception(true);
    let claimRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/claim")) claimRequests++;
      if (request.url().endsWith("/api/auth/me")) return void request.respond({ contentType: "application/json", body: JSON.stringify({ oidcEnabled: true, user: { id: "ui-test", displayName: "UI Test" } }) });
      if (request.url().endsWith("/api/me/sites")) return void request.respond({ contentType: "application/json", body: JSON.stringify({ owned: [], collaborating: [] }) });
      void request.continue();
    });
    await page.goto(`${base}/me#claim=old-site`, { waitUntil: "networkidle0" });
    await page.waitForSelector('.work-tabs-tools button[aria-haspopup="menu"]');
    await page.click('.work-tabs-tools button[aria-haspopup="menu"]');
    expect(await page.$$eval('[role="menuitem"]', (nodes) => nodes.map((node) => node.textContent))).toContain("Publish tokens");
    expect(await page.$("#claim-address")).toBeNull();
    expect(await page.evaluate(() => document.body.innerText)).not.toContain("Claim a site");
    expect(claimRequests).toBe(0);
    await page.close();
  });

  it.skipIf(!process.env.MCP_E2E_TOKEN)("assigns an unowned site from the admin menu", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US", authorization: `Bearer ${process.env.MCP_E2E_TOKEN}` });
    await page.setRequestInterception(true);
    let assigned = false;
    let submitted = "";
    page.on("request", (request) => {
      if (request.url().endsWith("/api/admin/sites/fixture/owner")) {
        submitted = JSON.parse(request.postData()!).email; assigned = true;
        return void request.respond({ contentType: "application/json", body: JSON.stringify({ ok: true, ownerId: "recipient" }) });
      }
      if (request.url().includes("/api/admin/sites?")) return void request.respond({ contentType: "application/json", body: JSON.stringify({ total: 1, sites: [{ id: "fixture", slug: "fixture", title: "Recovered report", kind: "single", visibility: "private", anonymous: !assigned, ownerId: assigned ? "recipient" : null, ownerEmail: assigned ? "recipient@example.net" : null, createdAt: Date.now(), updatedAt: Date.now(), byteTotal: 100, versionCount: 1 }] }) });
      void request.continue();
    });
    await page.goto(`${base}/admin/sites`, { waitUntil: "networkidle0" });
    await page.click('button[aria-label="Actions"]');
    const action = await page.waitForSelector('::-p-text(Assign owner)'); await action!.click();
    await page.waitForSelector('dialog[open] input[type="email"]');
    await page.type('dialog[open] input[type="email"]', "recipient@example.net");
    expect(await page.$eval('dialog[open]', (el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "test-results/assign-owner-mobile.png" });
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForSelector('dialog:not([open])');
    expect(submitted).toBe("recipient@example.net");
    await page.waitForFunction(() => document.body.innerText.includes("recipient@example.net"));
    await page.close();
  });

});
