// Sandbox selection bridge — the vetting between an UNTRUSTED artifact frame and the assistant's context.
// The frame half (reporter injection) and the host half (message parsing) are pinned separately;
// the freshness policy lives in assistant.tsx and is pinned there.
import { afterEach, describe, expect, it } from "vitest";
import { injectPreviewBootstrap } from "@/lib/preview";
import { parseRect, parseSelectionMessage, SELECTION_PATH_MAX, SELECTION_RECT_MAX, SELECTION_TEXT_MAX, toolbarPayload } from "@/components/selection-bridge";
import { buildAssistantContext, ASSISTANT_SELECTION_ACTIONS, SELECTION_FRESH_MS, type AssistantSite } from "@/components/assistant";
import { ARTIFACT_REFRESH_EVENT } from "@/components/site-version-watcher";

const T = 1_700_000_000_000;

const DOC = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";

describe("preview bootstrap — the reporter is gated and aimed", () => {
  afterEach(() => {
    delete process.env.ARTIFACT_ASSISTANT_URL;
    delete process.env.ARTIFACT_CLOUDDESK_URL;
    delete process.env.ARTIFACT_PUBLIC_URL;
  });

  it("still honours the pre-1.0 name ARTIFACT_CLOUDDESK_URL", () => {
    process.env.ARTIFACT_CLOUDDESK_URL = "https://legacy.example.net";
    expect(injectPreviewBootstrap(DOC, "/api/preview/s1/")).toContain("__artifactSelection");
  });

  it("does NOT inject when the deployment has no assistant — previews stay silent", () => {
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    expect(out).not.toContain("__artifactSelection");
    expect(out).toContain("localStorage"); // the storage shim still rides along
    expect(out.match(/data-artifact-bootstrap/g)?.length).toBe(2); // Storage shim and dormant comment bridge.
  });

  it("injects next to the storage shim once an assistant is configured", () => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    expect(out).toContain("selectionchange");
    expect(out).toContain("__artifactSelection");
    expect(out.match(/data-artifact-bootstrap/g)?.length).toBe(3);
    expect(out.indexOf("selectionchange")).toBeLessThan(out.indexOf("</head>"));
  });

  it("aims postMessage at our own origin when the deployment declares one", () => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.example.net";
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    expect(out).toContain('"https://hub.example.net"');
    // The wildcard is the last resort, not the default — an embedder must not hear selections.
    expect(out).not.toContain('},"*")');
  });

  it("falls back to the wildcard only when no public origin is configured", () => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    expect(out).toContain('},"*")');
  });
});

describe("parseSelectionMessage — hostile until proven boring", () => {
  it("ignores traffic that is not a selection message at all", () => {
    expect(parseSelectionMessage(null, T)).toBeNull();
    expect(parseSelectionMessage("hi", T)).toBeNull();
    expect(parseSelectionMessage({ other: 1 }, T)).toBeNull();
    expect(parseSelectionMessage({ __artifactSelection: "not-an-object" }, T)).toBeNull();
    expect(parseSelectionMessage({ __artifactSelection: { text: 42 } }, T)).toBeNull();
  });

  it("treats a well-formed empty text as a CLEAR, distinct from garbage", () => {
    expect(parseSelectionMessage({ __artifactSelection: { text: "" } }, T)).toEqual({ selection: null });
    expect(parseSelectionMessage({ __artifactSelection: { text: "   " } }, T)).toEqual({ selection: null });
  });

  it("clamps length and strips control characters — the artifact does not get a covert channel", () => {
    const parsed = parseSelectionMessage({ __artifactSelection: {
      text: `a\u0000b\u001bc${"x".repeat(SELECTION_TEXT_MAX * 2)}`,
      path: `div#app>${"p".repeat(SELECTION_PATH_MAX * 2)}`,
    } }, T);
    expect(parsed?.selection?.text.startsWith("abc")).toBe(true);
    expect(parsed?.selection?.text.length).toBeLessThanOrEqual(SELECTION_TEXT_MAX);
    expect(parsed?.selection?.path?.length).toBeLessThanOrEqual(SELECTION_PATH_MAX);
  });

  it("reduces the path to locator characters only", () => {
    const parsed = parseSelectionMessage({ __artifactSelection: { text: "ok", path: 'div#a"><script>alert(1)</script>' } }, T);
    // `<` `"` `(` `)` `/` are all gone; `>` survives as the chain separator it is.
    expect(parsed?.selection?.path).toBe("div#a>script>alert1script>");
  });
});

