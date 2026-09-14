// Serve — the read path for GET /api/preview/:slug/:path*, the vetted security core.
// Guards (all preserved from the legacy audit): safeRelativePath, resolveInside, dotfile-segment
// block, symlink lstat reject, realpath containment. HTML gets <base> + a storage shim + the
// sandbox CSP; assets get the bare sandbox CSP. Serves the site's CURRENT version dir.
import path from "node:path";
import { config } from "@/lib/config";
import { refreshDocumentWrapper } from "@/lib/document-site";
import { getCurrentVersion, getSiteBySlug, getVersion } from "@/lib/db";
import { EDITOR_MARK, editorBootstrapScript } from "@/lib/editor-bootstrap";
import { getStorage, safeRelativePath, StorageError } from "@/lib/storage";
import { headInsertionIndex } from "@/lib/text-writeback";

/** Iframe isolation directive served with every preview response. Compose via composePreviewCsp. */
export const PREVIEW_SANDBOX_CSP = "sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts";

// KNOWN DEV-ONLY LIMITATION — a hosted Next.js artifact does not render under `npm run dev`.
// `next dev` blocks cross-origin reads of every path containing `_next`, and such an artifact
// serves its own bundle from /api/preview/<slug>/_next/..., so the dev server mistakes the user's
// files for its own and 403s all of them. It picks who is allowed from the Origin header, or from
// Referer for `no-cors` requests (what a classic `<script src>` sends) — but the sandbox above
// denies allow-same-origin, making Origin the literal "null", and the `referrer-policy:
// no-referrer` we serve below leaves no Referer to fall back to. Nothing here can opt out: the
// gate runs in the dev router ahead of this code, and its only lever, `allowedDevOrigins`, needs
// one of those two headers. Escaping it would mean weakening the referrer policy on every response
// for a local-only convenience — not worth it, since the slug in that URL is the capability to
// view the site. Run `npm run build && npm start` to exercise such artifacts; `next start` never
// applies the gate, so production is unaffected.

/**
 * Resource-level CSP: the sandbox directive stays untouched; a connect-src allowlist is appended
 * only when one is configured (empty = the bare sandbox directive).
 */
export function composePreviewCsp(connectSrc: readonly string[] = []): string {
  const sources = connectSrc.map((value) => value.trim()).filter(Boolean);
  if (!sources.length) return PREVIEW_SANDBOX_CSP;
  return `${PREVIEW_SANDBOX_CSP}; connect-src ${sources.join(" ")}`;
}

// --- HTML bootstrap ------------------------------------------------------------

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Sandboxed (origin-less) iframes throw on localStorage access; shim both storages with an in-memory Map.
const storageShim = `<script data-artifact-bootstrap>(function(){function s(n){try{return window[n]}catch(e){var d=new Map();var v={get length(){return d.size},clear:function(){d.clear()},getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},key:function(i){return Array.from(d.keys())[i]||null},removeItem:function(k){d.delete(String(k))},setItem:function(k,x){d.set(String(k),String(x))}};Object.defineProperty(window,n,{value:v});return v}}s("localStorage");s("sessionStorage")})();</script>`;

/**
 * Selection bridge — the artifact runs in an opaque-origin frame, so the host page's own
 * getSelection() can never see text selected INSIDE the artifact. This reporter posts the live
 * selection up to the parent, where components/selection-bridge.ts vets it before the assistant
 * assistant may quote it.
 *
 * TWO GATES, both load-bearing, because this is the one bootstrap that carries CONTENT:
 *
 * 1. It is injected ONLY when the deployment configured an assistant (see previewBootstrap). The
 *    same beacon rule document-site.ts states for the pdf viewer applies here — previews are
 *    embeddable anywhere by design, so anything they post is audible to any embedder — and a
 *    reader's selection is not the artifact's content but a NEW fact about the reader (which
 *    passage they highlighted). A deployment with no assistant must not start broadcasting it.
 * 2. targetOrigin names OUR origin whenever the deployment declared one. The frame itself cannot
 *    know its parent, but the server knows the address it serves, so it templates it in; only a
 *    deployment that never set ARTIFACT_PUBLIC_URL falls back to "*", and there the host page and
 *    the preview are the same unknown-address deployment anyway.
 *
 * The payload also carries the selection's RECTANGLE, in this frame's viewport coordinates, so the
 * host can place a toolbar over it (components/selection-bridge does the frame→page conversion).
 * The rect is geometry, not content — it says where, never what.
 *
 * Scroll is reported by this side and CANNOT be left to the host: scroll events inside a
 * cross-origin iframe do not reach the parent, so a host-side listener sees nothing and the
 * toolbar stays pinned where the text used to be — pointing at whatever scrolled into its place.
 * `last` is the de-dup key on TEXT, so a move must clear it or the re-report is swallowed as
 * "same selection". rAF coalesces a scroll burst into one message per frame.
 */
