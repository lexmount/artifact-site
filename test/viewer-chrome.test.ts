// Full-screen preview + floating action bar. Two halves:
//
// (1) The real decision logic has been extracted from the component into pure functions
//     (isHoverPointer / shouldAutoHideBar / drawerHoldEffect / drawerHost); they are called directly
//     below to reproduce the bugs — the touch tap that "opened and closed again", the bar collapsing
//     by itself while a drawer is open, the portal crashing under SSR without a document. Each is a
//     runnable failure, not an asserted string.
//
// (2) The rest are pure structural constraints. The repo's vitest environment is node (no jsdom /
//     testing-library, and none should be installed for this one file), so no DOM can be rendered
//     and the assertions target the source itself. Such assertions must be *discriminating*:
//     anchored to a specific href / aria-label / component name / CSS rule body, not a grep for a
//     word that is trivially present in the file. The clearest case is "the drawer must portal out
//     of the action bar" — the premise (collapsed state is pointer-events:none + the drawer is its
//     descendant) is read from the CSS and JSX, and only then is createPortal required; remove the
//     portal and the test goes red.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isHoverPointer, shouldAutoHideBar, drawerHoldEffect } from "@/components/site-viewer";
import { drawerHost } from "@/components/version-history";

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");

const viewer = read("src/components/site-viewer.tsx");
const history = read("src/components/version-history.tsx");
const share = read("src/components/share-panel.tsx");
const home = read("src/app/page.tsx");
const css = read("src/app/globals.css");

/** Slices from `head` through `tail` (inclusive), to anchor an assertion on one block of a file rather than the whole source. */
function block(src: string, head: string, tail: string): string {
  const start = src.indexOf(head);
  expect(start, `找不到起点：${head}`).toBeGreaterThan(-1);
  const end = src.indexOf(tail, start + head.length);
  expect(end, `找不到终点：${tail}`).toBeGreaterThan(-1);
  return src.slice(start, end + tail.length);
}

/** The declarations of every TOP-LEVEL rule with this exact selector, joined (nested rules inside @media are indented and skipped). */
function ruleBody(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "gm");
  const bodies = [...css.matchAll(re)].map((m) => m[1]);
  expect(bodies.length, `找不到规则：${selector}`).toBeGreaterThan(0);
  return `${selector} { ${bodies.join(" ")} }`;
}

/** CSS with comments stripped — the part that actually applies; class names mentioned in comments must not count as references. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, " ");

// ── Pure logic: runnable reproductions ─────────────────────────────────────────

describe("C2 touch tap on the handle: must not open and close again", () => {
  /**
   * The sequence the browser synthesises for a single tap on the hot zone/handle: first pointerenter
   * (along with the whole set of synthetic mouse events), then the real click. React re-renders
   * between the two dispatches, so click reads the fresh value enter just wrote.
   */
  function tapOnce(open: boolean, revealOnPointerEnter: (pointerType: string) => boolean): boolean {
    if (revealOnPointerEnter("touch")) open = true; // synthetic pointerenter
    return !open;                                   // the click that follows toggles
  }

  it("the old 'any pointer reveals' rule turns one tap into open + close", () => {
    expect(tapOnce(false, () => true)).toBe(false); // the bar flashes and collapses again; a second tap is needed
  });

  it("once reveal accepts only a real mouse, touch has only the click path left", () => {
    expect(tapOnce(false, isHoverPointer)).toBe(true);
    expect(tapOnce(true, isHoverPointer)).toBe(false); // one more tap collapses it
  });

  it("a mouse still reveals on hover; pen / touch / unknown pointers never do", () => {
    expect(isHoverPointer("mouse")).toBe(true);
    for (const pointerType of ["touch", "pen", ""]) {
      expect(isHoverPointer(pointerType), `${pointerType || "(空)"} 不该触发 hover 展开`).toBe(false);
    }
  });
});

