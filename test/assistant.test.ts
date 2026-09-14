// Assistant edit tier — the two pieces of the mount that ARE contracts with the external panel:
// the context extra-field shape (contract 1) and the host-authored suggestions (contract 0).
// The component itself is a browser concern; what must never drift silently is the payload the
// envelope will carry, so that is what gets pinned.
import { afterEach, describe, expect, it } from "vitest";
import { buildAssistantContext, ASSISTANT_SUGGESTIONS, type AssistantSite } from "@/components/assistant";

const SITE: AssistantSite = {
  slug: "UQPCeOH851sc",
  title: "实习答辩",
  kind: "folder",
  version: 4,
  versionId: "ver_abc",
};

describe("buildAssistantContext — contract 1 (host extra fields)", () => {
  it("carries the edit coordinates under the artifactHub namespace", () => {
    expect(buildAssistantContext(SITE, "https://artifact-site.example.com")).toEqual({
      artifactHub: {
        slug: "UQPCeOH851sc",
        version: 4,
        versionId: "ver_abc",
        kind: "folder",
        apiBase: "https://artifact-site.example.com",
        skill: "https://artifact-site.example.com/for-agents.md",
      },
    });
  });

  // The first joint run died here: Codex edited correctly, then guessed at the publish API and
  // got a 403 it could not act on — the envelope named the artifact but not the manual, and the
  // manual is where obtaining a token is explained. Coordinates without instructions are a
  // dead end for an agent meeting this platform for the first time.
  it("names the manual, not just the site — an agent must be able to find how to publish", () => {
    const ctx = buildAssistantContext(SITE, "https://hub.example");
    expect((ctx.artifactHub as Record<string, unknown>).skill).toBe("https://hub.example/for-agents.md");
  });

  it("degrades to NO coordinates once off an editable page — never a stale site", () => {
    // The component clears the module box on unmount; the callback must then hand the panel
    // nothing, so the envelope falls back to the SDK's own title/url collection.
    expect(buildAssistantContext(null, "https://x")).toEqual({});
  });
});