function selectionReporter(targetOrigin: string): string {
  const target = JSON.stringify(targetOrigin); // a JS string literal, safely escaped
  return `<script data-artifact-bootstrap>(function(){var last=null,t=null,raf=0;function report(){var sel,text="";try{sel=document.getSelection();text=sel?String(sel):""}catch(e){return}text=text.slice(0,2000);if(text===last)return;last=text;var path="";try{var n=sel&&sel.anchorNode;var el=n&&(n.nodeType===1?n:n.parentElement);var parts=[];var d=0;while(el&&el.tagName&&d<5){var seg=el.tagName.toLowerCase();if(el.id)seg+="#"+el.id;parts.unshift(seg);el=el.parentElement;d++}path=parts.join(">")}catch(e){}var rect=null;try{if(text&&sel&&sel.rangeCount>0){var r=sel.getRangeAt(0).getBoundingClientRect();if(r&&(r.width>0||r.height>0))rect={top:r.top,left:r.left,width:r.width,height:r.height}}}catch(e){}try{parent.postMessage({__artifactSelection:{text:text,path:path.slice(0,300),rect:rect}},${target})}catch(e){}}function moved(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;last=null;report()})}document.addEventListener("selectionchange",function(){if(t)clearTimeout(t);t=setTimeout(report,150)},{passive:true});document.addEventListener("scroll",moved,{passive:true,capture:true});window.addEventListener("resize",moved,{passive:true})})();</script>`;
}

/** The selection reporter's fragment for this deployment, or "" when no assistant is configured. */
function selectionBootstrap(): string {
  if (!config.assistantUrl) return "";
  return selectionReporter(config.publicUrl || "*");
}

/**
 * Insert `fragment` right after the opening <head>, or prepend it if the doc has no head.
 *
 * The insertion point comes from lib/text-writeback's tokenizer, no longer from a `/<head[^>]*>/`
 * regex: `<!-- <head> -->` inside a comment, `"<head>"` inside a script string, and
 * `<head data-x="a>b">` all mislead the regex and stuff `<base>` and the bootstrap into a
 * comment/string -- injected but inert (the preview loses its base href; the edit surface waits
 * out an 8-second timeout). edit-frame's script_before_head pre-check computes the insertion
 * point with the same function; both sides must see the same position.
 */
function injectAfterHead(html: string, fragment: string): string {
  const at = headInsertionIndex(html);
  if (at >= 0) return `${html.slice(0, at)}${fragment}${html.slice(at)}`;
  return `${fragment}${html}`;
}

export function injectPreviewBootstrap(html: string, baseHref: string): string {
  const base = `<base href="${escapeAttribute(baseHref)}">`;
  return injectAfterHead(html, `${base}${storageShim}${selectionBootstrap()}`);
}

/**
 * Edit-mode variant: the normal preview bootstrap PLUS the visual-editor script. Injected only by
 * the authenticated /edit-frame route, never by the public preview path — so an unauthorized viewer
 * can never receive the editing script (they get 403 before this runs). The editor script itself
 * grants nothing: the real boundary is the save endpoint, which re-checks capability. The `<base>`
 * carries the same slug prefix as a normal preview so the page's relative assets still resolve.
 */
export function injectVisualEditor(html: string, baseHref: string, nonce: string): string {
  const base = `<base href="${escapeAttribute(baseHref)}">`;
  const editor = `<script ${EDITOR_MARK}>${editorBootstrapScript(nonce)}</script>`;
  return injectAfterHead(html, `${base}${storageShim}${editor}`);
}

// Characters allowed in a CSP source. Values come from the operator-configured CSP_CONNECT_SRC,
// but they get written into an HTML attribute, and a stray `"`, `<` or `>` would be an injection
// vector -- so only "normal source" shapes pass; anything else is dropped wholesale (dropping can
// only make the policy stricter).
const SAFE_CSP_SOURCE = /^(?:'[a-z-]+'|[A-Za-z0-9:/.\-*_?+%]+)$/;

