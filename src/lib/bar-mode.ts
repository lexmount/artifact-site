/**
 * How the action bar reveals itself: manual (only a handle click counts) or auto (the mouse
 * lingering along the top edge of the page for a moment expands it).
 *
 * Why manual is the default: this design copies the macOS auto-hiding menu bar, but that only
 * works because "the top edge of the screen is a wall; the cursor stops there". The top edge of a
 * browser page is not a wall -- it is the path everyone takes to reach the tab strip/address bar.
 * Every trip to click another tab drags the cursor through the hot zone, the bar pops out, shoves
 * the whole page down, then pops back (verbatim complaint: "so annoying, I was just trying to click
 * another browser tab"). So hover-to-reveal can only be an opt-in preference, and even when opted
 * in it has to prove "the cursor stopped here, it is not passing through": the bar expands only
 * after a full HOVER_DWELL_MS dwell, and leaving mid-way (passing through) cancels it.
 *
 * The preference is stored in this browser (localStorage), not at account level: it describes the
 * mouse habits on this machine.
 */
export type BarMode = "manual" | "auto";

export const DEFAULT_BAR_MODE: BarMode = "manual";
export const BAR_MODE_KEY = "sites:barMode";
/** How long the cursor must dwell in the hot zone before it counts as "wants the bar" rather than "passing through to click a tab". Crossing a 14px zone never comes close to this. */
export const HOVER_DWELL_MS = 200;

export function parseBarMode(raw: unknown): BarMode {
  return raw === "auto" || raw === "manual" ? raw : DEFAULT_BAR_MODE;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Read the preference; any failure (private mode, disabled storage, garbage data) falls back to the default -- the page must not crash over it. */
export function readBarMode(storage: StorageLike | null | undefined): BarMode {
  try {
    return parseBarMode(storage?.getItem(BAR_MODE_KEY));
  } catch {
    return DEFAULT_BAR_MODE;
  }
}

export function writeBarMode(storage: StorageLike | null | undefined, mode: BarMode): void {
  try {
    storage?.setItem(BAR_MODE_KEY, mode);
  } catch {
    /* if it cannot be stored, it only applies to this page load */
  }
}

type Listener = () => void;

/**
 * Store for useSyncExternalStore: the preference itself lives in localStorage (external state);
 * components merely subscribe to it. The server snapshot is always the default, swapped for the
 * real value after client hydration -- this is the canonical way to "always render the default on
 * SSR" without a setState inside an effect. Shared across places on the same page and across tabs:
 * same-page updates go through listeners, cross-tab updates ride the storage event.
 */
type StorageEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export function createBarModeStore(
  getStorage: () => StorageLike | null | undefined,
  /** Where to listen for cross-tab storage events; no window under SSR means no listening. */
  eventTarget: StorageEventTarget | null = typeof window === "undefined" ? null : window,
) {
  const listeners = new Set<Listener>();
  const notify = () => { for (const l of listeners) l(); };
  return {
    subscribe(l: Listener): () => void {
      listeners.add(l);
      // Another tab changed the preference (or clear()ed the whole storage, key === null) -> this page follows.
      const onStorage = (e: Event) => { const key = (e as StorageEvent).key; if (key === BAR_MODE_KEY || key === null) l(); };
      eventTarget?.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(l);
        eventTarget?.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot(): BarMode { return readBarMode(getStorage()); },
    getServerSnapshot(): BarMode { return DEFAULT_BAR_MODE; },
    set(mode: BarMode): void { writeBarMode(getStorage(), mode); notify(); },
  };
}

export const barModeStore = createBarModeStore(() => (typeof window === "undefined" ? null : window.localStorage));

/** Whether a hover into the hot zone should start the dwell timer. Only "auto" mode + a real mouse counts; a touch-synthesized enter does not (see isHoverPointer). */
export function hoverArmsReveal(mode: BarMode, isMousePointer: boolean): boolean {
  return mode === "auto" && isMousePointer;
}

/**
 * Whether the bar ever "collapses on its own" in this mode. Manual mode's promise is: apart from the
 * brief hint period right after landing and clicking into the artifact, the bar answers only to the
 * handle -- the "tidy up while we're at it" paths (closing a drawer, focus leaving the bar) must stay
 * quiet. Otherwise the user opens the bar to look at version history, the drawer closes, the bar
 * vanishes with it, and that contradicts the word "manual".
 */
export function modeAutoHides(mode: BarMode): boolean {
  return mode === "auto";
}

/** Whether the mouse leaving the chrome should schedule an auto-hide. In manual mode the bar answers only to the handle; leaving does not hide it. */
export function leaveSchedulesHide(mode: BarMode, isMousePointer: boolean): boolean {
  return modeAutoHides(mode) && isMousePointer;
}

type Timers = {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
};

/**
 * A "dwell timer": arm() starts the clock, fire happens only when it runs out; cancel() voids this
 * attempt. Repeated arm() keeps only the last one (jittering in and out of the hot zone does not
 * accumulate multiple reveals).
 */
export class Dwell {
  private id: number | null = null;

  constructor(
    private readonly onFire: () => void,
    private readonly ms: number = HOVER_DWELL_MS,
    private readonly timers: Timers = {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (id) => window.clearTimeout(id),
    },
  ) {}

  arm(): void {
    this.cancel();
    this.id = this.timers.set(() => {
      this.id = null;
      this.onFire();
    }, this.ms);
  }

  cancel(): void {
    if (this.id !== null) {
      this.timers.clear(this.id);
      this.id = null;
    }
  }

  get armed(): boolean {
    return this.id !== null;
  }
}
