"use client";
import { track, analyticsRequest } from "@/lib/analytics";

// "Publish the page I am looking at" — the landing page for the bookmarklet.
//
// It solves one very specific annoyance: the artifact is already open in the browser (most often a
// file:// report an agent just wrote), yet you still have to go back to Finder, dig it out, and drag
// it into the upload area.
//
// Why the detour: the browser has two hard rules that block every direct road.
//   · A local-file page cannot call our API directly — its origin is `null`, and a cross-origin
//     request with cookies requires the server to answer with a concrete origin. The only value we
//     could put there is `null`, but `null` is not exclusive to file://: sandboxed iframes and data:
//     pages are all `null` too. Allowing it would open a back door to every sandboxed page.
//   · Nor can our page reach the other way and read your disk — an https page fetching file:// is
//     flatly forbidden by the browser.
//
// So we take the third road: windows talking to each other. The bookmarklet never "reads a file" at
// all; it merely serializes the DOM THAT IS ALREADY RENDERED IN FRONT OF YOU — the browser read the
// file long ago, so no filesystem permission is needed whatsoever. The content is handed to this
// page via postMessage, and this page lives on our own domain where the cookie already is, so
// publishing is a perfectly ordinary same-origin request.
//
// This route wears two hats: opened directly it is the installation guide; opened by the bookmarklet
// (i.e. content received) it becomes the confirmation page. Two ends of the same thing — splitting
// them into two URLs would only give people one more address to remember.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Link2, TriangleAlert } from "lucide-react";
import { MAX_PAGE_BYTES } from "@/lib/bookmarklet";
import { useT } from "@/components/locale-provider";

export interface IncomingPage {
  html: string;
  title: string;
  url: string;
}

/**
 * Only accept the window we initiated the handshake with.
 *
 * Without this rule, THIS VERY COMPONENT would defeat itself: the preview iframe below renders
 * completely untrusted HTML with `allow-scripts`, and a single `parent.postMessage(...)` in that HTML
 * can talk back. "Last arrival wins" — the body to be published, the title, and even the "from xxx"
 * line could all be rewritten by the artifact's own content.
 *
 * "Never auto-publish" still blocks the bulk of it (a human still has to click), but what gets
 * pierced is precisely the confirmation page's selling point: that source line exists for a human to
 * verify, and once the body can forge it into "from a-report-I-trust.html", it turns from evidence
 * into a social-engineering prop.
 *
 * The normal flow is unaffected: the bookmarklet calls `w.postMessage(...)` from the opener, so
 * `event.source` is exactly `window.opener`. The preview iframe's `contentWindow` is not, and is
 * rejected outright. When this address is visited directly, `opener` is null, so nobody can feed
 * anything in — which is exactly what we want.
 */
export function isFromOpener(source: MessageEventSource | null, opener: Window | null): boolean {
  return opener !== null && source !== null && source === opener;
}

/**
 * Where a message comes from CANNOT be verified: a file:// page's origin is literally the string
 * "null", and a null origin is not unique to it. So this does not pretend to authenticate the sender;
 * it only checks shape and size — the real security boundary is "never auto-publish": content always
 * stops at the confirmation page for a human to look over. Without that stop, any web page could
 * inject a script and publish under your name using your signed-in session.
 */
export function parseIncomingPage(data: unknown): IncomingPage | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as { __artifactHubPage?: unknown }).__artifactHubPage;
  if (raw === null || typeof raw !== "object") return null;
  const { html, title, url } = raw as { html?: unknown; title?: unknown; url?: unknown };
  if (typeof html !== "string" || !html.trim()) return null;
  if (new Blob([html]).size > MAX_PAGE_BYTES) return null;
  return {
    html,
    title: typeof title === "string" ? title.slice(0, 200).trim() : "",
    url: typeof url === "string" ? url.slice(0, 2000) : "",
  };
}

/** References that resolve from anywhere: http(s), protocol-relative, data:. Everything else counts as "gone once published". */
function reachable(value: string): boolean {
  return /^(https?:)?\/\//i.test(value) || /^data:/i.test(value);
}

/**
 * Which resources referenced by this page will "break once published".
 *
 * The bookmarklet can only carry the current document, not the images and stylesheets sitting next
 * to it. Silently publishing a page with every image broken is worse than a failed publish — a
 * failure you learn about on the spot, while breakage is usually discovered when someone else opens
 * the link. So we would rather say so plainly above the button.
 *
 * The criterion is "unreachable", not "is a relative path": absolute file:// paths and root-relative
 * paths starting with / are just as unreachable, and the latter would even hit the platform's own
 * routes.
 *
 * DELIBERATELY a regex rather than DOMParser. This is a hint, not a security decision: the cost of a
 * miss is being back where we were without the feature (the user notices broken images after
 * publishing); the cost of a false positive is one extra ignorable reminder — neither is worth moving
 * the whole test suite onto jsdom for (this repo's tests all run in node). The real gatekeeping is
 * on the server and has nothing to do with this.
 */