describe("C1 safety net: the action bar must not auto-hide while a drawer is open", () => {
  it("does not hide while a drawer is open, even when focus has already fallen to body", () => {
    // Clicking a version timestamp / "No versions yet." inside the drawer, or the target=_blank
    // "Preview this version", leaves relatedTarget null → onBlurCapture wipes focusHeld. The old
    // rule looked only at focusHeld.
    expect(shouldAutoHideBar({ focusHeld: false, drawerOpen: false })).toBe(true);
    expect(shouldAutoHideBar({ focusHeld: false, drawerOpen: true })).toBe(false);
    expect(shouldAutoHideBar({ focusHeld: true, drawerOpen: false })).toBe(false);
  });

  it("moves the bar only when the number of open drawers actually changes", () => {
    expect(drawerHoldEffect(0, 1)).toBe("reveal");
    expect(drawerHoldEffect(1, 0)).toBe("hide");
    expect(drawerHoldEffect(1, 2)).toBeNull();
    // A child component reports false once on mount (0 → 0). Taking that at face value would
    // schedule the 700ms hide immediately, cutting off the 2.6s intro hold on landing.
    expect(drawerHoldEffect(0, 0)).toBeNull();
  });
});

describe("C1 portal host", () => {
  it("mounts on body", () => {
    const body = {} as HTMLElement;
    expect(drawerHost({ body })).toBe(body);
  });

  it("returns null instead of crashing under SSR without a document", () => {
    expect(drawerHost(null)).toBeNull();
    expect(drawerHost(undefined)).toBeNull();
    expect(drawerHost({})).toBeNull();
    expect(drawerHost({ body: null })).toBeNull();
  });
});

// ── Structural constraints: no DOM in node, so anchor on the source ───────────

describe("C1 the drawer must escape the action bar", () => {
  it("the collapsed bar is transparent + click-through and the drawers render inside it — so a portal is mandatory", () => {
    // Premise one: the whole bar goes dark when collapsed.
    const bar = ruleBody(".fs-chrome .fs-bar");
    expect(bar).toContain("opacity: 0");
    expect(bar).toContain("pointer-events: none");

    // Premise two: both drawer components render inside this header (.controls is a descendant of .fs-bar).
    const header = block(viewer, "<header", "</header>");
    expect(header).toContain("<VersionHistory");
    expect(header).toContain("<SharePanel");

    // Conclusion: the scrim must be moved out by createPortal, otherwise the drawer turns transparent
    // and click-through as soon as the bar collapses, while the component's open is still true —
    // the user sees "the drawer vanished on its own".
    for (const [name, src] of [["版本历史", history], ["分享设置", share]] as const) {
      const scrim = src.indexOf('className="drawer-scrim"');
      expect(scrim, `${name} 少了遮罩`).toBeGreaterThan(-1);
      const portal = src.lastIndexOf("createPortal(", scrim);
      expect(portal, `${name} 的遮罩没有 portal 出去`).toBeGreaterThan(-1);
      // Nothing else may sit between the portal and the scrim, or what is moved is not the scrim itself.
      expect(src.slice(portal, scrim), `${name} 的 portal 包的不是遮罩`).not.toContain("</");
    }
  });

  it("the login overlay is moved out too, otherwise the 80 > 70 in the CSS is an empty claim", () => {
    // .fs-viewer is position:fixed — it is a stacking context of its own, and a z-index 80 trapped
    // inside it cannot beat the z-index 70 already mounted on body.
    expect(ruleBody(".gate-scrim")).toContain("z-index: 80");
    expect(ruleBody(".drawer-scrim")).toContain("z-index: 70");
    expect(ruleBody(".fs-viewer")).toContain("position: fixed");
    const gate = block(viewer, "{gate && ", "<LoginGate");
    expect(gate).toContain("createPortal(");
  });

  it("the check lives on the hover entry points, not inside revealBar", () => {
    // The handle (.fs-handle) also calls revealBar on touch: a blanket check inside revealBar would kill touch's only entry point.
    const revealBar = block(viewer, "const revealBar", ";");
    expect(revealBar).not.toContain("isHoverPointer");
    expect(revealBar).not.toContain("matchMedia");

    const enter = block(viewer, "onPointerEnter=", "\n");
    expect(enter).toContain("isHoverPointer(e.pointerType)");
    // hover no longer calls revealBar directly: it passes the mode gate (hoverArmsReveal) first, then
    // starts the dwell timer (dwell.arm). Calling revealBar directly is the regression behind the
    // complaint "passing along the top edge to click a browser tab pops the bar".
    expect(enter).toContain("hoverArmsReveal(barMode");
    expect(enter).toContain("dwell.current?.arm()");
    expect(enter).not.toContain("revealBar()");
    const leave = block(viewer, "onPointerLeave=", "\n");
    expect(leave).toContain("isHoverPointer(e.pointerType)");
    // Leaving cancels the timer first, then the mode decides whether to schedule auto-hide — in the reverse order you get "I passed through and the bar still popped".
    expect(leave.indexOf("dwell.current?.cancel()")).toBeLessThan(leave.indexOf("leaveSchedulesHide("));
    // Synthetic mouse events are where this bug came from; do not hang them back on.
    expect(viewer).not.toContain("onMouseEnter");
    expect(viewer).not.toContain("onMouseLeave");
  });
});

