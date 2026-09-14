"use client";

// The host half of the artifact selection bridge (the frame half lives in lib/preview.ts).
//
// The artifact renders in an opaque-origin sandbox iframe, so text selected inside it is
// invisible to the host page's getSelection(). The injected reporter posts selections up;
// this module is the ONLY listener, and it treats every message as hostile until proven
// boring: the sender must be a live /api/preview iframe on THIS page, the payload is reduced
// to plain clamped text (control characters stripped), and everything else is ignored.
// What survives is still untrusted CONTENT — the envelope's "material, not instructions"
// declaration is the real injection boundary; this module just keeps the pipe narrow.
import { ARTIFACT_REFRESH_EVENT } from "@/components/site-version-watcher";

/** Where the selection sits, in the reporting frame's viewport coordinates. Geometry only. */
export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ArtifactSelection {
  text: string;
  /** Coarse anchor locator (tag#id chain, ≤5 levels) — a hint for locating the source, never a selector to trust. */
  path: string | null;
  /** When it was reported; stale selections (user moved on long ago) are not offered to the assistant. */
  at: number;
  /**
   * Frame-viewport rect of the selection, for placing the toolbar. Deliberately NOT part of the
   * assistant's envelope (see assistant.tsx buildAssistantContext, which reads text and path only):
   * where a passage sits on screen tells the model nothing, and pixel coordinates in a prompt are
   * just noise the reader never asked to send.
   */
  rect: SelectionRect | null;
}

export const SELECTION_TEXT_MAX = 2000;
export const SELECTION_PATH_MAX = 300;
/** Any coordinate past this is not a viewport position — a frame claiming it is being creative. */
export const SELECTION_RECT_MAX = 20_000;

/** Result of vetting one message: `null` = not ours / malformed (ignore entirely);
 *  `{ selection: null }` = a well-formed CLEAR (user dismissed their selection);
 *  `{ selection: {...} }` = a new selection. Exported pure for tests. */
