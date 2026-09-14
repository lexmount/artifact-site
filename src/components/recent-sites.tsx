"use client";

// "Recently viewed" — what THIS browser has opened, newest first; the home page renders it via HomeRecent.
//
// The stored snapshot is only a fallback. Whenever the server's list knows the site we draw the
// server's copy, so a card never shows a title someone renamed last week — and a slug the server
// no longer lists has been deleted, so it is dropped rather than rendered as a dead link.
import { useCallback, useEffect, useMemo } from "react";
import type { SiteSummary } from "@/lib/types";
import { readLocal, useLocalJson, writeLocal } from "@/lib/local-store";
import {
  EMPTY_RECENT,
  RECENT_KEY,
  parseRecent,
  pruneRecent,
  removeRecent,
  serializeRecent,
  toSummary,
} from "@/lib/recent";

export interface RecentSite {
  summary: SiteSummary;
  visitedAt: number;
}

export interface RecentShelf {
  items: RecentSite[];
  remove: (slug: string) => void;
  clear: () => void;
}

/**
 * The shelf, reconciled against the server list. Lives in a hook because the tab bar needs the
 * count before the panel is ever rendered — computing it twice would risk the badge and the grid
 * disagreeing about what "Recently viewed" contains.
 */
export function useRecentShelf(allSites: SiteSummary[]): RecentShelf {
  const entries = useLocalJson(RECENT_KEY, parseRecent, EMPTY_RECENT);
  const live = useMemo(() => new Map(allSites.map((s) => [s.slug, s] as const)), [allSites]);

  const items = useMemo(() => {
    const out: RecentSite[] = [];
    for (const e of entries) {
      const fresh = live.get(e.slug);
      // An empty server list means "we can't tell" (fresh deploy, failed listing) — in that case
      // keep showing the stored snapshots rather than blanking the user's history.
      if (!fresh && live.size > 0) continue;
      out.push({ summary: fresh ?? toSummary(e), visitedAt: e.visitedAt });
    }
    return out;
  }, [entries, live]);

  // Deleted sites are filtered above for display; this also forgets them, so the stored shelf does
  // not spend its 50 slots on sites nobody can open.
  useEffect(() => {
    const stored = parseRecent(readLocal(RECENT_KEY));
    const pruned = pruneRecent(stored, new Set(live.keys()));
    if (pruned.length !== stored.length) writeLocal(RECENT_KEY, serializeRecent(pruned));
  }, [live]);

  const remove = useCallback((slug: string) => {
    writeLocal(RECENT_KEY, serializeRecent(removeRecent(parseRecent(readLocal(RECENT_KEY)), slug)));
  }, []);

  const clear = useCallback(() => {
    writeLocal(RECENT_KEY, null);
  }, []);

  return { items, remove, clear };
}
