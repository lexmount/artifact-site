"use client";

// The floating assistant on the /s/ viewer (an external, deployment-provided AI panel) — the "edit tier" of the embed:
// rendered ONLY when the deployment configured ARTIFACT_ASSISTANT_URL and the viewer holds
// canEditContent, so the ball appears exactly where "ask my Codex to edit this" is honourable.
// The SDK script is injected once per page load; the panel instance is mounted on entering an
// editable site page and unmounted on leaving it, which keeps the ball's presence aligned with
// the permission that justified it.
//
// The context callback deliberately reads a module-level box instead of closing over props:
// App Router client navigation swaps props without reloading the page, and a closure would keep
// handing the panel the PREVIOUS site's coordinates. The box is updated by effect on every
// prop change and cleared on unmount, so off /s/ pages the panel falls back to the SDK's own
// title/url collection with no edit coordinates at all.
import { useEffect } from "react";
import { currentArtifactSelection, installSelectionBridge, type ArtifactSelection } from "@/components/selection-bridge";
import { useT } from "@/components/locale-provider";

export interface AssistantSite {
  slug: string;
  title: string;
  kind: string;
  /** Ordinal of the version the viewer is looking at (= version count; newest). */
  version: number;
  /** Exact version id — the base for optimistic-locked write-backs (contract 1). */
  versionId: string;
}

/** A selection older than this is stale — the user has long moved on, and quoting it back
 *  would be worse than quoting nothing. */
export const SELECTION_FRESH_MS = 10 * 60_000;

/** Contract 1: everything beyond the SDK's four standard fields is host extra data, passed
 *  through into the envelope's material section. `artifactHub` is our namespace. `selection`
 *  IS one of the SDK's standard fields — handing it here overrides the SDK's own collection,
 *  which only ever sees the host page (the artifact's selection lives behind an opaque origin).
 *
 *  A null `site` is the Q&A tier (and the moment after leaving an editable page): the reader's
 *  selection still travels, the EDIT COORDINATES never do — a share-link reader gets an
 *  assistant that can discuss what they see, not a map to the write APIs (which would refuse
 *  them anyway; this just keeps the envelope as honest as the permission). */
export function buildAssistantContext(
  site: AssistantSite | null,
  origin: string,
  selection?: ArtifactSelection | null,
  now?: number,
): Record<string, unknown> {
  const fresh = selection && (now ?? Date.now()) - selection.at < SELECTION_FRESH_MS ? selection : null;
  const base: Record<string, unknown> = fresh ? { selection: fresh.text } : {};
  if (!site) return base;
  return {
    ...base,
    artifactHub: {
      slug: site.slug,
      version: site.version,
      versionId: site.versionId,
      kind: site.kind,
      apiBase: origin,
      // The manual, not just the coordinates. An agent reaching this envelope has never seen this
      // platform: without an address for the instructions it guesses at endpoints and gets a 403
      // it cannot interpret (observed in the first joint run). The doc's own first section is how
      // it obtains a token, so this one field is what turns "I know the slug" into "I can publish".
      skill: `${origin}/for-agents.md`,
      ...(fresh?.path ? { selectionPath: fresh.path } : {}),
    },
  };
}

export type AssistantMode = "edit" | "qa";

/** Contract 0: host-authored quick suggestions (≤4, label ≤20 chars, prompt ≤500). Harmless to
 *  send before the panel learns to render them — unknown mount options are ignored. The Q&A-tier
 *  set has no "modify" entry: never suggest an action the reader cannot take.
 *  English source copy; the component runs each label/prompt through `t` at mount time. */
export const ASSISTANT_SUGGESTIONS: Record<AssistantMode, ReadonlyArray<{ label: string; prompt: string }>> = {
  edit: [
    { label: "Explain selection", prompt: "Explain what I selected on the page." },
    {
      label: "Modify this artifact",
      // Names the manual inside the request itself: the suggestion is often an agent's first
      // contact with this platform, and by the time it has read the doc it also knows to get a
      // publish token (the doc leads with the device-authorization flow).
      prompt: "Modify this artifact according to my selection and instructions, then publish it as a new version. First read the manual at artifactHub.skill in the context (it includes the steps to obtain a publish token) and follow it.",
    },
    { label: "Summarize artifact", prompt: "Summarize the key points of this artifact." },
  ],
  qa: [
    { label: "Explain selection", prompt: "Explain what I selected on the page." },
    { label: "Summarize content", prompt: "Summarize the key points of this content." },
  ],
};

