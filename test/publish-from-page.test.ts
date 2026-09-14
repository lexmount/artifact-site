// The two critical pieces of the bookmarklet: how incoming messages are vetted, and whether
// resources that "will break once published" can be spotted in advance.
//
// The source itself CANNOT be verified — a file:// page's origin is the literal string "null", and
// a null origin is not unique to it. So what is pinned here is not "keep the bad guys out" but
// shape/size vetting; the real security boundary is "never publish automatically", which the UI
// guarantees (content always stops at the confirmation page).
import { describe, expect, it } from "vitest";
import { isFromOpener, missingLocalAssets, parseIncomingPage } from "@/components/publish-from-page";
import { bookmarkletSource, MAX_PAGE_BYTES } from "@/lib/bookmarklet";

const page = (extra: Record<string, unknown> = {}) => ({
  __artifactHubPage: { html: "<html><body>hi</body></html>", title: "报告", url: "file:///Users/x/a.html", ...extra },
});

describe("parseIncomingPage — anything handed in is shape-checked first", () => {
  it("accepts a normal payload", () => {
    expect(parseIncomingPage(page())).toEqual({
      html: "<html><body>hi</body></html>", title: "报告", url: "file:///Users/x/a.html",
    });
  });

  it("ignores messages that are not ours — other people's postMessages are flying around the page too", () => {
    expect(parseIncomingPage(null)).toBeNull();
    expect(parseIncomingPage("hi")).toBeNull();
    expect(parseIncomingPage({ other: 1 })).toBeNull();
    expect(parseIncomingPage({ __artifactHubPage: "not-an-object" })).toBeNull();
  });

  it("a payload without a body is meaningless", () => {
    expect(parseIncomingPage(page({ html: "" }))).toBeNull();
    expect(parseIncomingPage(page({ html: "   " }))).toBeNull();
    expect(parseIncomingPage(page({ html: 42 }))).toBeNull();
  });

  it("rejects anything over the size limit outright — one HTML page should never be that big, it is most likely a mistake", () => {
    expect(parseIncomingPage(page({ html: "x".repeat(MAX_PAGE_BYTES + 1) }))).toBeNull();
  });

  it("garbage in title or source URL does not break parsing; they are only clamped", () => {
    const parsed = parseIncomingPage(page({ title: "标".repeat(500), url: 12345 }));
    expect(parsed?.title.length).toBeLessThanOrEqual(200);
    expect(parsed?.url).toBe(""); // a non-string source is dropped, not guessed at
  });
});

describe("missingLocalAssets — spotting references that will break once published", () => {
  it("relative-path images, scripts and stylesheets all count as missing", () => {
    const html = `<html><head><link rel="stylesheet" href="./style.css"></head>
      <body><img src="chart.png"><script src="../lib/app.js"></script></body></html>`;
    expect(missingLocalAssets(html).sort()).toEqual(["../lib/app.js", "./style.css", "chart.png"]);
  });

  it("reachable resources do not count: http(s), protocol-relative and data: all pass", () => {
    const html = `<html><head><link rel="stylesheet" href="https://cdn.example/a.css"></head>
      <body><img src="//cdn.example/b.png"><img src="data:image/png;base64,AAA">
      <script src="http://cdn.example/c.js"></script></body></html>`;
    expect(missingLocalAssets(html)).toEqual([]);
  });

  it("a root path starting with / breaks too — it hits the platform's own routes", () => {
    expect(missingLocalAssets(`<img src="/assets/logo.png">`)).toEqual(["/assets/logo.png"]);
  });

  it("a file:// absolute path counts too — once published nobody can fetch a file from your disk", () => {
    expect(missingLocalAssets(`<img src="file:///Users/x/pic.png">`)).toEqual(["file:///Users/x/pic.png"]);
  });

  it("an anchor is not a resource reference", () => {
    expect(missingLocalAssets(`<a href="#summary">跳转</a><link rel="stylesheet" href="#">`)).toEqual([]);
  });

  it("the same resource referenced several times is reported once", () => {
    expect(missingLocalAssets(`<img src="a.png"><img src="a.png"><img src="a.png">`)).toEqual(["a.png"]);
  });

  it("a self-contained page comes back clean — the normal case for an agent report", () => {
    const html = `<html><head><style>body{color:#111}</style></head>
      <body><h1>报告</h1><a href="https://github.com/x/y">仓库</a></body></html>`;
    expect(missingLocalAssets(html)).toEqual([]);
  });
});