describe("ASSISTANT_SUGGESTIONS — contract 0 limits", () => {
  it("both tiers stay within the mount option's clamps (≤4 items, label ≤20, prompt ≤500)", () => {
    for (const tier of ["edit", "qa"] as const) {
      expect(ASSISTANT_SUGGESTIONS[tier].length).toBeLessThanOrEqual(4);
      for (const s of ASSISTANT_SUGGESTIONS[tier]) {
        expect(s.label.length).toBeLessThanOrEqual(20);
        expect(s.prompt.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("the edit tier points the agent at the manual inside the request itself", () => {
    const modify = ASSISTANT_SUGGESTIONS.edit.find((s) => s.label.includes("Modify"));
    expect(modify?.prompt).toContain("artifactHub.skill");
  });

  it("the QA tier never suggests an action the reader cannot take", () => {
    expect(ASSISTANT_SUGGESTIONS.qa.some((s) => /modify|publish/i.test(s.prompt))).toBe(false);
  });
});

// --- Toning down the floating launcher ball -----------------------------------
//
// The ball is drawn inside a mode:"closed" shadow root; our only handle on it is its ordinary
// DOM host anchor. That means this logic is built on "the SDK's internals look like this" — so the
// most important test is not a feature but the rule that it MUST back off quietly when it cannot
// recognise the anchor: better to lose the nicety than to drag the page down.
import { vi } from "vitest";
import { installLauncherAffordance, LAUNCHER_HIDDEN_OPACITY, LAUNCHER_PEEK_PX, LAUNCHER_REST_OPACITY } from "@/components/assistant";

function launcherStub({ z = "2147483000", ballLeft = 1844 }: { z?: string; ballLeft?: number } = {}) {
  const on: Record<string, Array<(e: unknown) => void>> = {};
  const style: Record<string, string> = { zIndex: z, transition: "", opacity: "", transform: "" };
  // Production code keeps non-elements out with `instanceof HTMLElement`, so the stub must be a
  // real instance of that class, not merely a look-alike object literal.
  class FakeElement {}
  const host = Object.assign(new FakeElement(), {
    tagName: "DIV",
    style,
    contains: () => false,
    addEventListener: (t: string, fn: (e: unknown) => void) => { (on[t] ??= []).push(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { on[t] = (on[t] ?? []).filter((f) => f !== fn); },
  });
  vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 958 });
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", {
    documentElement: { children: [host] },
    // Hit test: the ball occupies [ballLeft, 1895]
    elementFromPoint: (x: number) => (x >= ballLeft && x <= 1895 ? host : null),
  });
  return { host, style, fire: (t: string, e: unknown = { preventDefault() {} }) => (on[t] ?? []).forEach((f) => f(e)), listeners: on };
}

describe("floating launcher — dimmer at rest, collapsible, leaves a sliver peeking when collapsed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("backs off quietly when the host anchor is not recognised: no throw, no trace", () => {
    const s = launcherStub({ z: "999" }); // the SDK changed its implementation / its z-index
    let release: (() => void) | undefined;
    expect(() => { release = installLauncherAffordance(); }).not.toThrow();
    expect(() => release?.()).not.toThrow();
    expect(s.style.opacity).toBe(""); // not a single byte of someone else's styles was touched
  });

  it("once installed, the resting state is translucent — the artifact is the star", () => {
    const s = launcherStub();
    installLauncherAffordance();
    expect(s.style.opacity).toBe(LAUNCHER_REST_OPACITY);
    expect(s.style.transition).toContain("transform");
  });

  it("right-click collapses: pushes the ball out leaving only a sliver, and swallows the browser context menu", () => {
    const s = launcherStub({ ballLeft: 1844 });
    installLauncherAffordance();
    let defaultPrevented = false;
    s.fire("contextmenu", { preventDefault: () => { defaultPrevented = true; } });

    expect(defaultPrevented).toBe(true);
    expect(s.style.opacity).toBe(LAUNCHER_HIDDEN_OPACITY);
    // push distance = viewport width - peek width - ball left edge: 1920 - 10 - 1844 = 66
    expect(s.style.transform).toBe(`translateX(${1920 - LAUNCHER_PEEK_PX - 1844}px)`);
  });

  it("touching the sliver pops the whole ball out and clickable; it tucks back in when the pointer leaves", () => {
    const s = launcherStub();
    installLauncherAffordance();
    s.fire("contextmenu");
    expect(s.style.transform).toBe("translateX(66px)");

    s.fire("mouseenter");
    // After popping out it does NOT return to its original position (that would self-oscillate,
    // see the implementation comment) but to the spot that just covers the sliver:
    // push 66 - (ball width 52 - peek 10) = 24
    expect(s.style.transform).toBe("translateX(24px)");
    expect(s.style.opacity).toBe("1"); // no longer translucent, safe to click

    s.fire("mouseleave");
    expect(s.style.opacity).toBe(LAUNCHER_HIDDEN_OPACITY); // still remembers it is collapsed
    expect(s.style.transform).toBe("translateX(66px)");
  });

  // This is the linchpin of the whole interaction. The pointer resting on the sliver triggers the
  // pop-out; if the popped-out ball no longer covers the pointer, the browser immediately fires a
  // mouseleave → tuck back → the pointer is on the sliver again → pop out again, dozens of times a
  // second: visually a twitch, and in practice the ball CANNOT be clicked at all (it has already
  // moved away by the moment of the press).
  it("after popping out it must still cover the sliver under the pointer — otherwise hover self-oscillates and the ball cannot be clicked", () => {
    const ballLeft = 1844, ballWidth = 52, viewport = 1920;
    const s = launcherStub({ ballLeft });
    installLauncherAffordance();
    s.fire("contextmenu");
    s.fire("mouseenter");

    const dx = Number(/translateX\((-?\d+)px\)/.exec(s.style.transform)?.[1]);
    const ballRight = ballLeft + dx + ballWidth - 1;   // right edge of the ball after popping out
    const peekRight = viewport - 1;                     // rightmost column of the sliver (flush with the viewport edge)
    const peekLeft = viewport - LAUNCHER_PEEK_PX;
    expect(ballLeft + dx).toBeLessThanOrEqual(peekLeft); // left edge reaches the sliver's left end
    expect(ballRight).toBeGreaterThanOrEqual(peekRight); // right edge reaches the sliver's right end
  });

  it("moving the pointer away while not collapsed returns to translucent, not to hidden", () => {
    const s = launcherStub();
    installLauncherAffordance();
    s.fire("mouseenter");
    expect(s.style.opacity).toBe("1");
    s.fire("mouseleave");
    expect(s.style.opacity).toBe(LAUNCHER_REST_OPACITY);
    expect(s.style.transform).toBe("");
  });

  it("the collapsed state lives only in memory — nothing is persisted, a reload restores the default", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null, removeItem: vi.fn() });
    const s = launcherStub();
    installLauncherAffordance();
    s.fire("contextmenu");
    expect(setItem).not.toHaveBeenCalled();
    expect(s.style.opacity).toBe(LAUNCHER_HIDDEN_OPACITY);
  });

  it("uninstalling restores every modified style exactly as it was", () => {
    const s = launcherStub();
    s.style.opacity = "0.9"; s.style.transition = "none"; s.style.transform = "scale(2)";
    const release = installLauncherAffordance();
    s.fire("contextmenu");
    release();
    expect(s.style.opacity).toBe("0.9");
    expect(s.style.transition).toBe("none");
    expect(s.style.transform).toBe("scale(2)");
    expect(s.listeners.contextmenu?.length ?? 0).toBe(0);
  });
});