/**
 * Contract 2: what the assistant offers when the reader HIGHLIGHTS something (the SDK draws a small
 * toolbar over the selection). Declared per tier for the same reason the suggestions are:
 *
 *   · The SDK's built-in default is "Explain / Rewrite", and Rewrite is wrong here — this platform's unit
 *     of change is a published version, not an in-place rewrite of whatever is on screen. Left
 *     undeclared, that default appears over our own page chrome the moment the SDK ships.
 *   · The Q&A tier gets NO write action at all. A share-link reader holds `allow_ai`, not edit rights,
 *     so offering "Edit this" would be an invitation to a 403 — same rule as the suggestions above:
 *     never propose an action the reader cannot take.
 *
 * The edit action names the manual for the same reason "Modify this artifact" does: an agent meeting this
 * platform for the first time needs the address of the instructions (and of the token flow) inside
 * the request itself, or it guesses at endpoints and gets a 403 it cannot interpret.
 */
export const ASSISTANT_SELECTION_ACTIONS: Record<AssistantMode, ReadonlyArray<{ label: string; prompt: string }>> = {
  edit: [
    { label: "Explain", prompt: "Explain what I selected on the page." },
    {
      label: "Edit this",
      prompt: "Modify this artifact according to my selection, then publish it as a new version. First read the manual at artifactHub.skill in the context (it includes the steps to obtain a publish token) and follow it.",
    },
  ],
  qa: [
    { label: "Explain", prompt: "Explain what I selected on the page." },
  ],
};

/**
 * Toning down the floating ball's presence — fainter at rest, right-click to tuck it away, only a sliver left
 * showing once tucked, and a touch brings it back out.
 *
 * Why reach into the SDK's ball at all: it is fixed to the bottom-right corner, opaque, and sits on top of the
 * artifact. It has covered the footer text of the sharing drawer before (measured during the regression: the ball
 * at x1870/y908 landed exactly on that footer line). The artifact is the lead on this page and the assistant is a
 * supporting role, and a supporting role should not be welded to the front of the stage.
 *
 * Why this is possible at all: the ball itself is drawn inside a `mode:"closed"` shadow root, and we cannot touch
 * a single pixel inside; but its host anchor is an ordinary DOM node, and `opacity` / `transform` applied to the
 * anchor carry the whole shadow tree along. That is the only point of leverage, and therefore **inherently
 * fragile**: recognition relies on the inline style string the SDK hardcodes. So when it is not recognized, give
 * up quietly (`installLauncherAffordance` returns an empty cleanup function), the ball falls back to the SDK's
 * original look, and the rest of the page carries on as usual — this is a nicety, not worth any risk.
 *
 * On "the mouse coming near": on `/s/` pages the artifact iframe fills the viewport, and once the pointer enters
 * the artifact the host page never receives mouse events again. So there is no such thing as "pop out when
 * nearby" — only the sliver left showing can catch a hover. An invisible sensing area is no good either: it would
 * block the user's clicks on the artifact's bottom-right corner, the exact opposite of why the ball is tucked away.
 */
const LAUNCHER_HOST_Z = "2147483000";
/** The sliver that stays on screen once tucked away, about 1/5 of the ball's diameter (measured ball: 52px). Large enough for the pointer to hit. */
export const LAUNCHER_PEEK_PX = 10;
/** Measured fallback: a 52px ball + 24px right margin. Used only when hit testing fails; being off by a few pixels is harmless. */
const LAUNCHER_FALLBACK_INSET = 76;
const LAUNCHER_FALLBACK_SIZE = 52;
export const LAUNCHER_REST_OPACITY = "0.55";
export const LAUNCHER_HIDDEN_OPACITY = "0.25";