/**
 * ACTUALLY RUN the bookmarklet script rather than searching the string for keywords.
 *
 * Keyword-search tests cannot catch a real regression: change `if(new Blob([H]).size>...)` to
 * `if(false&&...)` and the keyword is still there, the assertion still green, but the size
 * pre-check is dead (a mutation check caught this on the spot). The script is executable code, so
 * give it a controlled window/document, run it, and see what it really does.
 */
function runBookmarklet(src: string, page: { html: string; title?: string; url?: string; blockPopup?: boolean }) {
  const alerts: string[] = [];
  const posted: Array<{ payload: unknown; target: string }> = [];
  const listeners: Array<(e: unknown) => void> = [];
  const timers: Array<() => void> = [];
  let openedUrl: string | null = null;

  const win = {
    open: (url: string) => {
      if (page.blockPopup) return null;
      openedUrl = url;
      return { postMessage: (payload: unknown, target: string) => posted.push({ payload, target }) };
    },
    addEventListener: (_type: string, fn: (e: unknown) => void) => listeners.push(fn),
    removeEventListener: () => {},
  };
  const doc = { doctype: { name: "html" }, documentElement: { outerHTML: page.html }, title: page.title ?? "" };

  new Function("window", "document", "alert", "Blob", "setTimeout", "location", src.replace(/^javascript:/, ""))(
    win, doc, (m: string) => alerts.push(m), Blob, (fn: () => void) => timers.push(fn), { href: page.url ?? "" },
  );

  return {
    alerts, posted, openedUrl,
    fireReady: () => listeners.forEach((fn) => fn({ data: { __artifactHubReady: 1 } })),
    fireTimeout: () => timers.forEach((fn) => fn()),
  };
}

describe("bookmarkletSource — run it for real and see what it actually does", () => {
  const ORIGIN = "https://artifact-site.example.com";
  const src = bookmarkletSource(ORIGIN);

  it("a normal page: opens the window, sends only after the other side says ready, and only to our own origin", () => {
    const r = runBookmarklet(src, { html: "<html><body>hi</body></html>", title: "报告", url: "file:///a.html" });
    expect(r.openedUrl).toBe(`${ORIGIN}/publish-from-page`);
    expect(r.posted).toHaveLength(0); // no ready yet, so not a single byte should go out

    r.fireReady();
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0].target).toBe(ORIGIN); // not '*': broadcasting reads it out to any window listening
    const sent = r.posted[0].payload as { __artifactHubPage: { html: string; title: string; url: string } };
    expect(sent.__artifactHubPage.title).toBe("报告");
    expect(sent.__artifactHubPage.url).toBe("file:///a.html");
    expect(sent.__artifactHubPage.html.startsWith("<!doctype html>")).toBe(true); // without it the page falls into quirks mode
  });

  it("an over-limit page: says so on the spot and does NOT open a window at all — otherwise the user is left guessing at 'waiting for content'", () => {
    const r = runBookmarklet(src, { html: "x".repeat(MAX_PAGE_BYTES + 1) });
    expect(r.openedUrl).toBeNull();
    expect(r.posted).toHaveLength(0);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatch(/12MB|too large|over/);
  });

  it("popup blocked: tells the user explicitly instead of failing silently", () => {
    const r = runBookmarklet(src, { html: "<html></html>", blockPopup: true });
    expect(r.alerts[0]).toMatch(/popup/);
    expect(r.posted).toHaveLength(0);
  });

  it("ready never arrives (COOP severed the opener): speaks up after the timeout — this failure has no other symptom", () => {
    const r = runBookmarklet(src, { html: "<html></html>" });
    expect(r.alerts).toHaveLength(0); // not timed out yet, so stay quiet
    r.fireTimeout();
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatch(/talk to each other|cannot be published/);
  });

  it("once ready has arrived there must be no timeout alert", () => {
    const r = runBookmarklet(src, { html: "<html></html>" });
    r.fireReady();
    r.fireTimeout();
    expect(r.alerts).toHaveLength(0);
    expect(r.posted).toHaveLength(1);
  });

  it("must not contain # — the browser truncates everything after it as a fragment and cripples the script", () => {
    expect(src).not.toContain("#");
  });
});

