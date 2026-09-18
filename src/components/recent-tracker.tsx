"use client";
import { useEffect, useRef } from "react";
import { addRecent, refreshRecent, recentHref, type RecentEntry } from "@/lib/recent";
import { updateRecent } from "@/lib/recent-store";

export type RecentTrackerProps = Omit<RecentEntry, "visitedAt">;

/** A route opening is a visit; subsequent saves/renames only refresh the snapshot. */
export default function RecentTracker(props: RecentTrackerProps) {
  const lastRoute = useRef<string | null>(null);
  const { slug, title, kind, entry, versionCount, createdAt, updatedAt, shareToken, versionId } = props;
  useEffect(() => {
    const snapshot = { slug, title, kind, entry, versionCount, createdAt, updatedAt, shareToken, versionId, visitedAt: Date.now() };
    const route = recentHref(snapshot);
    const isVisit = lastRoute.current !== route;
    lastRoute.current = route;
    void updateRecent(items => isVisit ? addRecent(items, snapshot) : refreshRecent(items, snapshot));
  }, [slug, title, kind, entry, versionCount, createdAt, updatedAt, shareToken, versionId]);
  return null;
}
