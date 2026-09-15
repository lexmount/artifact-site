// Final-image acceptance against a disposable Postgres shared with the server.
// scripts/test-image.sh supplies both RBAC_E2E_URL and ARTIFACT_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { closeDbForTests, createId, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";

const base = process.env.RBAC_E2E_URL;
let browser: Browser;
async function actor() {
  const user = await upsertUser({
    authProvider: "rbac-e2e",
    providerSubject: createId("test"),
    email: `${createId("user")}@example.com`,
    emailVerified: true,
  });
  const { cookie, session } = await mintSession(new Request(base!), user.id);
  return { user, session, cookie: cookie.split(";")[0] };
}
async function api(
  path: string,
  cookie: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base!, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
describe.skipIf(!base || !process.env.ARTIFACT_DATABASE_URL)(
  "RBAC browser acceptance",
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
    it("opens a private editable link and loads relative assets inside its sandbox", async () => {
      const owner = await actor(),
        editor = await actor();
      const created = await api("/api/sites", owner.cookie, "POST", {
        mode: "folder",
        files: [
          {
            path: "index.html",
            content:
              '<html><head><title>RBAC test</title></head><body><h1>Shared editing</h1><img src="asset.svg" width="60" height="60"></body></html>',
          },
          {
            path: "asset.svg",
            content:
              '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="green"/></svg>',
          },
        ],
      });
      expect(created.status).toBe(200);
      const site = await created.json();
      const visibility = await api(
        `/api/sites/${site.slug}/sharing`,
        owner.cookie,
        "PUT",
        { visibility: "private", editPolicy: "owner" },
      );
      expect(visibility.status, await visibility.text()).toBe(200);
      const shared = await api(
        `/api/sites/${site.slug}/shares`,
        owner.cookie,
        "POST",
        { policy: "login", mode: "edit" },
      );
      expect(shared.status).toBe(201);
      const share = await shared.json();
      const token = new URL(share.url).pathname.split("/").pop()!;
      const context = await browser.createBrowserContext();
      const [name, value] = editor.cookie.split("=");
      await context.setCookie({
        name,
        value,
        domain: new URL(base!).hostname,
        path: "/",
      });
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
      await page.goto(`${base}/v/${token}`, { waitUntil: "networkidle0" });
      const readerFrame = page.frames().find((f) => f.parentFrame());
      expect(readerFrame).toBeDefined();
      expect(await readerFrame!.evaluate(() => location.href)).not.toContain(
        token,
      );
      expect(
        await readerFrame!.evaluate(() => document.referrer),
      ).not.toContain(token);
      await page.goto(`${base}/s/${site.slug}/edit?share=${token}`, {
        waitUntil: "networkidle0",
      });
      await page.waitForSelector("iframe");
      await page.waitForFunction(() => {
        const frames = document.querySelectorAll("iframe");
        return frames.length > 0;
      });
      const frame = page.frames().find((f) => f.parentFrame());
      expect(frame).toBeDefined();
      await frame!.waitForFunction(() => {
        const image = document.querySelector("img");
        return image?.complete && image.naturalWidth > 0;
      });
      await page.screenshot({
        path: "test-results/rbac-editor.png",
        fullPage: true,
      });
      expect(await frame!.$eval("h1", (e) => e.textContent)).toBe(
        "Shared editing",
      );
      expect(
        await page.$eval("iframe", (el) => el.getAttribute("sandbox")),
      ).not.toContain("allow-same-origin");
      expect(
        (await api(`/api/sites/${site.slug}`, editor.cookie, "DELETE")).status,
      ).toBe(403);
      expect(
        (
          await api(
            `/api/sites/${site.slug}/shares/${share.share.id}`,
            owner.cookie,
            "DELETE",
          )
        ).status,
      ).toBe(200);
      await page.reload({ waitUntil: "networkidle0" });
      expect(await page.$("iframe")).toBeNull();
      await context.close();
    });
    it("rotates the preview key from desktop and mobile administration", async () => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({ "accept-language": "en-US", authorization: `Bearer ${process.env.RBAC_E2E_ADMIN_TOKEN}` });
      const { previewSecret } = await import("@/lib/preview-secret");
      const initial = await previewSecret();
      const owner = await actor();
      const uploaded = await api("/api/sites", owner.cookie, "POST", { mode: "paste", html: "<html>Shared key acceptance</html>" });
      expect(uploaded.status).toBe(200);
      const created = await uploaded.json();
      expect((await api(`/api/sites/${created.slug}/sharing`, owner.cookie, "PUT", { visibility: "private", editPolicy: "owner" })).status).toBe(200);
      const { getSiteBySlug } = await import("@/lib/db");
      const { mintScopedPreviewKey } = await import("@/lib/preview-key");
      const site = (await getSiteBySlug(created.slug))!;
      const grant = { versionId: site.currentVersionId, userId: owner.user.id, sessionId: owner.session.id, shareId: null, anonOwnerHash: null, fingerprint: "" };
      // This test worker and the production server are separate processes sharing only Postgres.
      const oldKey = await mintScopedPreviewKey(site, grant);
      const oldUrl = `${base}/api/preview/${site.slug}~${oldKey}/`;
      expect((await fetch(oldUrl)).status).toBe(200);
      for (const width of [1200, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.goto(`${base}/admin/settings`, { waitUntil: "networkidle0" });
        await page.waitForSelector("#preview-key-heading");
        expect(await page.content()).not.toContain(initial.secret);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.locator("#set-auditRetentionDays").fill("90");
      const savedRetention = page.waitForResponse(r => r.url().endsWith("/api/admin/settings") && r.request().method() === "PUT");
      await page.locator('button::-p-text(Save changes)').click();
      expect((await savedRetention).status()).toBe(200);
      await page.reload({ waitUntil: "networkidle0" });
      expect(await page.$eval("#set-auditRetentionDays", el => (el as HTMLInputElement).value)).toBe("90");
      await page.locator('button::-p-text(Rotate preview key)').click();
      const response = page.waitForResponse(r => r.url().endsWith("/api/admin/preview-key") && r.request().method() === "POST");
      await page.locator('button::-p-text(Confirm rotation)').click();
      expect((await response).status()).toBe(200);
      await page.waitForFunction(() => document.body.textContent?.includes("Preview key rotated."));
      expect((await previewSecret()).revision).not.toBe(initial.revision);
      expect((await fetch(oldUrl)).status).toBe(404);
      const nextKey = await mintScopedPreviewKey(site, grant);
      expect((await fetch(`${base}/api/preview/${site.slug}~${nextKey}/`)).status).toBe(200);
      await page.screenshot({ path: "test-results/preview-key-settings.png", fullPage: true });
      await context.close();
    });
    it("renames from a fresh browser using owner/admin permissions without local tokens", async () => {
      const owner = await actor(), manager = await actor(), editor = await actor();
      const created = await (await api("/api/sites",owner.cookie,"POST",{mode:"paste",html:"<html><title>Private rename acceptance</title></html>"})).json();
      expect(created).not.toHaveProperty("editToken");
      await api(`/api/sites/${created.slug}/sharing`,owner.cookie,"PUT",{visibility:"private",editPolicy:"owner"});
      await api(`/api/sites/${created.slug}/collaborators`,owner.cookie,"POST",{email:manager.user.email,role:"admin"});
      await api(`/api/sites/${created.slug}/collaborators`,owner.cookie,"POST",{email:editor.user.email,role:"editor"});
      const denied = await fetch(`${base}/s/${created.slug}/edit`);
      expect(await denied.text()).not.toContain("Private rename acceptance");
      for (const [person,canRename,label] of [[owner,true,"owner"],[manager,true,"admin"],[editor,false,"editor"]] as const) {
        const context = await browser.createBrowserContext();
        const [name,value] = person.cookie.split("=");
        await context.setCookie({name,value,domain:new URL(base!).hostname,path:"/"});
        const page = await context.newPage();
        await page.setViewport({width:1440,height:900});
        await page.setExtraHTTPHeaders({"accept-language":"en-US"});
        await page.goto(`${base}/s/${created.slug}`,{waitUntil:"domcontentloaded"});
        await page.waitForSelector(".header-title");
        expect(await page.evaluate(slug=>localStorage.getItem(`sites:editToken:${slug}`),created.slug)).toBeNull();
        expect(await page.evaluate(slug=>localStorage.getItem(`sites:sharedToken:${slug}`),created.slug)).toBeNull();
        if(canRename) {
          await page.waitForSelector('button[title="Click to rename"]');
          await page.locator('button[title="Click to rename"]').click();
          await page.waitForSelector('input[aria-label="Site title"]');
          await page.$eval('input[aria-label="Site title"]', el=>(el as HTMLInputElement).select());
          await page.type('input[aria-label="Site title"]',`Renamed by ${label}`);
          const saved = page.waitForResponse(r=>r.url().endsWith(`/api/sites/${created.slug}`) && r.request().method()==="PATCH");
          await page.keyboard.press("Enter");
          expect((await saved).status()).toBe(200);
          await page.reload({waitUntil:"domcontentloaded"});
          await page.waitForFunction(title => document.querySelector(".header-title")?.textContent === title, {}, `Renamed by ${label}`);
          expect(await page.$eval('.header-title',el=>el.textContent)).toBe(`Renamed by ${label}`);
        } else {
          expect(await page.$('button[title="Click to rename"]')).toBeNull();
          expect((await api(`/api/sites/${created.slug}`,person.cookie,"PATCH",{title:"Denied"})).status).toBe(403);
        }
        await page.screenshot({path:`test-results/rbac-title-${label}.png`});
        await context.close();
      }
    });
    it("exchanges a stored anonymous receipt only when opening the artifact", async () => {
      const created = await (await api("/api/sites", "", "POST", {mode:"paste",html:"<html><title>Anonymous navigation</title></html>"})).json();
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({width:1440,height:900});
      await page.setExtraHTTPHeaders({"accept-language":"en-US"});
      await page.goto(base!, {waitUntil:"domcontentloaded"});
      await page.evaluate(({slug,editToken}) => localStorage.setItem(`sites:editToken:${slug}`,editToken),created);
      await page.goto(`${base}/me`, {waitUntil:"networkidle0"});
      const selector = `a[href="/s/${created.slug}"]:not([aria-hidden])`;
      await page.waitForSelector(selector);
      expect((await context.cookies()).some(c => c.name.endsWith("ah_edit"))).toBe(false);
      // No creator cookie exists in this browser. The link must exchange the receipt before SSR.
      const sharing = await fetch(`${base}/api/sites/${created.slug}/sharing`, {method:"PUT",headers:{"x-edit-token":created.editToken,"content-type":"application/json"},body:JSON.stringify({visibility:"private",editPolicy:"owner"})});
      expect(sharing.status).toBe(200);
      const exchanged = page.waitForResponse(r => r.url().endsWith(`/api/sites/${created.slug}/permissions`) && r.request().method() === "POST");
      await page.locator(selector).click();
      expect((await exchanged).status()).toBe(200);
      await page.waitForSelector('button[title="Click to rename"]').catch(async error => {
        await page.screenshot({path:"test-results/anonymous-navigation-failure.png"});
        throw new Error(`${String(error)}; url=${page.url()}; body=${(await page.$eval("body",el=>el.textContent))?.slice(0,500)}`);
      });
      expect(page.url()).toBe(`${base}/s/${created.slug}`);
      expect((await context.cookies()).filter(c => c.name.endsWith("ah_edit"))).toHaveLength(1);
      await context.close();
    });
    it("renders tenant membership and role controls on desktop and mobile", async () => {
      const admin = await actor();
      await rbacQuery(
        "UPDATE tenant_members SET role='admin' WHERE tenant_id='init' AND user_id=$1",
        [admin.user.id],
      );
      const context = await browser.createBrowserContext();
      const [name, value] = admin.cookie.split("=");
      await context.setCookie({
        name,
        value,
        domain: new URL(base!).hostname,
        path: "/",
      });
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({ "accept-language": "en-US" });
      for (const width of [1200, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.goto(`${base}/tenants`, { waitUntil: "networkidle0" });
        await page.waitForSelector('input[aria-label="Email address"]');
        expect(await page.$eval("h1", (el) => el.textContent)).toBe(
          "Workspaces",
        );
        expect(
          await page.$('select[aria-label="Workspace role"]'),
        ).not.toBeNull();
        await page.screenshot({
          path: `test-results/rbac-workspaces-${width}.png`,
          fullPage: true,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
      await context.close();
    });
  },
);
