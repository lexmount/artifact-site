import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { build } from "vite";
import path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { commentPreviewBootstrap } from "@/lib/comments/preview-bootstrap";

// Exercise the real React host hook and sandbox runtime, including policy changes
// when a historical version differs from the current version.
const enabled = Boolean(process.env.E2E_CHROME);
let server: Server, browser: Browser, page: Page;
beforeAll(async () => {
  if (!enabled) return;
  const entry = path.resolve("test/fixtures/comment-package-host.tsx");
  const output = await build({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    plugins: [{ name: "comment-package-fixture", resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return `
    import React, {useRef, useState} from "react";
    import {createRoot} from "react-dom/client";
    import {useCommentPreview} from "@/components/comments/use-comment-preview";
    function App() {
      const frameRef = useRef(null);
      const [version, setVersion] = useState("current");
      const packagePaths = version !== "legacy";
      const scope = React.useMemo(() => ({siteId:"site",versionId:version,entry:{kind:"main"}}), [version]);
      const bridge = useCommentPreview({frameRef,scope,packagePaths});
      const file = version === "current" ? ".git/report.html" : version === "historical" ? "node_modules/docs/index.html" : "index.html";
      return <><button id="history" onClick={()=>setVersion("historical")}>History</button>
        <button id="legacy" onClick={()=>setVersion("legacy")}>Legacy</button>
        <button id="current" onClick={()=>setVersion("current")}>Current</button>
        <button id="select" onClick={bridge.select}>Select</button>
        <button id="locate" onClick={()=>bridge.locate({threadId:"thread",anchor:bridge.selectedAnchor})}>Locate</button>
        <output id="state">{JSON.stringify({ready:bridge.ready,path:bridge.currentFilePath,anchor:bridge.selectedAnchor,location:bridge.locationResult})}</output>
        <iframe key={version} ref={frameRef} sandbox="allow-scripts" src={"/frame?file="+encodeURIComponent(file)} /></>;
    }
    createRoot(document.getElementById("app")).render(<App/>);
  `; } }],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, minify: false, lib: { entry, name: "CommentPackageFixture", formats: ["iife"] } },
  });
  const bundle = (Array.isArray(output) ? output[0] : output) as { output: { type: string; code?: string }[] };
  const code = bundle.output.find(item => item.type === "chunk")!.code!;
  let origin = "";
  server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(code); return; }
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/frame?")) {
      const file = new URL(req.url, origin).searchParams.get("file")!;
      res.end(`<!doctype html><head>${commentPreviewBootstrap(file, origin, false, origin + "/", file !== "index.html")}</head><body><h1 id="target">Package report</h1></body>`);
    } else res.end('<!doctype html><div id="app"></div><script src="/app.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  browser = await (await import("puppeteer-core")).launch({ executablePath: process.env.E2E_CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
  page = await browser.newPage(); await page.goto(origin);
}, 30000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
it.skipIf(!enabled)("acknowledges package paths, creates anchors and relocates across current and historical policies", async () => {
  for (const [version, file] of [["current", ".git/report.html"], ["historical", "node_modules/docs/index.html"], ["legacy", "index.html"], ["current", ".git/report.html"]]) {
    await page.click(`#${version === "historical" ? "history" : version}`);
    await page.waitForFunction(file => { const state = JSON.parse(document.querySelector("#state")!.textContent!); return state.ready && state.path === file; }, {}, file);
    await page.click("#select");
    const frame = page.frames().find(frame => frame.url().includes("/frame?"))!;
    await frame.click("#target");
    await page.waitForFunction(file => JSON.parse(document.querySelector("#state")!.textContent!).anchor?.filePath === file, {}, file);
    const state = await page.$eval("#state", node => JSON.parse(node.textContent!));
    expect(state.anchor).toMatchObject({kind:"html",filePath:file,quote:{exact:"Package report"}});
    await page.click("#locate");
    await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).location === "exact");
  }
}, 30000);