describe("isFromOpener — only the window we deliberately shook hands with is recognised", () => {
  const opener = { id: "opener" } as unknown as Window;
  const other = { id: "other" } as unknown as MessageEventSource;

  it("a message from the bookmarklet side passes — it is the opener", () => {
    expect(isFromOpener(opener as unknown as MessageEventSource, opener)).toBe(true);
  });

  // This case is the reason this group exists: the preview iframe under the confirmation page
  // renders completely untrusted HTML with allow-scripts, and one parent.postMessage in the body
  // can fire back. If that is not blocked, the "from xxx" line can be forged by the artifact into
  // any string — something meant for verifying the source becomes a social-engineering prop.
  it("a message from the preview iframe (or any other window) is never recognised", () => {
    expect(isFromOpener(other, opener)).toBe(false);
  });

  it("visiting the address directly has no opener, so nobody can feed anything in", () => {
    expect(isFromOpener(other, null)).toBe(false);
    expect(isFromOpener(null, null)).toBe(false);
  });
});

describe("missingLocalAssets — covering the kinds that break most often", () => {
  it("CSS url(): fonts and background images, the two things that break most in home-made reports", () => {
    const html = `<style>@font-face{font-family:X;src:url('./fonts/x.woff2')}
      .hero{background-image:url("img/bg.jpg")}</style>`;
    expect(missingLocalAssets(html).sort()).toEqual(["./fonts/x.woff2", "img/bg.jpg"]);
  });

  it("url() inside an inline style= counts too", () => {
    expect(missingLocalAssets(`<div style="background:url(hero.png) no-repeat"></div>`)).toEqual(["hero.png"]);
  });

  it("data: and http(s) inside CSS still pass", () => {
    const html = `<style>.a{background:url(data:image/gif;base64,AAA)}.b{background:url(https://cdn.example/x.png)}</style>`;
    expect(missingLocalAssets(html)).toEqual([]);
  });

  it("every candidate in a srcset list is checked", () => {
    expect(missingLocalAssets(`<img srcset="a.png 1x, sub/b.png 2x" src="a.png">`).sort())
      .toEqual(["a.png", "sub/b.png"]);
  });

  it("src directly on video / audio / iframe", () => {
    const html = `<video src="clip.mp4"></video><audio src="./a.mp3"></audio><iframe src="inner.html"></iframe>`;
    expect(missingLocalAssets(html).sort()).toEqual(["./a.mp3", "clip.mp4", "inner.html"]);
  });

  it("preload and icon 404 as well, not just stylesheet", () => {
    const html = `<link rel="preload" as="font" href="f.woff2"><link rel="icon" href="favicon.png">`;
    expect(missingLocalAssets(html).sort()).toEqual(["f.woff2", "favicon.png"]);
  });
});

describe("bookmarkletSource — both silent failures must make a sound", () => {
  const src = bookmarkletSource("https://artifact-site.example.com");

  it("measures size before opening the window — over the limit it says so at once, rather than opening a window that leaves the user guessing at 'waiting for content'", () => {
    expect(src).toContain("new Blob([H]).size");
    expect(src.indexOf("new Blob([H]).size")).toBeLessThan(src.indexOf("window.open"));
  });

  it("must report a timeout when ready never arrives — when COOP severs the opener there is no other symptom", () => {
    expect(src).toContain("setTimeout");
    expect(src).toMatch(/if\(!s\)/);
  });
});