describe("C2b reveal-mode switch", () => {
  it("the switch sits on the action bar before the identity separator, and both states spell out the consequence in title", () => {
    const modeBtn = block(viewer, 'className="menu-item fs-mode"', "</button>");
    expect(modeBtn).toContain("onClick={switchBarMode}");
    expect(modeBtn).toContain("Click to switch to manual");
    expect(modeBtn).toContain("Click to switch to automatic");
    expect(viewer.indexOf('className="menu-item fs-mode"')).toBeLessThan(viewer.indexOf('className="controls-sep"'));
    // The mode hangs on .fs-viewer; CSS and acceptance checks both read the current state from it.
    expect(block(viewer, '<div className="fs-viewer"', ">")).toContain("data-bar-mode={barMode}");
  });
  it("in manual mode the two 'tidy up in passing' hide paths — drawer closing and focus leaving — go quiet too; only the intro hold and clicking into the artifact remain", () => {
    const drawer = block(viewer, "const setDrawerOpen", "}, [revealBar, scheduleHide, barMode]);");
    expect(drawer).toContain('effect === "hide" && modeAutoHides(barMode)');
    const blur = block(viewer, "onBlurCapture=", "}}");
    expect(blur).toContain("if (modeAutoHides(barMode)) scheduleHide()");
    // The intro hold is mode-independent: the bar shows itself briefly so people know where it is, then hides.
    expect(viewer).toContain("scheduleHide(INTRO_HOLD)");
  });
  it("any mode change cancels the dwell timer — including the path where another tab changes the preference (storage event), not just this page's switch", () => {
    // An effect keyed on barMode alone covers both paths; putting it in switchBarMode covers only this page's.
    expect(viewer).toContain("useEffect(() => { dwell.current?.cancel(); }, [barMode]);");
    // It must not cancelHide in passing: the preference also flips from default to the real value on hydration, which would kill the intro hold's hide.
    const modeEffect = block(viewer, "useEffect(() => { dwell.current?.cancel();", ";");
    expect(modeEffect).not.toContain("cancelHide");
  });
  it("toggling the switch clears any auto-hide still running — the bar must stay put right after the switch is clicked", () => {
    const sw = block(viewer, "const switchBarMode", "}, [barMode, cancelHide]);");
    expect(sw).toContain("cancelHide()");
    expect(sw).toContain("barModeStore.set(");
    // The preference is external state: useSyncExternalStore (server snapshot = default), not a "useState + setState in an effect" hydration patch.
    expect(viewer).toContain("useSyncExternalStore(barModeStore.subscribe, barModeStore.getSnapshot, barModeStore.getServerSnapshot)");
  });
});

