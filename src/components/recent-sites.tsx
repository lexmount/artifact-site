"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SiteSummary } from "@/lib/types";
import { useLocalJson } from "@/lib/local-store";
import { EMPTY_RECENT, RECENT_KEY, parseRecent, removeRecent, recentShelfItems } from "@/lib/recent";
import { updateRecent } from "@/lib/recent-store";

export interface RecentSite {
  summary: SiteSummary;
  visitedAt: number;
  href: string;
  preview: string;
}
export interface RecentShelf {
  items: RecentSite[];
  ready: boolean;
  remove: (slug: string) => void;
  clear: () => void;
}
const subscribeNever = () => () => {};

export function useRecentShelf(allSites: SiteSummary[]): RecentShelf {
  const entries = useLocalJson(RECENT_KEY, parseRecent, EMPTY_RECENT);
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);
  const items = useMemo(() => recentShelfItems(entries, allSites), [entries, allSites]);
  const remove = useCallback((slug: string) => { void updateRecent(items => removeRecent(items, slug)); }, []);
  const clear = useCallback(() => { void updateRecent(() => []); }, []);
  return { items, ready, remove, clear };
}
