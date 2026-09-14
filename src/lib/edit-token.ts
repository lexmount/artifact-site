"use client";

// Client helpers for the per-site edit token (selectively shared edit access). The token lives in localStorage keyed
// by slug, or arrives via a ?t= editable link. Reads go through useSyncExternalStore so they are
// SSR-safe (null on the server / first paint, real value after hydration): owner-only affordances
// never flash during SSR and never cause hydration mismatches. Mirrors local-store's store event.
import { useEffect, useRef, useSyncExternalStore } from "react";

const STORE_EVENT = "sites:store"; // shared with local-store: broadcasts localStorage writes

/**
 * Tokens are filed by PROVENANCE, and the split is a security boundary, not bookkeeping.
 *
 * `sites:editToken:` holds tokens for sites THIS browser created (upload / fork). Those are the
 * only ones that may be redeemed for ownership at sign-in.
 *
 * `sites:sharedToken:` holds tokens that arrived on someone else's `?t=` editable link. They still
 * grant editing — that is what the link is for — but they are evidence of an invitation, not of
 * authorship. Filing them together with the first kind is what let opening a colleague's link and
 * later signing in silently transfer their (still unowned) site into your account.
 */
export function editTokenKey(slug: string): string {
  return `sites:editToken:${slug}`;
}
function sharedTokenKey(slug: string): string {
  return `sites:sharedToken:${slug}`;
}

/** Persist a token for a site THIS browser created. Redeemable for ownership. Client-only. */
export function rememberEditToken(slug: string, token: string): void {
  try {
    localStorage.setItem(editTokenKey(slug), token);
    window.dispatchEvent(new Event(STORE_EVENT));
  } catch { /* ignore */ }
}

/** Persist a token received on someone else's editable link. Grants editing, never ownership. */
export function rememberSharedToken(slug: string, token: string): void {
  try {
    // Never downgrade: if this browser created the site, its own record stays authoritative.
    if (localStorage.getItem(editTokenKey(slug))) return;
    localStorage.setItem(sharedTokenKey(slug), token);
    window.dispatchEvent(new Event(STORE_EVENT));
  } catch { /* ignore */ }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(STORE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(STORE_EVENT, cb); window.removeEventListener("storage", cb); };
}

/** Whichever token this browser holds for a site — either provenance grants editing. */
function readStored(slug: string): string | null {
  try { return localStorage.getItem(editTokenKey(slug)) ?? localStorage.getItem(sharedTokenKey(slug)); } catch { return null; }
}

/** True only after hydration (false on the server and first client render). */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

/** This browser's stored owner token for a site, or null. SSR-safe. */
export function useStoredToken(slug: string): string | null {
  return useSyncExternalStore(subscribe, () => readStored(slug), () => null);
}

/**
 * Resolve edit access for a site. A ?t=<token> link wins (persisted so later visits work, then
 * stripped from the address bar); otherwise the browser's stored owner token is used. `resolved`
 * flips true after hydration so callers can tell "still checking" apart from "no permission".
 */
export function useEditToken(slug: string): { token: string | null; resolved: boolean } {
  const resolved = useHydrated();
  const queryToken = useSyncExternalStore(subscribe, () => {
    try { return new URL(window.location.href).searchParams.get("t"); } catch { return null; }
  }, () => null);
  const stored = useStoredToken(slug);

  // Side-effect only (no setState): persist a ?t= link's token and drop it from the URL.
  // Filed as SHARED — the link proves someone invited you to edit, not that you made the site.
  useEffect(() => {
    if (!queryToken) return;
    rememberSharedToken(slug, queryToken);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("t");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
  }, [queryToken, slug]);

  return { token: queryToken || stored || null, resolved };
}

/** Owner tokens for a set of slugs (home grid). Empty on the server; real values after hydration. */
export function useOwnedTokens(slugs: string[]): Record<string, string> {
  const cache = useRef<{ sig: string; map: Record<string, string> }>({ sig: "", map: {} });
  const snapshot = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const slug of slugs) {
      const token = readStored(slug);
      if (token) map[slug] = token;
    }
    // useSyncExternalStore needs a stable reference: only swap the object when contents change.
    const sig = JSON.stringify(map);
    if (sig !== cache.current.sig) cache.current = { sig, map };
    return cache.current.map;
  };
  return useSyncExternalStore(subscribe, snapshot, () => cache.current.map);
}

/**
 * Every (slug, token) pair for sites this browser CREATED. Used once, right after sign-in, to
 * settle ownership of sites made before the account existed — including those predating the
 * identity migration, for which this is the only surviving evidence of authorship.
 *
 * Deliberately skips `sites:sharedToken:`. Those came from someone else's editable link, and a
 * site's author must not lose it merely because a colleague opened the link they were sent and
 * happened to sign in first.
 */
export function allStoredEditTokens(): Array<{ slug: string; editToken: string }> {
  const out: Array<{ slug: string; editToken: string }> = [];
  try {
    const prefix = "sites:editToken:";
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (value) out.push({ slug: key.slice(prefix.length), editToken: value });
    }
  } catch { /* private mode / storage disabled — nothing to offer */ }
  return out;
}

/** How many sites this browser would hand over on sign-in — the number the gate dialog states. */
export function countAdoptableSites(): number {
  return allStoredEditTokens().length;
}