const SITE: AssistantSite = { slug: "s1", title: "t", kind: "single", version: 2, versionId: "v2" };

describe("context freshness — stale selections are not offered", () => {
  it("carries a fresh selection as the standard field plus a coarse locator", () => {
    const ctx = buildAssistantContext(SITE, "https://x", { text: "圈选的话", path: "div#app>p", at: T, rect: null }, T + 1000);
    expect(ctx.selection).toBe("圈选的话");
    expect((ctx.artifactHub as Record<string, unknown>).selectionPath).toBe("div#app>p");
  });

  it("drops a selection older than the freshness window entirely", () => {
    const ctx = buildAssistantContext(SITE, "https://x", { text: "旧的", path: null, at: T, rect: null }, T + SELECTION_FRESH_MS + 1);
    expect("selection" in ctx).toBe(false);
    expect("selectionPath" in (ctx.artifactHub as Record<string, unknown>)).toBe(false);
  });
});

// --- Lifecycle of module state (the first review round's P1: cross-site bleed) ----------------
//
// Navigation between /s/ pages is client-side (next/link), so this chain of module state is not
// reset when the artifact changes. Without ownership, a passage selected on site A follows the
// reader into site B's envelope — B's slug/versionId paired with A's text.
// vitest runs in node with no DOM, so a minimal window/document surface is hand-rolled here, and
// resetModules gives every case a brand-new module state (installSelectionBridge is one-shot).
import { vi } from "vitest";

type StubFrame = { src: string; win: object; rect?: { top: number; left: number } };
type Toolbar = { notifySelection?: (payload: unknown) => void };

function domStub(frames: StubFrame[], toolbar?: Toolbar) {
  const on: Record<string, Array<(e: unknown) => void>> = {};
  const add = (type: string, fn: (e: unknown) => void) => { (on[type] ??= []).push(fn); };
  const win: Record<string, unknown> = { addEventListener: add };
  if (toolbar) win.CloudDesk = toolbar;
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    addEventListener: add,
    querySelectorAll: () => frames.map((f) => ({
      contentWindow: f.win,
      getAttribute: () => f.src,
      getBoundingClientRect: () => ({ top: f.rect?.top ?? 0, left: f.rect?.left ?? 0 }),
    })),
  });
  return {
    dispatch(data: unknown, source: object) {
      for (const fn of on.message ?? []) fn({ data, source } as unknown);
    },
    /** Fire one of the repositioning events the bridge subscribes to. */
    fire(type: string, event: unknown = {}) {
      for (const fn of on[type] ?? []) fn(event);
    },
    win,
  };
}

async function freshBridge(frames: StubFrame[], toolbar?: Toolbar) {
  vi.resetModules();
  const dom = domStub(frames, toolbar);
  const mod = await import("@/components/selection-bridge");
  mod.installSelectionBridge();
  return { ...mod, ...dom };
}

const say = (text: string, path = "div#a") => ({ __artifactSelection: { text, path } });