describe("C3 accessibility trade-offs of the collapsed state", () => {
  /** The `<header ...>` start tag (up to the first child element); assertions target only its own attributes. */
  const headerTag = block(viewer, "<header", '<div className="fs-bar-glass"');

  it("no inert, no aria-hidden — the keyboard is the only way into the whole chrome", () => {
    // inert would disable the keyboard too; aria-hidden over still-focusable content is an ARIA
    // violation in itself, and would hide the only entry points (back / copy link / edit) from
    // screen-reader users entirely.
    expect(headerTag).not.toMatch(/\binert\b/);
    expect(headerTag).not.toContain("aria-hidden");
  });

  it("stays in the Tab order while collapsed and reveals on focus", () => {
    expect(headerTag).toContain("onFocusCapture");
    expect(headerTag).toContain("onBlurCapture");
    // Collapsing is opacity + a top offset, not display:none / visibility:hidden — those two would kick it out of the focus order.
    const bar = ruleBody(".fs-chrome .fs-bar");
    expect(bar).not.toContain("display: none");
    expect(bar).not.toContain("visibility: hidden");
  });

  it("names the banner landmark and lets assistive-technology activation reveal it as well", () => {
    // Assistive-technology "activation" is a click dispatched straight to the element, bypassing the
    // pointer-events hit test — the action already works; revealing only keeps the UI from sitting
    // in "the button is invisible but was just pressed".
    expect(headerTag).toContain('aria-label={t("Site action bar")}');
    expect(headerTag).toContain("onClickCapture");
  });

  it("the always-on handle is the proper entry point for pointers / assistive technology, with full disclosure semantics", () => {
    const handle = block(viewer, 'className="fs-handle"', "</button>");
    expect(handle).toContain("aria-expanded={barOpen}");
    expect(handle).toContain('aria-controls="fs-bar"');
    expect(viewer).toContain('id="fs-bar"'); // aria-controls points at something real
  });
});