/**
 * Add a `connect-src` <meta> CSP to the edit surface.
 *
 * Why it has to be <meta>: the edit surface is fetched by the parent page and then placed into the
 * iframe as **srcDoc**, and a srcDoc document inherits no CSP from any response header -- the
 * content-security-policy response header on edit-frame has zero effect on the document that
 * actually renders. The preview path uses composePreviewCsp to wrap the artifact in a connect-src
 * allowlist; without one on the edit frame, clicking "visual edit" would hand a scripted artifact
 * a route around the egress restriction.
 *
 * Only connect-src, no default-src: the latter would ban the injected inline bootstrap along with
 * everything else. The sandbox directive is ignored in <meta> anyway; the iframe's own sandbox
 * attribute already handles isolation. With CSP_CONNECT_SRC unset (the default) no meta is added,
 * matching the preview's behaviour.
 *
 * It lives here rather than in the route file: a Next.js route module may only export HTTP methods
 * and a handful of config keys; exporting one extra helper makes `next build` fail outright
 * (neither tsc nor vitest catches it).
 */
export function withConnectSrcMeta(html: string, connectSrc: readonly string[]): string {
  const requested = connectSrc.map((value) => value.trim()).filter(Boolean);
  if (!requested.length) return html;
  const safe = requested.filter((value) => SAFE_CSP_SOURCE.test(value));
  // An allowlist was configured but no entry is valid: better 'none' (block all) than treating it as "unset" and allowing everything.
  const meta = `<meta http-equiv="Content-Security-Policy" content="connect-src ${safe.length ? safe.join(" ") : "'none'"}">`;
  // Same tokenizer for the insertion point (see injectAfterHead): if this meta lands inside a
  // comment, the whole egress allowlist is void -- far worse than losing a <base>.
  const at = headInsertionIndex(html);
  if (at < 0) return `${meta}${html}`;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

// --- request serving -----------------------------------------------------------

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  // Without the correct content-type, <video> receives application/octet-stream + nosniff and simply refuses to play.
  // .mov is especially common: it is the default for macOS screen recordings and Keynote exports.
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  // Document formats. Correct MIME matters twice: the wrapper's PDF.js fetch stays a normal typed
  // response, and a direct open / download carries a type the OS can route to the right app.
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * `Content-Disposition: attachment` for a document site's original file. Forced server-side because
 * the wrapper CANNOT do it client-side: `<a download>` is same-origin-only and the sandboxed frame
 * is an opaque origin, so the attribute is silently ignored. RFC 5987 encoding carries non-ASCII
 * (e.g. Chinese) filenames; the plain `filename=` fallback keeps ancient clients from choking.
 */
function attachmentDisposition(filename: string): string {
  // `\` must go too: inside a quoted-string it starts an RFC 6266 quoted-pair, so a raw backslash
  // corrupts the fallback filename. Unreachable via today's only caller (safeRelativePath already
  // normalizes `\` → `/`), but this function must stay safe for callers that don't come that way.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface PreviewResponse {
  status: number;
  body: string | Uint8Array;
  headers: Record<string, string>;
}

/**
 * The sandbox CSP (no allow-same-origin) puts the artifact in an OPAQUE origin, so every request it
 * makes back here — including for its own files — is cross-origin and needs CORS. Without this,
 * the browser blocks `<script type="module">` (Vite's default output shape), fetch, XHR and dynamic
 * import(), while classic scripts, stylesheets and images keep working — so a Vite build fails
 * silently, with an empty page and a clean console.
 *
 * It belongs on EVERY preview response, not just the 200s: a response the browser refuses to expose
 * is a network error to the caller, so `fetch('./missing.json')` against a 404 rejects with
 * TypeError instead of resolving to a Response the artifact can inspect — it cannot tell "not
 * found" from "server unreachable". Verified in a browser under this exact CSP.
 *
 * `*` grants nothing new: previews are already readable by anyone holding the unguessable slug, and
 * an opaque origin sends no cookies (nor can `*` ever combine with credentials).
 */
const PREVIEW_CORS_HEADER = { "access-control-allow-origin": "*" } as const;

function jsonResponse(status: number, payload: Record<string, unknown>): PreviewResponse {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json; charset=utf-8", ...PREVIEW_CORS_HEADER },
  };
}