describe("selection ownership — a selection belongs only to the artifact it came from", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("after switching sites the previous site's selection is no longer handed out (the first review round's probe; null once fixed)", async () => {
    const frameA = { marker: "A" };
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: frameA }]);

    bridge.dispatch(say("A 站的机密段落"), frameA);
    expect(bridge.currentArtifactSelection("site-A")?.text).toBe("A 站的机密段落");

    // Client-side navigation to site B: module state persists, but asking it for B's selection must yield nothing.
    expect(bridge.currentArtifactSelection("site-B")).toBeNull();
  });

  it("another artifact frame on the same page speaks for itself", async () => {
    const fa = { m: "a" }, fb = { m: "b" };
    const bridge = await freshBridge([
      { src: "/api/preview/site-A/", win: fa },
      { src: "/api/preview/site-B/index.html", win: fb },
    ]);

    bridge.dispatch(say("来自 A"), fa);
    bridge.dispatch(say("来自 B"), fb);
    // The later one replaced the held selection, and it answers only for B.
    expect(bridge.currentArtifactSelection("site-B")?.text).toBe("来自 B");
    expect(bridge.currentArtifactSelection("site-A")).toBeNull();
  });

  it("nothing a non-preview window says counts", async () => {
    const preview = { m: "p" }, stranger = { m: "s" };
    const bridge = await freshBridge([
      { src: "/api/preview/site-A/", win: preview },
      { src: "https://ads.example/banner.html", win: stranger },
    ]);

    bridge.dispatch(say("广告帧伪造的选区"), stranger);
    expect(bridge.currentArtifactSelection("site-A")).toBeNull();

    bridge.dispatch(say("真读者划的"), preview);
    expect(bridge.currentArtifactSelection("site-A")?.text).toBe("真读者划的");
  });

  it("clearing the selection (reader deselects) also affects only this site", async () => {
    const fa = { m: "a" };
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: fa }]);
    bridge.dispatch(say("先划一段"), fa);
    bridge.dispatch(say(""), fa);
    expect(bridge.currentArtifactSelection("site-A")).toBeNull();
  });
});

// --- Selection toolbar (host-side counterpart of IF PR#442) ---------------------------------
//
// The toolbar is drawn above the selection, so it needs two things: a position, and "how long".
// It does NOT need the text — the text is collected by the envelope only when the reader actually
// clicks an action. The cases below pin that boundary in code.

describe("in-frame script — the frame reports its own position; the host cannot hear it scroll", () => {
  afterEach(() => { delete process.env.ARTIFACT_ASSISTANT_URL; });

  it("the selection carries a rectangle", () => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    expect(out).toContain("getBoundingClientRect");
    expect(out).toContain("rect:rect");
  });

  it("in-frame scroll/zoom must re-report on its own, and must first clear the text-based dedup key", () => {
    process.env.ARTIFACT_ASSISTANT_URL = "https://if.example.net";
    const out = injectPreviewBootstrap(DOC, "/api/preview/s1/");
    // A scroll inside a cross-origin iframe never reaches the host page; a host listener hears
    // nothing. Without self-reporting the toolbar stays put, pointing at whatever scrolled in.
    expect(out).toContain('addEventListener("scroll"');
    // scroll does not bubble; inner scroll containers in the artifact are only reachable in the capture phase.
    expect(out).toContain("capture:true");
    // The dedup key `last` is the TEXT: the position changed but the text did not, so without
    // clearing it this re-report is swallowed as "the same selection".
    expect(out).toContain("last=null;report()");
  });
});

describe("parseRect — geometry is hostile input too", () => {
  it("accepts a normal rectangle", () => {
    expect(parseRect({ top: 10, left: 20, width: 30, height: 40 })).toEqual({ top: 10, left: 20, width: 30, height: 40 });
  });

  it("rejects non-numbers and non-finite values", () => {
    expect(parseRect({ top: "10", left: 20, width: 30, height: 40 })).toBeNull();
    expect(parseRect({ top: NaN, left: 20, width: 30, height: 40 })).toBeNull();
    expect(parseRect({ top: Infinity, left: 20, width: 30, height: 40 })).toBeNull();
    expect(parseRect({ top: 10, left: 20, width: 30 })).toBeNull();
  });

  it("rejects a rectangle with no area — a collapsed caret is not something to point at", () => {
    expect(parseRect({ top: 10, left: 20, width: 0, height: 40 })).toBeNull();
    expect(parseRect({ top: 10, left: 20, width: 30, height: -5 })).toBeNull();
  });

  it("rejects coordinates that would fling the toolbar outside the viewport", () => {
    expect(parseRect({ top: SELECTION_RECT_MAX + 1, left: 20, width: 30, height: 40 })).toBeNull();
    expect(parseRect({ top: 10, left: 20, width: 1e9, height: 40 })).toBeNull();
  });

  it("an old frame without rect still works, just without a toolbar", () => {
    expect(parseRect(undefined)).toBeNull();
    expect(parseRect(null)).toBeNull();
    const parsed = parseSelectionMessage({ __artifactSelection: { text: "老帧只报文本" } }, T);
    expect(parsed?.selection?.text).toBe("老帧只报文本");
    expect(parsed?.selection?.rect).toBeNull();
  });
});

