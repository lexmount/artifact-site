"use client";

// Shared plumbing for the browser-local product state (Recently viewed + Folders). These live in
// localStorage rather than the database on purpose: the whole product is usable anonymously, and
// a per-browser shelf needs no account, no schema and no API — it just has to survive a reload.
//
// Reads go through useSyncExternalStore so they are SSR-safe: the server (and the first client
// render) sees `empty`, the real value arrives right after hydration. That is the same contract
// edit-token.ts uses, and it is what keeps localStorage-derived UI out of hydration mismatches.
import { useRef, useSyncExternalStore } from "react";

/** Broadcast on every write, so every reader in the tab updates. Shared with edit-token and
 *  folder-shelf — one event name for all of this app's localStorage, deliberately. */
export const STORE_EVENT = "sites:store";

export function subscribeStore(cb: () => void): () => void {
  window.addEventListener(STORE_EVENT, cb);
  window.addEventListener("storage", cb); // other tabs
  return () => {
    window.removeEventListener(STORE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Raw read. Storage can be disabled entirely (private mode, blocked cookies) — that is a
 *  degraded feature, never an exception into a render. */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Raw write (`null` deletes), then tell every reader. Returns whether the value actually landed.
 *
 * A quota error means "this visit is not remembered", which is strictly better than tearing down
 * the page the user is looking at — but it must not be reported as success either. Swallowing it
 * silently is what let a full (or blocked) store answer "Folder created" while nothing was written,
 * so the chip vanished on the next read and the user had no idea why. Callers that show a result
 * must branch on this boolean; pure housekeeping may keep ignoring it.
 *
 * The broadcast is deliberately unconditional: even a failed write is a good moment to re-read, and
 * on failure every subscriber simply sees the unchanged value.
 */
export function writeLocal(key: string, raw: string | null): boolean {
  let ok = true;
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  } catch {
    ok = false; // storage unavailable / full — degrade, but say so
  }
  try {
    window.dispatchEvent(new Event(STORE_EVENT));
  } catch {
    /* non-browser context */
  }
  return ok;
}

/**
 * Subscribe to one JSON-shaped localStorage key.
 *
 * `parse` must be total (never throw) and `empty` must be a module-level constant: React compares
 * snapshots by identity, so re-parsing on every render — or handing back a fresh `[]` — would spin
 * the component forever. Hence the raw-string cache: we only re-parse when the stored text changed.
 */
export function useLocalJson<T>(key: string, parse: (raw: string | null) => T, empty: T): T {
  // The sentinel can never equal a real read (`string | null`), so the first snapshot always parses.
  const cache = useRef<{ raw: string | null | undefined; value: T }>({ raw: undefined, value: empty });
  const snapshot = (): T => {
    const raw = readLocal(key);
    if (cache.current.raw !== raw) cache.current = { raw, value: parse(raw) };
    return cache.current.value;
  };
  return useSyncExternalStore(subscribeStore, snapshot, () => empty);
}