export function missingLocalAssets(html: string): string[] {
  const found: string[] = [];
  const add = (value: string | undefined) => {
    const v = value?.trim();
    if (!v || v.startsWith("#") || reachable(v)) return;
    found.push(v);
  };
  // Two passes: grab the whole tag first, then look for attributes inside it. A single-pass regex
  // trips over attribute order (<link href=".." rel="stylesheet"> and the reverse both have to
  // be recognized).
  const collect = (tagPattern: RegExp, attr: string, accept?: (tag: string) => boolean) => {
    for (const tag of html.match(tagPattern) ?? []) {
      if (accept && !accept(tag)) continue;
      add(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1]);
    }
  };
  collect(/<img\b[^>]*>/gi, "src");
  collect(/<script\b[^>]*>/gi, "src");
  collect(/<source\b[^>]*>/gi, "src");
  collect(/<video\b[^>]*>/gi, "src");
  collect(/<audio\b[^>]*>/gi, "src");
  collect(/<iframe\b[^>]*>/gi, "src");
  collect(/<link\b[^>]*>/gi, "href", (tag) => /\brel\s*=\s*["'][^"']*\b(stylesheet|preload|icon)\b/i.test(tag));
  // srcset is a list like "a.png 1x, b.png 2x"; take the first token of each entry.
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/gi) ?? []) {
    const set = /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (set) for (const part of set.split(",")) add(part.trim().split(/\s+/)[0]);
  }
  // url() in CSS: inline <style> blocks and style= attributes. FONTS AND BACKGROUND IMAGES ARE THE
  // TWO THINGS MOST LIKELY TO BREAK in home-made reports, and scanning tag attributes alone misses
  // exactly those — a report whose @font-face is dead reads as every glyph changed.
  const css = [
    ...(html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []),
    ...(html.match(/\bstyle\s*=\s*["'][^"']*["']/gi) ?? []),
  ];
  for (const block of css) {
    for (const hit of block.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi)) add(hit[1]);
  }
  return [...new Set(found)];
}

export default function PublishFromPage() {
  const t = useT();
  const router = useRouter();
  const [page, setPage] = useState<IncomingPage | null>(null);
  const [title, setTitle] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFromOpener(event.source, window.opener)) return;
      const incoming = parseIncomingPage(event.data);
      if (!incoming) return;
      setPage(incoming);
      setTitle(incoming.title);
      setMissing(missingLocalAssets(incoming.html));
      // Seal up after the first delivery: this channel is meant to carry exactly one piece of
      // content; anything that arrives later is an overwrite attempt.
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    // Handshake: the side that opened the window cannot know when we are ready, so we call out
    // first. That call is only a signal and carries no content, so targetOrigin "*" is safe; the
    // body coming back the other way is sent by the bookmarklet with our domain specified exactly.
    window.opener?.postMessage({ __artifactHubReady: 1 }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function publish() {
    if (!page) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("mode", "paste");
      body.set("html", page.html);
      if (title.trim()) body.set("title", title.trim());
      const res = await analyticsRequest("publish", () => fetch("/api/sites", { method: "POST", body }));
      const data = (await res.json().catch(() => ({}))) as { slug?: string; error?: string };
      if (!res.ok || !data.slug) throw new Error(data.error || t("Publish failed"));
      track("artifact_publish_success", { upload_method: "inline" });
      router.push(`/s/${data.slug}?published=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Publish failed"));
      setBusy(false);
    }
  }

  // Opening this address directly shows no content — the guide (the button to drag to the bookmarks
  // bar) is on the home page, so this only points people back there instead of repeating the
  // explanation. No auto-redirect either: after the bookmarklet opens the window, the content
  // arrives a moment later, and a redirect would throw the person out.
  if (!page) {
    return (
      <div className="pfp-intro">
        <h1>{t("Waiting for page content…")}</h1>
        <p className="pfp-lede">
          {t("This address is opened by the bookmarklet, which brings the current page's content along. If you came here directly, go back to the")}{" "}
          <Link href="/">{t("home page")}</Link>{" "}{t("and drag its \"Publish this page\" button to your bookmarks bar.")}
        </p>
      </div>
    );
  }

  return (
    <div className="pfp-confirm">
      <h1>{t("Confirm publishing")}</h1>
      {page.url && <p className="pfp-source">{t("From")} <code>{page.url}</code></p>}

      <label className="pfp-field">
        <span>{t("Title")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Site title (optional)")} />
      </label>

      {missing.length > 0 && (
        <div className="pfp-warn" role="status">
          <TriangleAlert size={15} />
          <div>
            <b>{t("This page references {n} local files that will be missing after publishing.", { n: missing.length })}</b>
            <p>
              {t("The bookmarklet only carries the current document. To bring them along, drop the whole folder into the")}{" "}
              <Link href="/">{t("upload area on the home page")}</Link>.
            </p>
            <ul>{missing.slice(0, 5).map((src) => <li key={src}><code>{src}</code></li>)}</ul>
            {missing.length > 5 && <p className="pfp-more">{t("…and {n} more", { n: missing.length - 5 })}</p>}
          </div>
        </div>
      )}

      <div className="pfp-preview">
        {/* Same isolation posture as the platform preview: scripts allowed, but no allow-same-origin. */}
        <iframe title={t("Preview")} sandbox="allow-scripts" srcDoc={page.html} />
      </div>

      {error && <p className="pfp-error">{error}</p>}

      <div className="pfp-actions">
        <button data-analytics-button="upload" type="button" className="btn solid" onClick={() => void publish()} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} {t("Publish and get a link")}
        </button>
        <button type="button" className="btn ghost" onClick={() => window.close()} disabled={busy}>{t("Cancel")}</button>
      </div>
    </div>
  );
}