describe("C5 the More menu folds the secondary actions", () => {
  const menu = read("src/components/more-menu.tsx");
  it("the secondary actions sit inside the menu, the primary ones stay on the bar", () => {
    const controls = block(viewer, 'className="controls"', "</div>\n        </header>");
    const menuBlock = block(controls, "<MoreMenu", "</MoreMenu>");
    // The bare artifact moved into the menu with the design pass; Edit and the device switch stay on the bar.
    expect(menuBlock).not.toContain('aria-label={t("Preview device")}');
    expect(menuBlock).toContain('{t("Open in new window")}');
    expect(menuBlock).toContain('<VersionHistory variant="menu-item"');
    expect(menuBlock).toContain('onClick={fork}');
    expect(menuBlock).toContain('className="menu-item fs-mode"');
    // The owner's window into the administration log sits in the menu too, owner-only.
    expect(menuBlock).toContain('{permissions.canManageSharing && <AdminActivity slug={slug} onOpenChange={onActivityOpen} />}');
    const before = controls.slice(0, controls.indexOf("<MoreMenu"));
    expect(before).toContain('href={`/s/${slug}/edit`}'); // edit is a first-class button on the bar
    expect(before).toContain('className="segmented device-switch"'); // and so is the device preview
    expect(before).toContain('<SharePanel');
  });
  it("is hidden, not unmounted, when closed — VersionHistory owns the state of the drawer it opens, and unmounting it would close the drawer in the same tick", () => {
    expect(menu).toContain("hidden={!open || !pos}");
    expect(menu).not.toMatch(/open && pos && host && createPortal/);
    // The UA's [hidden] rule loses to the author's display: flex; the CSS has to say it again.
    expect(cssCode).toMatch(/\.more-menu\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });
  it("closes on window blur — a click into the artifact is a pointerdown inside the iframe, which never reaches this document", () => {
    const effect = block(menu, "if (!open) return;", "}, [open, place]);");
    expect(effect).toContain('window.addEventListener("blur", onBlur)');
    expect(effect).toContain('window.removeEventListener("blur", onBlur)');
  });
  it("holds the action bar open while the menu is open, like every other drawer", () => {
    expect(viewer).toContain('const onMenuOpen = useCallback((open: boolean) => setDrawerOpen("menu", open), [setDrawerOpen]);');
    expect(viewer).toContain("<MoreMenu label={t(\"More\")} iconOnly onOpenChange={onMenuOpen}>");
  });
});

describe("C4 dead code / duplicated values", () => {
  /** All component sources under src, used to decide whether a class name is still referenced anywhere. */
  const sources = readdirSync(abs("src"), { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".tsx"))
    .map((p) => readFileSync(abs(`src/${p}`), "utf8"))
    .join("\n");

  it("globals.css has no unreferenced class in the fs- / viewer- namespaces", () => {
    const declared = new Set(
      [...cssCode.matchAll(/\.(fs-[a-z][a-z0-9-]*|viewer(?:-[a-z][a-z0-9-]*)?)\b/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(5); // the regex really matched something
    const orphans = [...declared].filter((cls) => !sources.includes(cls));
    expect(orphans, `globals.css 里这些类已经没人用了：${orphans.join(", ")}`).toEqual([]);
  });

  it("the device breakpoints exist in one copy only (the full-screen one)", () => {
    expect(cssCode.match(/834px/g), "834px 被复制成了两份").toHaveLength(1);
    expect(cssCode.match(/\b400px/g), "400px 被复制成了两份").toHaveLength(1);
    expect(cssCode).toContain('.fs-viewer[data-device="tablet"] .fs-stage { max-width: 834px; }');
  });

  it("braces and comments balance — when a merge-conflict marker eats a boundary } or /*, tsc / eslint / every other test misses it", () => {
    let depth = 0, minDepth = 0, i = 0;
    let quote: string | null = null;
    let unterminatedComment = false, strayCommentEnd = false;
    while (i < css.length) {
      const ch = css[i];
      if (quote) {
        if (ch === "\\") { i += 2; continue; }
        if (ch === quote) quote = null;
        i += 1; continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
      if (ch === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        if (end === -1) { unterminatedComment = true; break; }
        i = end + 2; continue;
      }
      if (ch === "*" && css[i + 1] === "/") { strayCommentEnd = true; i += 2; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth < minDepth) minDepth = depth; }
      i += 1;
    }
    expect(unterminatedComment, "有个 /* 没关").toBe(false);
    expect(strayCommentEnd, "有个 */ 没有对应的 /*").toBe(false);
    expect(minDepth, "有个多余的 }").toBe(0);
    expect(depth, "有个 { 没关").toBe(0);
    expect(quote, "有个引号没关").toBeNull();
  });
});

describe("C5 no action on the bar may go missing", () => {
  const header = block(viewer, "<header", "</header>");
  const controls = block(viewer, '<div className="controls">', "</header>");

  it("every action is anchored to a concrete handler / href / component", () => {
    // This used to grep for words like "编辑" (Edit) and "复制链接" (Copy link) that are trivially present in the source file — which tested nothing.
    for (const [action, marker] of [
      ["设备切换", 'aria-label={t("Preview device")}'],

      ["另存为新站点", "onClick={fork}"],
      ["版本历史", "<VersionHistory"],
      ["分享设置", "<SharePanel"],
      ["登录/登出", "<AuthButton"],
      ["编辑", "href={`/s/${slug}/edit`}"],
      // Switched from aria-label to visible text: it used to be the only unnamed button on the bar, a
      // bare external-link arrow, and elsewhere that arrow reads as "share" — inviting exactly "copy
      // this address and send it", but it is the artifact's own address, and on a private site the
      // recipient only gets a 404.
      ["新窗口打开", '{t("Open in new window")}'],
      ["私有站点的分享指引", 'className="share-hint"'],
    ] as const) {
      expect(controls, `.controls 里缺少动作：${action}`).toContain(marker);

    // The visibility chip hangs in the title area, not the button area: it answers "what kind of
    // site is this", not "what can I do to it". Pin the position itself — moved into the button pile
    // it reads as one more clickable action.
    expect(viewer).toMatch(/viewer-meta[\s\S]{0,400}<VisibilityChip/);
    }
    expect(header, "缺少返回").toContain('aria-label={t("Back to sites")}');
    expect(header, "缺少标题重命名").toContain('title={t("Click to rename")}');
  });

  it("no copy-link on the action bar — it lives only in the share panel, right next to the visibility scope", () => {
    // Copying from the bar, you cannot see what scope you are sending out; that is exactly why it
    // was moved. This tests "moved", not "gone": the copy entry still exists, just elsewhere, so
    // both sides are asserted.
    expect(controls).not.toContain("copyLink");
    expect(controls).not.toContain('t("Copy link")');
    expect(share).toContain("share-foot");
    expect(share).toContain("Copy link");
  });

  it("the panel copies the read-only link and must never include the edit token", () => {
    const copy = block(share, "async function copyCanonical()", "\n  }");
    expect(copy).toContain("`${window.location.origin}/s/${slug}`");
    expect(copy).not.toContain("?t=");
    expect(viewer).not.toContain("async function shareEditable");
    expect(viewer).toContain("permissions.canRename");

  });

  it("identity is always the rightmost item on the action bar", () => {
    // No action may follow the user name. One drift and the muscle memory is gone — and user settings still have to grow here.
    const after = controls.slice(controls.lastIndexOf("<AuthButton"));
    expect(after).not.toContain("<Link");
    expect(after).not.toContain("<button");
    expect(after).not.toContain("<LockedAction");
    expect(after).not.toContain("href=");
  });

  it("login-only actions degrade to LockedAction without permission instead of disappearing", () => {
    expect(controls).toContain('<LockedAction label={t("Sharing settings")}');
    expect(controls).toContain('<LockedAction label={t("Edit")}');
  });
});

describe("full-screen preview: the rest of the action bar's structure", () => {
  it("keeps the parent-owned top hot zone — the only way to see the pointer once it is over the iframe", () => {
    expect(viewer).toContain("fs-hotzone");
    expect(cssCode).toContain(".fs-hotzone");
  });

  it("slides the bar with top, never transform (transform would trap the fixed drawers)", () => {
    const bar = ruleBody(".fs-chrome .fs-bar");
    expect(bar).toContain("var(--fs-bar-h)");
    expect(bar).not.toContain("transform");
    // .app-header's own backdrop-filter also creates a containing block; it must be switched off on the full-screen bar.
    expect(bar).toContain("backdrop-filter: none");
  });

  it("fills the viewport and still honours the device toggle", () => {
    expect(viewer).toContain("data-device={device}");
    expect(cssCode).toContain('.fs-viewer[data-device="tablet"] .fs-stage');
    expect(cssCode).toContain('.fs-viewer[data-device="mobile"] .fs-stage');
  });
});

// User feedback: the action bar slides out over the top of the artifact's content. After changing
// to "the bar slides down and the artifact moves aside in step", losing any one of these contracts
// falls back to either "covered" or "bottom cropped" — the same problem showing up in a different place.
describe("full-screen preview: the action bar pushes the artifact aside instead of covering it", () => {
  it("the stage as a whole moves down by one bar height when open (and back to top:0 when collapsed)", () => {
    // inset:0 is the collapsed baseline; it yields only under data-bar="open".
    expect(cssCode).toMatch(/\.fs-stage-wrap\s*\{[^}]*inset:\s*0/);
    expect(cssCode).toMatch(/\.fs-viewer\[data-bar="open"\] \.fs-stage-wrap \{ top: var\(--fs-bar-h\);/);
    expect(viewer).toContain('data-bar={barOpen ? "open" : "closed"}');
  });

  it("yielding uses top, not transform — transform does not shrink the height, it only crops the artifact's bottom", () => {
    const wrap = cssCode.slice(cssCode.indexOf(".fs-stage-wrap {"));
    const block = wrap.slice(0, wrap.indexOf("}"));
    expect(block).toContain("transition: top var(--fs-slide-out) linear");
    expect(block).not.toContain("transform");
  });

  it("bar and stage share the same duration curve, or it reads as two things moving independently rather than a 'push'", () => {
    // Only requires that both variables are defined (the actual seconds are a feel knob, see the test
    // below); the point is that all three elements reference the same pair of variables — separate
    // numbers would look like "the bar and the artifact each doing their own thing" rather than a push.
    expect(cssCode).toMatch(/--fs-slide:\s*[\d.]+s/);
    expect(cssCode).toMatch(/--fs-slide-out:\s*[\d.]+s/);
    expect(cssCode).toMatch(/\.fs-chrome\.is-open \.fs-bar \{[^}]*transition: top var\(--fs-slide\) linear/);
    expect(cssCode).toMatch(/\.fs-viewer\[data-bar="open"\] \.fs-stage-wrap \{[^}]*transition: top var\(--fs-slide\) linear/);
  });

  it("--fs-bar-h must be set on .fs-viewer — stage and bar are siblings, and variables do not travel sideways", () => {
    // Set on .fs-chrome the stage cannot read it, and the offset falls back to the CSS default instead of the measured bar height.
    expect(viewer).toContain('viewer.style.setProperty("--fs-bar-h"');
    expect(viewer).not.toContain('chrome.style.setProperty("--fs-bar-h"');
    expect(cssCode).toMatch(/\.fs-viewer\s*\{[^}]*--fs-bar-h:/);
  });

  // The artifact yields only one bar height, while the chrome layer is taller than the bar (the
  // handle's extra 20px). Those 20px are invisible but swallow clicks, sitting right on top of the
  // pushed-down artifact — before the push the bar covered that area anyway, so this never showed.
  it("when open the whole layer ignores pointer events; only the bar and the handle take them", () => {
    expect(ruleBody(".fs-chrome.is-open")).toContain("pointer-events: none");
    expect(cssCode).toContain(".fs-chrome.is-open .fs-bar, .fs-chrome.is-open .fs-handle { pointer-events: auto; }");
    // The collapsed state is the opposite: the hot zone is the only way to summon the bar, so it must take events then.
    expect(cssCode).not.toContain(".fs-chrome { pointer-events: none");
  });

  // User requirement: coming down holds 0.5s, going back is twice as fast. A CSS transition uses the
  // transition of the state **after** the change, so the two durations must live on two rules:
  // opening matches [data-bar="open"], collapsing falls back to the base rule. One shared variable
  // can only give the same speed both ways.
  it("slow down, fast up: the two durations hang on the open-state and collapsed-state rules respectively", () => {
    const dur = (name: string) => {
      const m = cssCode.match(new RegExp(`--${name}:\\s*([\\d.]+)s`));
      return m ? Number(m[1]) : NaN;
    };
    const inS = dur("fs-slide"), outS = dur("fs-slide-out");
    expect(inS).toBeGreaterThan(0);
    expect(outS).toBeGreaterThan(0);
    // The exact ratio is a feel knob (tuned from .5/.25 to .3/.1); pinning it just means every tuning
    // pass edits the test. What really matters is the intent: collapsing is clearly faster than
    // opening, and both are still in the "visibly an animation" range.
    expect(outS, "收回必须明显快于下来").toBeLessThan(inS * 0.75);
    expect(inS, "下来别慢到碍事").toBeLessThanOrEqual(0.6);

    // The collapsed state (base rule) uses out; the open state overrides to in — for all three moving
    // elements. Note: locate by "the rule block that has a transition": the same selector may have
    // several rules (.fs-handle has another that only handles pointer-events), and taking the first
    // would break on the block without a transition.
    for (const sel of [".fs-stage-wrap", ".fs-chrome .fs-bar", ".fs-handle"]) {
      const blocks = [...cssCode.matchAll(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "g"))]
        .map((m) => m[1])
        .filter((b) => b.includes("transition:"));
      expect(blocks.length, `${sel} 应有一个带 transition 的规则块`).toBeGreaterThan(0);
      expect(blocks.some((b) => b.includes("var(--fs-slide-out)")), `${sel} 收起时应用 --fs-slide-out`).toBe(true);
    }
    expect(cssCode).toMatch(/\.fs-chrome\.is-open \.fs-bar \{[^}]*transition: top var\(--fs-slide\) linear/);
    expect(cssCode).toMatch(/\.fs-chrome\.is-open \.fs-handle \{[^}]*transition: top var\(--fs-slide\) linear/);
  });

  it("under prefers-reduced-motion it snaps into place, with no half-second full-screen shift", () => {
    expect(cssCode).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.fs-viewer \{ --fs-slide: 0s; --fs-slide-out: 0s; \}/);
  });
});

describe("home page hero", () => {
  // The hero's copy half; the other half is the motion.
  const hero = home.slice(home.indexOf('<div className="hero-copy">'), home.indexOf('<HeroMotion'));

  it("is one headline and one line of prose — nothing else", () => {
    expect(hero.match(/<h1>/g)).toHaveLength(1);
    expect(hero.match(/className="deck"/g)).toHaveLength(1);
    expect(hero).not.toContain("eyebrow");
  });

  it("keeps the prose to a single sentence", () => {
    const deck = hero.slice(hero.indexOf('className="deck"'));
    // The copy is the English key inside `{t("…")}`; unwrap it so the budget applies to the words.
    const text = deck.slice(deck.indexOf(">") + 1, deck.indexOf("</p>")).replace(/^\{t\("(.*)"\)\}$/, "$1");
    expect(text.length).toBeLessThanOrEqual(80); // one line's budget (English); over budget means rewrite, not squeeze
    expect(text.match(/[.。]/g)).toHaveLength(1);
  });
});