function findLauncherHost(): HTMLElement | null {
  // Note: it is mounted under <html>, not under <body>.
  for (const el of document.documentElement.children) {
    if (el instanceof HTMLElement && el.tagName === "DIV" && el.style.zIndex === LAUNCHER_HOST_Z) return el;
  }
  return null;
}

/**
 * The ball's left edge and width on screen — how far to push it out, and where to return to when it pops back,
 * are both computed from these two numbers. The anchor is 0×0, so measuring it is meaningless, and the ball's size
 * is locked away inside the closed shadow root where it cannot be read. So it is scanned the other way round, by hit
 * testing: walking left from the bottom-right corner, the stretch where `elementFromPoint` still resolves to this
 * anchor is the ball. Several heights are scanned because the ball's diameter may change in future, and betting on
 * a single line could miss entirely.
 */
function launcherBox(host: HTMLElement): { left: number; width: number } {
  const inside = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    return el === host || host.contains(el);
  };
  for (const y of [window.innerHeight - 50, window.innerHeight - 36, window.innerHeight - 64]) {
    let right: number | null = null;
    for (let x = window.innerWidth - 1; x > window.innerWidth - 220; x -= 2) {
      if (inside(x, y)) { right = x; break; }
    }
    if (right === null) continue;
    for (let x = right; x > right - 220; x -= 2) {
      if (!inside(x, y)) return { left: x + 1, width: right - x };
    }
  }
  return { left: window.innerWidth - LAUNCHER_FALLBACK_INSET, width: LAUNCHER_FALLBACK_SIZE };
}

export function installLauncherAffordance(): () => void {
  const host = findLauncherHost();
  if (!host) return () => {};

  const box = launcherBox(host);
  const push = Math.max(0, window.innerWidth - LAUNCHER_PEEK_PX - box.left);
  /**
   * Popping out from the tucked state does **not** return to the original position, only to "just covering the sliver".
   *
   * Returning to the original position self-oscillates: the pointer resting on the sliver (say x=1915) triggers the
   * pop-out, the ball flies back to its original position and is no longer under the pointer, immediate mouseleave →
   * tuck back → the pointer lands on the sliver again → pop out again... dozens of round trips per second, which
   * looks like a twitch. The root cause is "a hover-triggered action moved its own trigger area away".
   *
   * By making the popped-out ball's right edge sit exactly on the sliver's right edge, whichever column of the sliver
   * the pointer lands in, it is still on the ball after the pop-out, and mouseleave only fires when the pointer is
   * genuinely moved away. The whole ball is still visible and clickable, just hugging the edge a bit more than at rest.
   */
  const peekPush = Math.max(0, push - (box.width - LAUNCHER_PEEK_PX));
  const restore = { transition: host.style.transition, opacity: host.style.opacity, transform: host.style.transform };
  host.style.transition = "transform .22s ease, opacity .22s ease";
  host.style.opacity = LAUNCHER_REST_OPACITY;

  // The tucked state deliberately lives only in memory: a refresh returns to the default look. Tucking means "get
  // out of my way right now", not a preference worth remembering — having to recall how to get it back the next
  // time the page opens would be the real nuisance.
  let hidden = false;

  const settle = () => {
    host.style.transform = hidden ? `translateX(${push}px)` : "";
    host.style.opacity = hidden ? LAUNCHER_HIDDEN_OPACITY : LAUNCHER_REST_OPACITY;
  };
  // mouseenter/mouseleave are used for the pointer being over the ball (including inside the shadow root): they are
  // judged on "the element and its descendants", which covers the shadow subtree exactly, and unlike mouseover they
  // do not fire repeatedly while moving between inner elements.
  const onEnter = () => {
    host.style.transform = hidden ? `translateX(${peekPush}px)` : "";
    host.style.opacity = "1";
  };
  const onLeave = () => settle();
  const onContextMenu = (event: Event) => { event.preventDefault(); hidden = true; settle(); };

  host.addEventListener("mouseenter", onEnter);
  host.addEventListener("mouseleave", onLeave);
  host.addEventListener("contextmenu", onContextMenu);

  return () => {
    host.removeEventListener("mouseenter", onEnter);
    host.removeEventListener("mouseleave", onLeave);
    host.removeEventListener("contextmenu", onContextMenu);
    host.style.transition = restore.transition;
    host.style.opacity = restore.opacity;
    host.style.transform = restore.transform;
  };
}

