// Document sites — a single uploaded pdf/office file becomes a normal folder-shaped version:
//
//   index.html            generated wrapper (viewer or download card, decided AT BUILD TIME)
//   original/<original-name>  the untouched upload, served with a download disposition
//   preview.pdf           office → pdf conversion output (absent for pdf, or when conversion
//                         is unavailable/failed — the wrapper is then the download card)
//
// Everything downstream (versions, sharing, sandbox, fork, rollback) treats this as an ordinary
// site; nothing here is a parallel subsystem. The wrapper renders with PDF.js rather than the
// browser's native viewer because every preview response carries the sandbox CSP, and the sandbox
// flag disables plugin content — native PDF rendering under that posture is a grey box.
import type { DocumentFormat, DocumentMeta, UploadFile } from "@/lib/types";

export const DOCUMENT_ENTRY = "index.html";
export const ORIGINAL_DIR = "original";
const PREVIEW_PDF = "preview.pdf";

const EXTENSION_TO_FORMAT: Record<string, DocumentFormat> = {
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".ppt": "ppt",
  ".docx": "docx",
  ".doc": "doc",
};

const FORMAT_LABEL: Record<DocumentFormat, string> = {
  pdf: "PDF document",
  pptx: "PowerPoint presentation",
  ppt: "PowerPoint presentation (legacy format)",
  docx: "Word document",
  doc: "Word document (legacy format)",
};

/** The document format a filename implies, or null when it is not a document upload at all. */
export function documentFormatOf(filename: string): DocumentFormat | null {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? EXTENSION_TO_FORMAT[match[0]] ?? null : null;
}

/** Office formats need a server-side pdf conversion before they can be previewed; pdf does not. */
export function needsConversion(format: DocumentFormat): boolean {
  return format !== "pdf";
}

/**
 * OPC container sniff for the zip-upload path. pptx/docx ARE zip archives, so a document dropped
 * into the zip entry inflates cleanly and then fails entry detection with a message ("No HTML
 * file found") that sends the uploader in exactly the wrong direction. The `[Content_Types].xml` member
 * is mandatory in every OPC package and never appears in a hand-made site archive.
 */
export function looksLikeOpcPackage(names: readonly string[]): boolean {
  return names.some((name) => name === "[Content_Types].xml" || name.endsWith("/[Content_Types].xml"));
}

/** Display title for a document site: the file's own name without its extension. */
export function documentTitleOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  return base.replace(/\.[a-z0-9]+$/i, "").trim() || base;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc/.ppt (CFB)

/**
 * Does the payload actually look like the format its extension claims? Base64 decoding is
 * SILENT about corrupt input (Buffer.from skips bad chars), so without this a truncated or
 * double-escaped upload publishes fine and only fails later, in the viewer, as an inscrutable
 * blank — worst possible place to discover it. Checked at normalize time → clear 400 instead.
 *
 * The goal is catching CORRUPTION, not enforcing format purity — so the legacy extensions also
 * admit what LibreOffice happily converts under those names in the wild: RTF carrying a .doc
 * suffix (old exporters, mail attachments) and OOXML renamed to .doc/.ppt. Truly mangled bytes
 * still match none of the signatures.
 */
export function sniffsAsDocument(format: DocumentFormat, bytes: Uint8Array): boolean {
  if (format === "pdf") {
    // The spec tolerates junk before the header as long as %PDF- shows up near the start.
    return Buffer.from(bytes.subarray(0, 1024)).toString("latin1").includes("%PDF-");
  }
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; // PK\x03\x04
  if (format === "pptx" || format === "docx") return zip;
  const ole = bytes.length >= 8 && OLE_MAGIC.every((expected, i) => bytes[i] === expected);
  const rtf = bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66; // {\rtf
  return ole || rtf || zip;
}

// --- wrapper page ---------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Relative URL for a file inside the version, safe for href/fetch under the injected <base>. */
function encodeRelpath(relpath: string): string {
  return relpath.split("/").map(encodeURIComponent).join("/");
}