describe("toolbarPayload — hands out only length and position", () => {
  const REC = { top: 10, left: 20, width: 30, height: 40 };

  it("in-frame coordinates plus the frame's own offset = page coordinates", () => {
    expect(toolbarPayload({ text: "12345", rect: REC }, { top: 100, left: 200 }))
      .toEqual({ length: 5, rect: { top: 110, left: 220, width: 30, height: 40 } });
  });

  it("not one character of the text appears in the payload given to the toolbar", () => {
    const payload = toolbarPayload({ text: "这段是机密", rect: REC }, { top: 0, left: 0 });
    expect(payload?.length).toBe(5);
    expect(JSON.stringify(payload)).not.toContain("机密");
  });

  it("no rectangle, or the frame is gone → null (withdraw the toolbar)", () => {
    expect(toolbarPayload({ text: "x", rect: null }, { top: 0, left: 0 })).toBeNull();
    expect(toolbarPayload({ text: "x", rect: REC }, null)).toBeNull();
    expect(toolbarPayload(null, { top: 0, left: 0 })).toBeNull();
  });
});

describe("toolbar relay — the host's hop", () => {
  afterEach(() => vi.unstubAllGlobals());

  const withRect = (text: string) => ({ __artifactSelection: { text, path: "div#a", rect: { top: 10, left: 20, width: 30, height: 40 } } });

  it("an old SDK without notifySelection: quietly does nothing, never throws", async () => {
    const fa = { m: "a" };
    // While the gateway has not yet shipped the new SDK, the host code must still run.
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: fa }], {});
    expect(() => bridge.dispatch(withRect("划一段"), fa)).not.toThrow();
    // The envelope path is unaffected.
    expect(bridge.currentArtifactSelection("site-A")?.text).toBe("划一段");
  });

  it("once the SDK is present it receives the converted position and length, not the text", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    const bridge = await freshBridge(
      [{ src: "/api/preview/site-A/", win: fa, rect: { top: 56, left: 100 } }],
      { notifySelection: (p) => seen.push(p) },
    );
    bridge.dispatch(withRect("六个字的选区"), fa);
    expect(seen).toEqual([{ length: 6, rect: { top: 66, left: 120, width: 30, height: 40 } }]);
    expect(JSON.stringify(seen)).not.toContain("六个字");
  });

  it("reader deselects → the toolbar is explicitly withdrawn", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: fa }], { notifySelection: (p) => seen.push(p) });
    bridge.dispatch(withRect("先划一段"), fa);
    bridge.dispatch({ __artifactSelection: { text: "" } }, fa);
    expect(seen.at(-1)).toBeNull();
  });

  it("artifact frame refreshed → the toolbar is withdrawn (the selected passage no longer exists)", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: fa }], { notifySelection: (p) => seen.push(p) });
    bridge.dispatch(withRect("写回前划的"), fa);
    expect(seen.at(-1)).not.toBeNull();

    // site-version-watcher dispatches this whenever a new version lands — the frame swapped documents, the old selection is gone.
    bridge.fire(ARTIFACT_REFRESH_EVENT);
    expect(seen.at(-1)).toBeNull();
    expect(bridge.currentArtifactSelection("site-A")).toBeNull();
  });

  it("after the stage moves, recomputes from the frame's new position — the action bar expanding, a device switch, or a window resize all move it", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    const frame = { src: "/api/preview/site-A/", win: fa, rect: { top: 0, left: 0 } };
    const bridge = await freshBridge([frame], { notifySelection: (p) => seen.push(p) });
    bridge.dispatch(withRect("划一段"), fa);
    expect(seen.at(-1)).toEqual({ length: 3, rect: { top: 10, left: 20, width: 30, height: 40 } });

    // Action bar expands: globals.css shifts the whole .fs-stage-wrap down by one bar height.
    frame.rect = { top: 56, left: 0 };
    bridge.fire("transitionend", { target: { classList: { contains: (c: string) => c === "fs-stage-wrap" } } });
    expect(seen.at(-1)).toEqual({ length: 3, rect: { top: 66, left: 20, width: 30, height: 40 } });

    // Switch to the phone preset: the stage is narrowed and re-centred.
    frame.rect = { top: 56, left: 240 };
    bridge.fire("transitionend", { target: { classList: { contains: (c: string) => c === "fs-stage" } } });
    expect(seen.at(-1)).toEqual({ length: 3, rect: { top: 66, left: 260, width: 30, height: 40 } });

    frame.rect = { top: 0, left: 0 };
    bridge.fire("resize");
    expect(seen.at(-1)).toEqual({ length: 3, rect: { top: 10, left: 20, width: 30, height: 40 } });
  });

  it("other transitions on the page (button hover and the like) do not trigger a recompute", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    const bridge = await freshBridge([{ src: "/api/preview/site-A/", win: fa }], { notifySelection: (p) => seen.push(p) });
    bridge.dispatch(withRect("划一段"), fa);
    const n = seen.length;
    bridge.fire("transitionend", { target: { classList: { contains: () => false } } });
    expect(seen.length).toBe(n);
  });
});

