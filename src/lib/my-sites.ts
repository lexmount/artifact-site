// My sites — deciding which of the deployment's sites are *mine*, as plain values.
//
// Two rules live here, and both are corrections of a bug that was invisible in the component:
//
//   1. MEMBERSHIP AND SUMMARY ARE DIFFERENT QUESTIONS. "Which slugs are mine" may come from a
//      stale source (a one-shot /api/me/sites snapshot taken at page load); "what does this site
//      look like right now" may not. `mergeMySites` therefore takes summaries EXCLUSIVELY from the
//      server-rendered list and uses the ownership sources only as a filter. Merging summaries from
//      both sides — last writer wins — is what made a deleted site keep its card (dead thumbnail,
//      404 on click) and a rename snap back to the old title.
//
//   2. A ?t= LINK IS NOT AUTHORSHIP. `sites:sharedToken:` grants editing because someone invited
//      you; it says nothing about who made the site. Counting it as ownership put a colleague's
//      site into your "My sites" — with a delete button — the moment you opened the link they sent.
import { editTokenKey } from "@/lib/edit-token";
import { useRef, useSyncExternalStore } from "react";
import type { SiteSummary } from "@/lib/types";
import { subscribeStore } from "@/lib/local-store";

/**
 * The localStorage prefix for tokens of sites THIS browser created. Derived from the key builder so
 * there is exactly one definition of the owner namespace; `sites:sharedToken:` does not match it,
 * which is the whole point.
 */
export const OWNER_TOKEN_PREFIX = editTokenKey("");

/** Stable empty value — safe to hand to useSyncExternalStore as a server snapshot. */
export const NO_SLUGS: ReadonlySet<string> = new Set<string>();

/**
 * Owner slugs out of a list of storage keys. Sorted, so callers can build a cheap change signature.
 * Pure on purpose: the prefix rule is the security boundary, and it is testable without a browser.
 */
export function ownerSlugsFrom(keys: Iterable<string | null>): string[] {
  const slugs = new Set<string>();
  for (const key of keys) {
    if (!key || !key.startsWith(OWNER_TOKEN_PREFIX)) continue;
    const slug = key.slice(OWNER_TOKEN_PREFIX.length);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

/** Every slug this browser holds an OWNER token for. Total: storage may be missing or blocked. */
export function readOwnerSlugs(): string[] {
  try {
    const keys: (string | null)[] = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return ownerSlugsFrom(keys);
  } catch {
    return []; // private mode / storage disabled — no anonymous half, just the signed-in one
  }
}

/**
 * "My sites", newest first.
 *
 * `allSites` is both the universe and the only source of card data: a slug it does not contain has
 * been deleted (or was never visible here), so it must not be drawn no matter what the ownership
 * sources still remember. The two sources are unioned, never traded off — an anonymous upload made
 * in this browser is mine, and so is a site made on another device under the same account.
 */
export function mergeMySites(
  allSites: readonly SiteSummary[],
  ownedSlugs: ReadonlySet<string>,
  serverSlugs: ReadonlySet<string>,
): SiteSummary[] {
  const mine = allSites.filter((s) => ownedSlugs.has(s.slug) || serverSlugs.has(s.slug));
  return mine.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A change signature for the server-rendered list: refetching "what do I own" is only worth doing
 *  when the universe itself moved (a site was added, deleted or saved). */
export function siteListSignature(sites: readonly SiteSummary[]): string {
  return sites.map((s) => `${s.slug}@${s.updatedAt}`).join("\n");
}

/**
 * Slugs this browser CREATED, from its own token store, as a React external store. SSR-safe (empty
 * until hydration) and reference-stable while the set does not change, so it is safe as a memo dep.
 *
 * Only the OWNER prefix is scanned (see ownerSlugsFrom): a `?t=` link files its token under
 * `sites:sharedToken:` and is intentionally invisible here — opening a colleague's editable link
 * lets you edit their site, it does not make the site yours, and it must not put their row, with its
 * Delete action, into your list.
 */
export function useOwnerSlugs(): ReadonlySet<string> {
  const cache = useRef<{ sig: string; slugs: ReadonlySet<string> }>({ sig: "", slugs: NO_SLUGS });
  const snapshot = (): ReadonlySet<string> => {
    const slugs = readOwnerSlugs(); // sorted, so the signature is stable
    const sig = slugs.join("\n");
    if (sig !== cache.current.sig) cache.current = { sig, slugs: new Set(slugs) };
    return cache.current.slugs;
  };
  return useSyncExternalStore(subscribeStore, snapshot, () => NO_SLUGS);
}
