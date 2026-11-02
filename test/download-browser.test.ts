import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "puppeteer-core";

describe.skipIf(!process.env.E2E_CHROME)("native signed download handoff", () => {
  let browser: Browser, app: Server, storage: Server, origin: string, bucket: string, downloads: string;
  let held: ServerResponse | undefined, failure = 0;
  const bytes = Buffer.alloc(256 * 1024, 71);
  const requests: { authorization?: string; referer?: string; editToken?: string }[] = [];
  const release = () => held?.end();
  const listen = async (server: Server) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  beforeAll(async () => {
    const output = await build({ configFile: false, logLevel: "silent", resolve: { alias: { "@": path.resolve("src") } },
      define: { "process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH": JSON.stringify("") },
      build: { write: false, lib: { entry: path.resolve("src/lib/download.ts"), name: "DownloadFlow", formats: ["iife"] } },
    });
    const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
    const code = bundle.output.find(item => item.type === "chunk")!.code!;
    bucket = await listen(storage = createServer((req, res) => {
      requests.push({ authorization: req.headers.authorization, referer: req.headers.referer, editToken: req.headers["x-edit-token"] as string | undefined });
      if (failure) {
        res.writeHead(failure, { "content-type": "text/html" });
        res.end('<script>parent.document.querySelector("textarea").value="lost"</script>Storage error');
      } else {
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="saved.zip"', "content-length": bytes.length });
        res.write(bytes.subarray(0, 32768)); held = res;
      }
    }));
    origin = await listen(app = createServer((req, res) => {
      if (req.url?.startsWith("/api/sites/")) {
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ url: `${bucket}/saved.zip?signature=private` }));
      } else if (req.url === "/bundle.js") {
        res.setHeader("content-type", "text/javascript"); res.end(code);
      } else {
        res.setHeader("content-type", "text/html");
        res.end(`<textarea>Saved source</textarea><button>Download saved version</button><p id="status"></p><script src="/bundle.js"></script><script>
          window.unloadChecks=0;
          document.querySelector('textarea').addEventListener('input',()=>{
            window.onbeforeunload=e=>{window.unloadChecks++;e.preventDefault();e.returnValue='';};
          });
          document.querySelector('button').onclick=async()=>{
            await DownloadFlow.downloadSite('site','version',{'x-edit-token':'private-header'},()=>document.querySelector('#status').textContent='failed');
            document.querySelector('#status').textContent='handed off';
          };
        </script>`);
      }
    }));
    downloads = await mkdtemp(path.join(tmpdir(), "native-download-"));
    browser = await (await import("puppeteer-core")).default.launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  }, 60_000);
  afterAll(async () => {
    held?.end(); await browser?.close();
    for (const server of [app, storage]) if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    if (downloads) await rm(downloads, { recursive: true, force: true });
  });
  it.each([0, 403, 404])("keeps the unsaved editor intact for a storage %s response", async status => {
    failure = status; held = undefined;
    const page = await browser.newPage();
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    let started = false, completed = false, dialogs = 0;
    cdp.on("Browser.downloadWillBegin", () => { started = true; });
    cdp.on("Browser.downloadProgress", e => { if (e.state === "completed") completed = true; });
    page.on("dialog", dialog => { dialogs++; void dialog.dismiss(); });
    try {
      await page.goto(origin);
      await page.type("textarea", " Unsaved draft");
      await page.click("button");
      if (!status) {
        // The download task exists while most bytes have not yet been sent by object storage.
        await expect.poll(() => started).toBe(true);
        expect(completed).toBe(false); expect(held).toBeTruthy();
        await page.waitForFunction(() => document.querySelector("#status")?.textContent === "handed off");
        held!.end(bytes.subarray(32768));
        await expect.poll(() => completed).toBe(true);
        expect(await readFile(path.join(downloads, "saved.zip"))).toEqual(bytes);
      } else {
        await page.waitForFunction(() => document.querySelector("#status")?.textContent === "failed");
        expect(started).toBe(false);
      }
      expect(page.url()).toBe(`${origin}/`);
      expect(await page.$eval("textarea", el => el.value)).toContain("Unsaved draft");
      expect(await page.evaluate(() => (window as unknown as { unloadChecks: number }).unloadChecks)).toBe(0);
      expect(dialogs).toBe(0);
      expect(requests.at(-1)).toEqual({ authorization: undefined, referer: undefined, editToken: undefined });
    } finally { release(); await cdp.detach(); await page.close(); }
  });
});