describe("selection actions — the share tier must not offer write actions", () => {
  it("the edit tier offers 'Edit this', and writes the manual's address into the prompt", () => {
    const actions = ASSISTANT_SELECTION_ACTIONS.edit;
    const write = actions.find((a) => a.label.includes("Edit"));
    expect(write).toBeTruthy();
    // An agent meeting this platform for the first time will guess at endpoints and eat a 403 unless the prompt carries the manual's address (a replay of the B4 joint test).
    expect(write?.prompt).toContain("artifactHub.skill");
  });

  it("the QA tier has no write action at all — a share-link reader has only allow_ai, no edit permission", () => {
    for (const action of ASSISTANT_SELECTION_ACTIONS.qa) {
      expect(action.prompt).not.toMatch(/modify|publish|edit/i);
    }
    expect(ASSISTANT_SELECTION_ACTIONS.qa.some((a) => a.label.includes("Edit"))).toBe(false);
  });
});

describe("the reposition walk does not grind to a halt over one bad frame", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a frame whose src has a malformed percent sequence is skipped, and the normal frame after it is still found", async () => {
    const seen: unknown[] = [];
    const fa = { m: "a" };
    // The bad frame comes first: once decodeURIComponent throws, the whole resize handler dies
    // right here and the frame that actually shows the artifact never gets its turn.
    const bridge = await freshBridge([
      { src: "/api/preview/%zz/", win: { m: "bad" } },
      { src: "/api/preview/site-A/", win: fa, rect: { top: 5, left: 5 } },
    ], { notifySelection: (p) => seen.push(p) });

    expect(() => bridge.dispatch({ __artifactSelection: { text: "划一段", rect: { top: 10, left: 20, width: 30, height: 40 } } }, fa)).not.toThrow();
    expect(() => bridge.fire("resize")).not.toThrow();
    expect(seen.at(-1)).toEqual({ length: 3, rect: { top: 15, left: 25, width: 30, height: 40 } });
  });
});