type AssistantInstance = { open(): void; close(): void; unmount(): void };
type AssistantGlobal = { mount(opts: Record<string, unknown>): AssistantInstance };

let currentSite: AssistantSite | null = null;
/** Which artifact this page shows. Both tiers need it — the Q&A tier carries no edit coordinates
 *  but still asks the bridge for ITS OWN selection, never whichever one was captured last. */
let currentSlug = "";
let scriptLoading: Promise<AssistantGlobal | null> | null = null;

/** Inject the SDK exactly once; later callers await the same promise. Resolves null on load
 *  failure — the assistant is an extra, never worth breaking the viewer over. A FAILED load
 *  also clears the cache (and its dead <script>), so the next editable page retries instead of
 *  losing the ball for the whole session over one network blip. A load that succeeds without
 *  exposing the global stays cached: that is a broken SDK build, and retrying cannot fix it. */
// The SDK contract: `<origin>/embed/cloud-desk.js` defines `window.CloudDesk` with a `mount()`
// (the names of the first implementation; any panel that serves that script and global fits).
function ensureSdk(sdkBase: string): Promise<AssistantGlobal | null> {
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve) => {
      const existing = (window as { CloudDesk?: AssistantGlobal }).CloudDesk;
      if (existing) return resolve(existing);
      const script = document.createElement("script");
      script.src = `${sdkBase}/embed/cloud-desk.js`;
      // The SDK is served cross-origin with ACAO:*; crossorigin opts into real error reporting
      // (and matches the integration guide's two-line snippet).
      script.crossOrigin = "anonymous";
      script.onload = () => resolve((window as { CloudDesk?: AssistantGlobal }).CloudDesk ?? null);
      script.onerror = () => {
        scriptLoading = null;
        script.remove();
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return scriptLoading;
}

export default function Assistant({ sdkBase, slug, site, mode = "edit" }: {
  sdkBase: string;
  /** The artifact this page shows. Selections are answered per-slug, so both tiers pass it. */
  slug: string;
  /** Edit coordinates — present only in edit mode; the Q&A tier mounts without them. */
  site?: AssistantSite;
  mode?: AssistantMode;
}) {
  const t = useT();
  // Keep the boxes current across client-side navigations between artifacts.
  useEffect(() => {
    currentSlug = slug;
    currentSite = mode === "edit" && site ? site : null;
  }, [slug, site, mode]);

  useEffect(() => {
    let instance: AssistantInstance | null = null;
    let releaseLauncher: (() => void) | null = null;
    let alive = true;
    installSelectionBridge();
    void ensureSdk(sdkBase).then((sdk) => {
      if (!sdk || !alive) return;
      instance = sdk.mount({
        channel: "artifact-hub",
        label: mode === "edit" ? t("Let AI edit this artifact") : t("Ask AI"),
        suggestions: ASSISTANT_SUGGESTIONS[mode].map((s) => ({ label: t(s.label), prompt: t(s.prompt) })),
        selectionActions: ASSISTANT_SELECTION_ACTIONS[mode].map((a) => ({ label: t(a.label), prompt: t(a.prompt) })),
        context: () => buildAssistantContext(currentSite, window.location.origin, currentArtifactSelection(currentSlug)),
      });
      // mount() creates the host anchor synchronously, so it is guaranteed to be found here (and if not, it is quietly skipped).
      releaseLauncher = installLauncherAffordance();
    });
    return () => {
      alive = false;
      releaseLauncher?.();
      currentSite = null;
      currentSlug = "";
      // Unmount on leaving the page: the ball's presence IS the permission (or share-flag) signal.
      // (mount() is idempotent in the SDK, so the next qualifying page simply mounts again.)
      try { instance?.unmount(); } catch { /* the assistant never breaks the viewer */ }
    };
  }, [sdkBase, mode, t]);

  return null;
}