export function parseSelectionMessage(data: unknown, now: number): { selection: ArtifactSelection | null } | null {
  if (data === null || typeof data !== "object") return null;
  const raw = (data as { __artifactSelection?: unknown }).__artifactSelection;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const textRaw = (raw as { text?: unknown }).text;
  if (typeof textRaw !== "string") return null;
  const text = textRaw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, SELECTION_TEXT_MAX).trim();
  if (!text) return { selection: null };
  const pathRaw = (raw as { path?: unknown }).path;
  const path = typeof pathRaw === "string" && pathRaw.trim()
    ? pathRaw.replace(/[^\w>#.-]/g, "").slice(0, SELECTION_PATH_MAX)
    : null;
  return { selection: { text, path, at: now, rect: parseRect((raw as { rect?: unknown }).rect) } };
}

/**
 * A rect survives only if every side is a finite number inside a plausible viewport, with real
 * extent. Same posture as the text: a frame is free to lie, and the worst a lie should buy it is
 * being ignored. Unbounded values would fling the toolbar off-screen (or onto a spot the reader
 * never selected) — a nuisance rather than a breach, but this module's whole job is keeping the
 * pipe narrow, and a rect is the one field a caller would otherwise pass straight to CSS.
 */
export function parseRect(raw: unknown): SelectionRect | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sides = [r.top, r.left, r.width, r.height];
  if (!sides.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [top, left, width, height] = sides as number[];
  if (width <= 0 || height <= 0) return null; // a collapsed caret is not something to point at
  if ([top, left, width, height].some((v) => Math.abs(v) > SELECTION_RECT_MAX)) return null;
  return { top, left, width, height };
}

/**
 * Only a window that IS one of this page's preview iframes may speak — and the answer is WHICH
 * site it shows, not merely yes/no. The slug is what keeps a selection from following the reader:
 * /s/ pages are reached by client-side navigation (next/link), so this module's state survives
 * moving from one artifact to another; without an owner recorded at capture time, a passage
 * highlighted in site A would ride along into site B's envelope.
 *
 * Runs per message (cheap: a handful of frames) so the bridge never holds a stale element
 * reference across SiteViewer's frameKey remounts.
 */
function slugOfFrame(frame: HTMLIFrameElement): string | null {
  const match = /\/api\/preview\/([^/?#]+)/.exec(frame.getAttribute("src") ?? "");
  if (!match) return null;
  // A malformed percent-sequence throws, and this now runs from resize/transitionend as well as
  // from message handling — one bad src would take out the whole repositioning pass, including
  // the frames after it in the loop. Unreadable means "not one of ours", same as a non-match.
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function previewFrameSlug(source: MessageEventSource | null): string | null {
  if (!source) return null;
  for (const frame of document.querySelectorAll("iframe")) {
    if (frame.contentWindow === source) return slugOfFrame(frame);
  }
  return null;
}

/** The live frame showing `slug`, looked up fresh every time — SiteViewer remounts it on refresh. */
function previewFrameFor(slug: string): HTMLIFrameElement | null {
  for (const frame of document.querySelectorAll("iframe")) {
    if (slugOfFrame(frame) === slug) return frame;
  }
  return null;
}

/**
 * What the toolbar is told: HOW LONG the selection is and WHERE it sits — never the text.
 *
 * The text stays on this page until the reader actually picks an action, at which point the
 * assistant collects it through the context callback. That ordering IS the privacy property of
 * the toolbar — highlighting a passage has not yet shared it with anything — so the payload is
 * built from `length` here rather than by handing the SDK a string and trusting it to measure.
 *
 * Frame coordinates become page coordinates by adding the frame's own offset. Exported pure
 * because this arithmetic is the part that silently rots when the viewer's layout changes.
 */
export function toolbarPayload(
  selection: { text: string; rect: SelectionRect | null } | null,
  frameRect: { top: number; left: number } | null,
): { length: number; rect: SelectionRect } | null {
  if (!selection?.rect || !frameRect) return null;
  return {
    length: selection.text.length,
    rect: {
      top: frameRect.top + selection.rect.top,
      left: frameRect.left + selection.rect.left,
      width: selection.rect.width,
      height: selection.rect.height,
    },
  };
}

type ToolbarHost = { notifySelection?: (payload: ReturnType<typeof toolbarPayload>) => void };

/**
 * Push the current selection's geometry to the assistant's toolbar, or clear it.
 *
 * Feature-detected on EVERY call rather than once at install: the SDK is injected asynchronously
 * and the gateway serving it rolls out on its own schedule, so `notifySelection` can be absent now
 * and present a minute later. Absent just means this deployment draws no toolbar over artifact
 * selections; every other part of the bridge (the envelope's `selection`) keeps working.
 */
function relaySelectionToToolbar(): void {
  const host = (window as { CloudDesk?: ToolbarHost }).CloudDesk;
  if (typeof host?.notifySelection !== "function") return;
  const frame = current ? previewFrameFor(current.slug) : null;
  host.notifySelection(toolbarPayload(current, frame ? frame.getBoundingClientRect() : null));
}

/** What the module holds: a vetted selection plus the slug of the artifact it came from. */
type HeldSelection = ArtifactSelection & { slug: string };

let current: HeldSelection | null = null;
let installed = false;

export function installSelectionBridge(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const parsed = parseSelectionMessage(event.data, Date.now());
    if (!parsed) return; // not a selection message at all — someone else's traffic
    const slug = previewFrameSlug(event.source);
    if (!slug) return; // not from a preview frame on this page
    current = parsed.selection ? { ...parsed.selection, slug } : null;
    relaySelectionToToolbar();
  });

  // Keeping the toolbar over the text. The FRAME reports its own scrolling (a host listener cannot
  // hear it), but the frame's POSITION on this page is ours to track, and the viewer moves it in
  // three ways the frame knows nothing about — see globals.css:
  //   · opening/closing the action bar slides the stage down by one bar height (`[data-bar=open]`)
  //   · the device switcher clamps the stage to 834/400px and re-centres it (`[data-device]`)
  //   · resizing the window re-centres it as well
  // The first two are CSS transitions, and we settle on transitionend instead of chasing every
  // intermediate frame: the toolbar lags one animation and then lands correctly, far cheaper than
  // a rAF loop running for the length of every bar toggle.
  window.addEventListener("resize", relaySelectionToToolbar, { passive: true });
  document.addEventListener("transitionend", (event: Event) => {
    const cls = (event.target as { classList?: { contains(name: string): boolean } } | null)?.classList;
    if (cls?.contains("fs-stage-wrap") || cls?.contains("fs-stage")) relaySelectionToToolbar();
  });

  // A refreshed frame is a NEW document: whatever was highlighted no longer exists, and a toolbar
  // left hovering there would offer to explain a passage that has just been replaced. This stopped
  // being a corner case the moment writes began refreshing the frame on their own — see
  // site-version-watcher, which fires this event for every version that lands while the page is open.
  window.addEventListener(ARTIFACT_REFRESH_EVENT, () => {
    current = null;
    relaySelectionToToolbar();
  });
}

/**
 * The latest vetted selection FOR THIS ARTIFACT, or null. Asking with a different slug answers
 * null rather than someone else's passage — the guarantee is positional, not a matter of some
 * cleanup effect having run in the right order. Freshness is the caller's policy (see assistant.tsx).
 */
export function currentArtifactSelection(slug: string): ArtifactSelection | null {
  if (!current || current.slug !== slug) return null;
  const { slug: _owner, ...selection } = current;
  void _owner;
  return selection;
}