/**
 * JSON for a <script type="application/json"> island. "<" is escaped so a filename like
 * `</script><script>…` can never terminate the island early — the classic JSON-in-HTML break.
 */
function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared page shell: neutral document-reader chrome, no external CSS, dark-friendly. */
function pageShell(title: string, headExtra: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
         background: #22252a; color: #e8e6e1; min-height: 100vh; }
  .bar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px;
         padding: 8px 14px; background: #2c3037; border-bottom: 1px solid #3a3f47; }
  .bar .name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; flex: 1; min-width: 0; }
  .bar .pages { font-size: 12px; color: #9aa0a8; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
                border: 1px solid #4a505a; background: #343943; color: #e8e6e1; }
  .bar button:hover { background: #3d434e; }
  .bar a.dl { font-size: 12px; padding: 4px 12px; border-radius: 6px; text-decoration: none;
              border: 1px solid #5a80a8; background: #33455c; color: #cfe0f2; white-space: nowrap; }
  .bar a.dl:hover { background: #3a4a5e; }
</style>
${headExtra}
</head>
<body>
${body}
</body>
</html>`;
}

/** The PDF.js viewer wrapper: renders `fileRelpath` (the pdf) with a download link to the original. */
function viewerPage(meta: DocumentMeta, fileRelpath: string): string {
  const config = jsonForScriptTag({
    file: encodeRelpath(fileRelpath),
    original: encodeRelpath(meta.originalRelpath),
    name: meta.originalName,
  });
  const head = `<style>
  #stage { padding: 18px 0 40px; }
  .pg { display: block; margin: 0 auto 14px; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.45); max-width: calc(100vw - 24px); }
  #err { max-width: 560px; margin: 12vh auto; padding: 24px; text-align: center; display: none; }
  #err .t { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  #err .d { font-size: 13px; color: #9aa0a8; margin-bottom: 18px; }
  #err a { color: #9ec2e8; }
  #show { position: fixed; inset: 0; z-index: 50; background: #000; display: flex; align-items: center;
          justify-content: center; cursor: pointer; }
  #show[hidden] { display: none; }
  #slide { max-width: 100vw; max-height: 100vh; }
  #shbar { position: fixed; top: 10px; right: 12px; display: flex; gap: 10px; align-items: center;
           cursor: default; color: #9aa0a8; font-size: 12px; font-variant-numeric: tabular-nums;
           background: rgba(30,32,36,.75); padding: 6px 10px; border-radius: 8px; }
  #shbar button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
                  border: 1px solid #4a505a; background: #343943; color: #e8e6e1; }
</style>`;
  const body = `<div class="bar">
  <span class="name">${escapeHtml(meta.originalName)}</span>
  <span class="pages" id="pages"></span>
  <button type="button" id="play" title="Play full screen page by page: →/←/Space to turn pages, Esc to exit">Play</button>
  <button type="button" id="zo" aria-label="Zoom out">−</button>
  <button type="button" id="zi" aria-label="Zoom in">＋</button>
  <a class="dl" id="dl" href="${escapeHtml(encodeRelpath(meta.originalRelpath))}">Download original</a>
</div>
<div id="stage"></div>
<div id="err"><div class="t" id="errtitle">Preview failed to load</div><div class="d" id="errmsg"></div><a href="${escapeHtml(encodeRelpath(meta.originalRelpath))}">Download the original to view it</a></div>
<div id="show" hidden aria-label="Presentation mode" role="dialog">
  <canvas id="slide"></canvas>
  <div id="shbar"><span id="shpg"></span><button type="button" id="shx">Exit</button></div>
</div>
<script type="application/json" id="doc-config">${config}</script>
<script type="module">
const cfg = JSON.parse(document.getElementById("doc-config").textContent);
const stage = document.getElementById("stage");
const pagesEl = document.getElementById("pages");
// Thumbnail mode (?thumb=1, set by the card grids): a poster, not a PDF renderer. Card iframes
// share the PARENT page's renderer thread, so a grid of documents each booting PDF.js (2MB lib +
// wasm + parse + paint) starves the host page — clicks go dead until every thumbnail settles.
// The poster costs nothing and reads better at card size anyway.
const isThumb = new URLSearchParams(location.search).has("thumb");
if (isThumb) {
  document.querySelector(".bar").style.display = "none";
  stage.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:14px;padding:16px;text-align:center">'
    + '<div style="font-size:56px" aria-hidden="true">📄</div>'
    + '<div style="font-size:20px;font-weight:600;line-height:1.5;word-break:break-all;max-width:90%">' + cfg.name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) + "</div>"
    + '</div>';
}
let paintedCount = 0;
let progressText = "";
function fmtMB(n) { return (n / 1048576).toFixed(1) + " MB"; }
let dead = false; // set by fail(); every render path checks it and stops — no zombie repaints
// Progress beacons to the embedding page (viewer chrome shows nothing today, but the events are
// stable API surface: worker:<mode> → loaded(pages) → page-got/page-rendered(n) → error). With
// windowed rendering there is deliberately no "done" — pages paint and release on demand forever.
// Also the ONLY way to see inside this frame: it is an opaque origin by design.
// targetOrigin stays "*" AS A CONTRACT DECISION: previews are embeddable anywhere (no
// frame-ancestors by design), so any embedder can hear these — which is why beacons must only
// ever carry progress enums, page numbers and short error strings, NEVER document content.
function beacon(event, detail) {
  try { if (parent !== window) parent.postMessage({ artifactDocViewer: { event, detail: detail ?? null } }, "*"); } catch { /* parent gone */ }
}
function fail(e) {
  console.error("[document-viewer]", e);
  dead = true;
  beacon("error", (e && e.message) ? String(e.message) : String(e));
  stage.style.display = "none";
  document.getElementById("err").style.display = "block";
  document.getElementById("errtitle").textContent = "Preview failed to load"; // the watchdog may have changed it to "Still loading"
  document.getElementById("errmsg").textContent = (e && e.message) ? String(e.message) : String(e);
}
// Watchdog FIRST, before any await: the three spots that hang WITHOUT rejecting are exactly the
// ones ahead of it — the module import, getDocument, and getPage(1). Armed after them it would
// only ever guard the render loop, the one place least likely to hang silently.
setTimeout(() => {
  if (isThumb || dead || paintedCount > 0) return;
  // IT HAS NOT FAILED, IT IS JUST SLOW: the watchdog only speaks up when the timer fires; it does not
  // cancel anything -- download and rendering continue, and most of the time the page does get drawn
  // (the block below is withdrawn once the first page paints). This used to say "preview failed to
  // load", so a 19MB deck was first declared dead and then quietly succeeded: whoever saw "failed"
  // had long since clicked download or closed the tab. "Still loading" plus a progress figure is
  // the only wording that matches what is actually happening.
  document.getElementById("err").style.display = "block";
  document.getElementById("errtitle").textContent = "Still loading";
  document.getElementById("errmsg").textContent = progressText
    ? "Large file: " + progressText + " downloaded so far. You can download the original instead of waiting."
    : "Large file, still loading. You can download the original instead of waiting.";
}, 20_000);
// PDF.js schedules every render chunk through requestAnimationFrame, which browsers freeze on
// hidden pages — a document opened in a background tab would sit unpainted until foregrounded.
// While hidden, route the callbacks through a MessageChannel instead: unlike setTimeout (whose
// hidden-page budget is throttled to ~1 fire/second — measured: it stretched one page's paint
// into tens of seconds), port.postMessage macrotasks are not throttled, so background rendering
// runs at full speed. Visible pages keep the native path untouched.
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const rafQueue = [];
const rafChannel = new MessageChannel();
rafChannel.port1.onmessage = () => { const cb = rafQueue.shift(); if (cb) cb(performance.now()); };
window.requestAnimationFrame = (cb) => {
  if (!document.hidden) return nativeRaf(cb);
  rafQueue.push(cb);
  rafChannel.port2.postMessage(0);
  return 0; // hidden-path handles are not cancellable; PDF.js tolerates a spare chunk callback
};
window.cancelAnimationFrame = (id) => { if (id) nativeCancelRaf(id); };
const boot = async () => {
  // Vendored on the PLATFORM origin with ACAO — the sandbox puts this page in an opaque origin,
  // so the module import and every fetch below are cross-origin and need that header.
  const lib = await import("/vendor/pdfjs/pdf.min.mjs");
  // Worker strategy, probed rather than assumed, because the sandboxed iframe breaks each naive
  // path differently: a platform-URL Worker is cross-origin (throws); a MODULE worker from a
  // blob: URL dies asynchronously in sandboxed iframes (no exception — the handshake just hangs);
  // and PDF.js's own fake-worker fallback would then import() the dead blob URL and fail too.
  // So: preflight module-blob-worker viability with a throwaway mini worker (ms-fast when it
  // works, 1.5s cap when it silently dies). Viable → real worker via workerPort. Not viable →
  // point workerSrc at the platform URL, which PDF.js fake-worker imports over CORS (the same
  // ACAO that loaded pdf.min.mjs) and renders on the main thread.
  const blobWorkersViable = await new Promise((resolve) => {
    try {
      const probeUrl = URL.createObjectURL(new Blob(["self.postMessage(1)"], { type: "text/javascript" }));
      const test = new Worker(probeUrl, { type: "module" });
      const done = (ok) => { test.terminate(); URL.revokeObjectURL(probeUrl); resolve(ok); };
      test.onmessage = () => done(true);
      test.onerror = () => done(false);
      setTimeout(() => done(false), 1500);
    } catch { resolve(false); }
  });
  let workerBlobUrl = null;
  if (blobWorkersViable) {
    const workerResponse = await fetch("/vendor/pdfjs/pdf.worker.min.mjs");
    if (!workerResponse.ok) throw new Error("worker fetch " + workerResponse.status);
    const workerBlob = new Blob([await workerResponse.text()], { type: "text/javascript" });
    workerBlobUrl = URL.createObjectURL(workerBlob);
    lib.GlobalWorkerOptions.workerPort = new Worker(workerBlobUrl, { type: "module" });
    beacon("worker", "dedicated");
  } else {
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    beacon("worker", "fake");
  }
  // PDF.js resolves a relative url against window.location, NOT against <base> — and the preview
  // route 308-normalizes away the trailing slash, so location alone points one level too high.
  // The injected <base> is the authoritative version root; resolve against it explicitly.
  // On a large file all a viewer wants to know is "it is moving, and how much is left". pdf.js has
  // always reported this number; nothing used to listen to it.
  const task = lib.getDocument({
    url: new URL(cfg.file, document.baseURI).href,
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    // Without these two, rendering an ICC-tagged PDF (LibreOffice output — i.e. every converted
    // office doc) stalls forever: v6 loads color-management/image-codec wasm on demand.
    wasmUrl: "/vendor/pdfjs/wasm/",
    iccUrl: "/vendor/pdfjs/iccs/",
  });
  task.onProgress = (p) => {
    if (!p || !p.total) return;
    progressText = fmtMB(p.loaded) + " / " + fmtMB(p.total);
    const box = document.getElementById("errmsg");
    // Update only once the watchdog has shown the notice, so it does not flash and vanish on fast loads.
    if (document.getElementById("err").style.display === "block" && paintedCount === 0) {
      box.textContent = "Large file: " + progressText + " downloaded so far. You can download the original instead of waiting.";
    }
  };
  const doc = await task.promise;
  // Handshake complete — the worker holds its own reference to the script now; free the blob URL
  // so a long-lived embedding shell doesn't accumulate one Blob per viewer load.
  if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);

  // ── Windowed rendering ─────────────────────────────────────────────────────
  // One <canvas> element per page (cheap DOM), but backing stores only exist for pages near the
  // viewport: a canvas holds width×height×4 bytes REGARDLESS of visibility, so painting a whole
  // 120-page A4 at desktop scale would pin gigabytes. Pages scrolled far away are released
  // (width=0 keeps the CSS box as a white placeholder); scroll/resize/zoom re-render on demand.
  let zoom = 1;
  const canvases = [];
  const renderedSig = new Map(); // canvas → "page@cssWidth@dpr" of what its store holds
  for (let i = 1; i <= doc.numPages; i++) {
    const canvas = document.createElement("canvas");
    canvas.className = "pg";
    canvas.dataset.page = String(i);
    stage.appendChild(canvas);
    canvases.push(canvas);
  }
  pagesEl.textContent = doc.numPages + (doc.numPages === 1 ? " page" : " pages");
  beacon("loaded", doc.numPages);
  const firstBase = (await doc.getPage(1)).getViewport({ scale: 1 });

  function pageScale(base) {
    const width = document.documentElement.clientWidth;
    if (width < 40) return 0; // collapsed/unlaid-out container: wait for a real resize
    const fit = Math.min(Math.max(width - 24, 40) / base.width, 1.5);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Safari/iOS cap canvases around 16.7M px — beyond, painting silently produces a blank page.
    const maxScale = Math.sqrt(15_000_000 / (base.width * base.height)) / dpr;
    return Math.min(Math.max(0.1, fit) * zoom, maxScale);
  }

  /** CSS-size every canvas from page 1's aspect so the scrollbar is honest before anything paints.
   *  Painted pages get their exact size in ensurePage; released ones keep it (stable layout). */
  function sizePlaceholders() {
    const scale = pageScale(firstBase) || 1;
    for (const canvas of canvases) {
      if (renderedSig.has(canvas)) continue;
      canvas.style.width = Math.floor(firstBase.width * scale) + "px";
      canvas.style.height = Math.floor(firstBase.height * scale) + "px";
    }
  }

  async function ensurePage(canvas) {
    if (dead) return;
    if (canvas.dataset.failedZoom === String(zoom)) return; // this page failed at this zoom; a zoom change retries
    const page = await doc.getPage(Number(canvas.dataset.page));
    beacon("page-got", Number(canvas.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const scale = pageScale(base);
    if (!scale) return; // zero-width container; resize listener will call back
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale });
    canvas.dataset.commentPage = canvas.dataset.page;
    canvas.dataset.commentFile = decodeURIComponent(cfg.file);
    canvas.dataset.commentRotation = String(viewport.rotation);
    const sig = canvas.dataset.page + "@" + Math.floor(viewport.width) + "@" + dpr;
    if (renderedSig.get(canvas) === sig) return;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
    renderedSig.set(canvas, sig);
    paintedCount++;
    beacon("page-rendered", Number(canvas.dataset.page));
    // First successful paint withdraws the watchdog notice (a hard fail() hides the stage and
    // stops rendering entirely, so this can only ever clear the soft "taking too long" card).
    if (paintedCount === 1) document.getElementById("err").style.display = "none";
  }

  function releasePage(canvas) {
    if (!renderedSig.has(canvas)) return;
    canvas.width = 0; // frees the backing store; CSS box (set above) keeps the layout
    canvas.height = 0;
    renderedSig.delete(canvas);
  }

  // Render pages within ±1.5 viewports, release beyond ±3 (hysteresis so edge pages don't churn).
  // Failure policy: one broken page must not take down a 200-page document — skip it (marked per
  // zoom level, so a zoom change retries) and keep painting the rest. Only when NOTHING has ever
  // painted does an error mean "the document doesn't render here" → hard fail with the card.
  let syncing = false;
  let syncAgain = false;
  async function syncViewport() {
    if (dead) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      const vh = window.innerHeight || 600;
      for (const canvas of canvases) {
        if (dead) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.bottom > -1.5 * vh && rect.top < 2.5 * vh) {
          try {
            await ensurePage(canvas);
          } catch (e) {
            if (paintedCount === 0) { fail(e); return; }
            console.error("[document-viewer] page " + canvas.dataset.page + " failed to render, skipped:", e);
            canvas.dataset.failedZoom = String(zoom);
          }
        } else if (rect.bottom < -3 * vh || rect.top > 4 * vh) {
          releasePage(canvas);
        }
      }
    } finally {
      syncing = false;
    }
    if (syncAgain) { syncAgain = false; syncViewport(); }
  }

  window.addEventListener("scroll", () => { syncViewport(); }, { passive: true });
  window.addEventListener("resize", () => { sizePlaceholders(); syncViewport(); });
  document.addEventListener("visibilitychange", () => { syncViewport(); });
  function rezoom(delta) {
    zoom = Math.min(3, Math.max(0.5, zoom + delta));
    sizePlaceholders();
    syncViewport();
  }
  document.getElementById("zi").addEventListener("click", () => rezoom(0.2));
  document.getElementById("zo").addEventListener("click", () => rezoom(-0.2));

  // ── Play mode ─────────────────────────────────────────────────────────────
  // One page per screen, keyboard/click/wheel paging — a deck converted from pptx/ppt reads the
  // way it was authored, and an exported-slides pdf gets the same treatment for free. Fullscreen
  // is attempted but optional: inside the /s/ chrome the frame already fills the viewport, so the
  // overlay alone is a de-facto fullscreen; a rejected requestFullscreen changes nothing.
  const showEl = document.getElementById("show");
  const slideCanvas = document.getElementById("slide");
  const slidePages = document.getElementById("shpg");
  let showing = false;
  let slideNo = 1;
  let slideSig = "";
  // The slideshow paints ONE shared canvas, so rapid paging (held arrow, wheel) must not let two
  // renders interleave: generation counter discards superseded passes at every await boundary,
  // and an in-flight PDF.js task is cancelled before the canvas is resized under it.
  let slideGen = 0;
  let slideTask = null;
  async function renderSlide() {
    if (!showing) return;
    const gen = ++slideGen;
    if (slideTask) { slideTask.cancel(); slideTask = null; }
    const page = await doc.getPage(slideNo);
    if (gen !== slideGen || !showing) return; // superseded while fetching the page
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min((window.innerWidth - 16) / base.width, (window.innerHeight - 16) / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxScale = Math.sqrt(15_000_000 / (base.width * base.height)) / dpr;
    const scale = Math.max(0.05, Math.min(fit, maxScale));
    const viewport = page.getViewport({ scale });
    const sig = slideNo + "@" + Math.floor(viewport.width) + "@" + dpr;
    if (sig === slideSig) return;
    slideCanvas.dataset.commentPage = String(slideNo);
    slideCanvas.dataset.commentFile = decodeURIComponent(cfg.file);
    slideCanvas.dataset.commentRotation = String(viewport.rotation);
    slideCanvas.width = Math.floor(viewport.width * dpr);
    slideCanvas.height = Math.floor(viewport.height * dpr);
    slideCanvas.style.width = Math.floor(viewport.width) + "px";
    slideCanvas.style.height = Math.floor(viewport.height) + "px";
    const context = slideCanvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    slideTask = page.render({ canvasContext: context, viewport });
    try {
      await slideTask.promise;
    } catch (error) {
      if (error && error.name === "RenderingCancelledException") return; // a newer pass owns the canvas
      throw error;
    }
    slideTask = null;
    if (gen !== slideGen || !showing) return;
    slideSig = sig; // only a completed, uncontested render may claim the signature
    slidePages.textContent = slideNo + " / " + doc.numPages;
  }
  function gotoSlide(n) {
    slideNo = Math.min(doc.numPages, Math.max(1, n));
    slideSig = "";
    renderSlide().catch((e) => console.error("[document-viewer] slide:", e));
  }
  function enterShow() {
    showing = true;
    showEl.hidden = false;
    document.body.style.overflow = "hidden";
    // Start from the page the reader is looking at, not always page 1.
    let current = 1;
    for (const canvas of canvases) {
      if (canvas.getBoundingClientRect().bottom > window.innerHeight * 0.3) { current = Number(canvas.dataset.page); break; }
    }
    gotoSlide(current);
    document.documentElement.requestFullscreen?.().catch(() => {});
    beacon("slideshow", "enter");
  }
  function exitShow() {
    showing = false;
    slideGen++; // discard any in-flight slide render — it must not touch the hidden canvas
    if (slideTask) { slideTask.cancel(); slideTask = null; }
    slideSig = ""; // re-entering must repaint even if the page number matches
    showEl.hidden = true;
    document.body.style.overflow = "";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    beacon("slideshow", "exit");
    syncViewport(); // the reader may resize/scroll while playing; bring the scroll view back in sync
  }
  document.getElementById("play").addEventListener("click", enterShow);
  document.getElementById("shx").addEventListener("click", (event) => { event.stopPropagation(); exitShow(); });
  showEl.addEventListener("click", (event) => {
    if (event.target.closest("#shbar")) return;
    gotoSlide(event.clientX < window.innerWidth / 3 ? slideNo - 1 : slideNo + 1);
  });
  let wheelAt = 0;
  showEl.addEventListener("wheel", (event) => {
    event.preventDefault();
    const now = Date.now();
    if (now - wheelAt < 250) return; // one page per gesture, not per wheel tick
    wheelAt = now;
    gotoSlide(event.deltaY > 0 ? slideNo + 1 : slideNo - 1);
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (!showing) return;
    const forward = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"];
    const backward = ["ArrowLeft", "ArrowUp", "PageUp"];
    if (forward.includes(event.key)) { event.preventDefault(); gotoSlide(slideNo + 1); }
    else if (backward.includes(event.key)) { event.preventDefault(); gotoSlide(slideNo - 1); }
    else if (event.key === "Home") { event.preventDefault(); gotoSlide(1); }
    else if (event.key === "End") { event.preventDefault(); gotoSlide(doc.numPages); }
    else if (event.key === "Escape") { exitShow(); }
  });
  // Leaving REAL fullscreen (Esc handled by the browser) must close the overlay too — otherwise
  // Esc appears to "not work" and the reader is stuck in a windowed black box.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && showing) exitShow();
  });
  window.addEventListener("resize", () => {
    if (showing) { slideSig = ""; renderSlide().catch((e) => console.error("[document-viewer] slide:", e)); }
  });

  sizePlaceholders();
  await syncViewport();
};
if (!isThumb) boot().catch(fail);
</script>`;
  return pageShell(meta.originalName, head, body);
}

/** The download-card wrapper: what an office upload gets when no preview pdf exists. */
function cardPage(meta: DocumentMeta, byteSize: number, note: string | null): string {
  const head = `<style>
  .card { max-width: 460px; margin: 16vh auto 0; padding: 34px 34px 30px; background: #2c3037;
          border: 1px solid #3a3f47; border-radius: 12px; text-align: center; }
  .glyph { font-size: 40px; margin-bottom: 14px; }
  .fname { font-size: 16px; font-weight: 650; line-height: 1.5; word-break: break-all; }
  .fmeta { font-size: 12.5px; color: #9aa0a8; margin: 8px 0 22px; }
  .get { display: inline-block; font-size: 14px; font-weight: 600; padding: 9px 26px; border-radius: 8px;
         background: #4a6d96; color: #fff; text-decoration: none; }
  .get:hover { background: #557aa6; }
  .note { font-size: 12px; color: #8a9098; margin-top: 20px; line-height: 1.7; }
</style>`;
  const body = `<div class="card">
  <div class="glyph" aria-hidden="true">📄</div>
  <div class="fname">${escapeHtml(meta.originalName)}</div>
  <div class="fmeta">${escapeHtml(FORMAT_LABEL[meta.format])} · ${escapeHtml(formatBytes(byteSize))}</div>
  <a class="get" href="${escapeHtml(encodeRelpath(meta.originalRelpath))}">Download file</a>
  ${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
</div>`;
  return pageShell(meta.originalName, head, body);
}

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/**
 * Regenerate a STORED viewer wrapper with the current template, recovering everything it needs
 * from the wrapper's own doc-config island. Versions are immutable, so a document uploaded before
 * a viewer improvement (presentation mode, thumbnail mode, the next fix…) would otherwise be frozen on
 * the wrapper it was born with — the viewer is platform chrome, not user content, and it must
 * evolve for EVERY document site, not just future uploads. The preview route calls this when
 * serving a document site's entry; anything unrecognizable (the download card has no island, a
 * corrupt island fails parsing) falls back to the stored bytes untouched.
 */
export function refreshDocumentWrapper(html: string): string | null {
  // Attribute-order-insensitive on purpose: a future template that swaps type/id would otherwise
  // make every refresh silently fall back to the frozen wrapper — the exact failure this exists
  // to prevent. A round-trip unit test pins template ↔ matcher coherence.
  const island = html.match(/<script\b[^>]*\bid="doc-config"[^>]*>([\s\S]*?)<\/script>/);
  if (!island) return null;
  let config: unknown;
  try {
    config = JSON.parse(island[1]);
  } catch {
    return null;
  }
  const { file, original, name } = config as { file?: unknown; original?: unknown; name?: unknown };
  if (typeof file !== "string" || typeof original !== "string" || typeof name !== "string") return null;
  // The island stores segment-encoded relpaths (see encodeRelpath); viewerPage re-encodes.
  const decodePath = (value: string) =>
    value.split("/").map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } }).join("/");
  const meta: DocumentMeta = {
    format: documentFormatOf(name) ?? "pdf",
    originalName: name,
    originalRelpath: decodePath(original),
  };
  return viewerPage(meta, decodePath(file));
}

/**
 * Assemble a document version's full file list. Pure — the shape is decided here, once, at build
 * time; the wrapper never probes at runtime for a preview that may or may not exist.
 *
 *   pdf                          → viewer wrapper over the original itself
 *   office + previewPdf          → preview.pdf + viewer wrapper over it
 *   office + null (no converter,
 *   conversion failed/timed out) → download card; `note` explains why the preview is missing
 */
/**
 * The GENERATED files for a document — the viewer wrapper (index.html) and, for a converted office
 * file, preview.pdf. It does NOT include the original: this is the stream-through path (chunked
 * upload), where the original already sits at meta.originalRelpath in the version and must never be
 * read into memory or copied. `originalByteLength` only feeds the download card's size line.
 */
export function buildDocumentWrapperFiles(
  meta: DocumentMeta,
  originalByteLength: number,
  previewPdf: Uint8Array | null,
  note: string | null = null,
): UploadFile[] {
  if (meta.format === "pdf") {
    return [{ relpath: DOCUMENT_ENTRY, bytes: encode(viewerPage(meta, meta.originalRelpath)) }];
  }
  if (previewPdf) {
    return [
      { relpath: DOCUMENT_ENTRY, bytes: encode(viewerPage(meta, PREVIEW_PDF)) },
      { relpath: PREVIEW_PDF, bytes: previewPdf },
    ];
  }
  return [{ relpath: DOCUMENT_ENTRY, bytes: encode(cardPage(meta, originalByteLength, note)) }];
}

export function buildDocumentFiles(
  meta: DocumentMeta,
  originalBytes: Uint8Array,
  previewPdf: Uint8Array | null,
  note: string | null = null,
): UploadFile[] {
  // Same generated wrapper as the stream-through path, plus the original inlined (the whole-file
  // in-memory path: paste/single-file upload and the create-time conversion).
  const files = buildDocumentWrapperFiles(meta, originalBytes.byteLength, previewPdf, note);
  files.push({ relpath: meta.originalRelpath, bytes: originalBytes });
  return files;
}