/**
 * Full read path for GET /api/preview/:slug/:path* — the route wraps this in a NextResponse and
 * nothing else. 404 unknown site / missing file, 400 on any guard violation. Relative links between
 * pages resolve under the slug prefix; an unknown extensionless path falls back to the entry
 * (SPA-friendly), while a missing real asset (has an extension) is a 404.
 *
 * `versionId` optionally pins the read to an earlier version of THIS site (read-only history preview).
 * A value that is missing, unknown, or belongs to another site is ignored and the current version is
 * served — so a plain cache-buster like `?v=3` keeps working. All path guards + CSP stay identical.
 */
/** Audio/video: honour Range, and **the first request without a Range also gets only a slice** -- browser media stacks handle a 206 first chunk well. */
const MEDIA_TYPES = new Set([".mp4", ".webm", ".mp3", ".wav", ".ogg", ".mov", ".m4a"]);
/**
 * Every type that honours Range. PDF is here but **not** in MEDIA_TYPES: pdf.js's first request
 * carries no Range and expects a full 200 response (it decides from the Accept-Ranges and
 * Content-Length headers whether it can switch to range mode); a 206 first chunk may be taken as
 * the whole file. So PDF only gets a 206 for an explicit Range; a bare request takes the normal
 * path and returns the whole file.
 */
const RANGE_TYPES = new Set([...MEDIA_TYPES, ".pdf"]);
/** How much the first Range-less media request gets -- enough for the browser to read the file header and decide how to ask for the rest. */
const MEDIA_FIRST_CHUNK_BYTES = 1024 * 1024;
/** Maximum bytes returned per range, so a single `bytes=0-` cannot drag the whole file into memory -- the very ailment being treated. */
const MAX_RANGE_SPAN_BYTES = 8 * 1024 * 1024;

/**
 * Parse `Range: bytes=start-end`. Returns null when there is no valid range (treat as a plain
 * request), "unsatisfiable" when the range is out of bounds (HTTP requires a 416 rather than
 * ignoring it). Single ranges only -- multi-range needs a multipart/byteranges reply, and browsers
 * never request that when playing video.
 */
export function parseRangeHeader(header: string | null | undefined, total: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  let start: number;
  let end: number;
  if (!rawStart) {
    // `bytes=-500` = the last 500 bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return "unsatisfiable";
  end = Math.min(end, total - 1, start + MAX_RANGE_SPAN_BYTES - 1);
  return { start, end };
}

export async function servePreviewFile(
  slug: string,
  subpath: string[] | undefined,
  versionId?: string,
  /** The `<base>` injected into the artifact. Private sites carry the path-style credential so sub-resources are fetchable from the opaque frame too. */
  baseHref: string = `/api/preview/${encodeURIComponent(slug)}/`,
  /** The browser's raw `Range` request header. Only media types take the range path; see below. */
  rangeHeader?: string | null,
): Promise<PreviewResponse> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) return jsonResponse(404, { error: "site not found" });
  let version = await getCurrentVersion(slug);
  if (versionId) {
    const pinned = await getVersion(versionId);
    if (pinned && pinned.siteId === site.id) version = pinned;
  }
  if (!version) return jsonResponse(404, { error: "site has no current version" });
  const storage = getStorage();
  try {
    let relative = subpath?.length ? subpath.join("/") : version.entry;
    relative = safeRelativePath(relative);
    if (relative.split("/").some((part) => part.startsWith("."))) throw new Error("dotfiles are not served");
    let target = relative;
    if ((await storage.stat(site.id, version.id, target)) === "directory") target = `${relative}/index.html`;
    let kind = await storage.stat(site.id, version.id, target);
    // Extensionless unknown path → serve the entry (client-routed apps). Missing asset → 404.
    if (kind !== "file" && !path.extname(relative)) {
      target = version.entry;
      kind = await storage.stat(site.id, version.id, target);
    }
    if (kind !== "file") return jsonResponse(404, { error: "file not found" });
    const extension = path.extname(target).toLowerCase();

    /**
     * Range requests for media -- whether video works at all hinges on this block.
     *
     * `<video>` fetches piece by piece via Range: first the file header for duration and codec,
     * then, when the user scrubs to minute 3, that particular slice. If the server ignores Range,
     * the browser has one path left -- **download the whole file before playing**, the progress
     * bar cannot be dragged, and every open re-downloads it (Safari is especially picky about such
     * sources and may refuse to play at all).
     *
     * Only media takes this path: HTML needs the bootstrap injected and document wrapper pages are
     * regenerated from the current template, so both need the full content; slicing is meaningless
     * for them.
     */
    if (RANGE_TYPES.has(extension)) {
      const total = await storage.sizeOf(site.id, version.id, target);
      if (total !== null) {
        const wanted = parseRangeHeader(rangeHeader, total);
        if (wanted === "unsatisfiable") {
          return { status: 416, body: new Uint8Array(), headers: { "content-range": `bytes */${total}`, "accept-ranges": "bytes", ...PREVIEW_CORS_HEADER } };
        }
        const mediaHeaders: Record<string, string> = {
          "content-type": contentTypes[extension] || "application/octet-stream",
          "cache-control": "public, max-age=60",
          "content-security-policy": PREVIEW_SANDBOX_CSP,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          // Without this the browser never sends a Range at all -- it first needs to hear us say "supported".
          "accept-ranges": "bytes",
          ...PREVIEW_CORS_HEADER,
        };
        if (wanted) {
          const slice = await storage.readRange(site.id, version.id, target, wanted.start, wanted.end);
          return {
            status: 206,
            body: slice.bytes,
            headers: { ...mediaHeaders, "content-range": `bytes ${wanted.start}-${wanted.end}/${slice.total}`, "content-length": String(slice.bytes.byteLength) },
          };
        }
        // First request without a Range: for audio/video, do not read the whole file into memory
        // either; hand over the opening slice, and once the browser sees accept-ranges it will
        // naturally ask for the rest via Range. PDF is excluded; see the RANGE_TYPES comment.
        if (MEDIA_TYPES.has(extension) && total > MEDIA_FIRST_CHUNK_BYTES) {
          const slice = await storage.readRange(site.id, version.id, target, 0, MEDIA_FIRST_CHUNK_BYTES - 1);
          return {
            status: 206,
            body: slice.bytes,
            headers: { ...mediaHeaders, "content-range": `bytes 0-${MEDIA_FIRST_CHUNK_BYTES - 1}/${slice.total}`, "content-length": String(slice.bytes.byteLength) },
          };
        }
      }
    }

    // storage.read re-applies the guards and (for local) the symlink/realpath containment.
    const raw = await storage.read(site.id, version.id, target);
    const isHtml = extension === ".html";
    let html = isHtml ? Buffer.from(raw).toString("utf8") : "";
    // Document viewer wrappers are regenerated with the CURRENT template on every serve: the
    // wrapper is platform chrome frozen into an immutable version, and without this a document
    // uploaded before a viewer improvement would never receive it. See refreshDocumentWrapper.
    if (isHtml && site.kind === "document" && target === version.entry) {
      html = refreshDocumentWrapper(html) ?? html;
    }
    const body = isHtml ? injectPreviewBootstrap(html, baseHref) : raw;
    const headers: Record<string, string> = {
      "content-type": contentTypes[extension] || "application/octet-stream",
      "cache-control": isHtml ? "no-store" : "public, max-age=60",
      "content-security-policy": isHtml ? composePreviewCsp(config.cspConnectSrc) : PREVIEW_SANDBOX_CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // Even when returning the whole file, tell the client "you may ask by range later": pdf.js looks at exactly this header to decide whether to switch to range mode.
      ...(RANGE_TYPES.has(extension) ? { "accept-ranges": "bytes" } : {}),
      ...PREVIEW_CORS_HEADER, // see the constant — required on every preview response, not just 200s
    };
    // Only for DOCUMENT sites' original/ dir — an HTML site may legitimately ship its own
    // "original/" assets, and forcing downloads on those would change existing behaviour.
    if (site.kind === "document" && target.startsWith("original/")) {
      headers["content-disposition"] = attachmentDisposition(target.split("/").pop() || target);
    }
    return { status: 200, body, headers };
  } catch (error) {
    // A path-guard violation carries a safe, useful message → 400. A storage-backend error
    // (S3 SDK carries $metadata; a local fs error carries syscall) may leak internals and is
    // usually a transient fault → generic 500 + server log, never echoed to the visitor.
    if (error instanceof StorageError || (error && typeof error === "object" && ("$metadata" in error || "syscall" in error))) {
      console.error("[preview] storage error:", error);
      return jsonResponse(500, { error: "Internal server error" });
    }
    return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) });
  }
}
