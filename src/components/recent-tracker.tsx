"use client";

// Renders nothing; its only job is to note "this browser opened this site" into localStorage so the
// home page's "Recently viewed" tab has something to show. It lives beside the viewer rather than inside it
// for two reasons: the viewer is a big stateful component that should not also own storage, and the
// facts we record (title, kind, version count) are already resolved on the server for this route —
// passing them down beats making the client re-fetch what the page just rendered.
import { useEffect } from "react";
import { readLocal, writeLocal } from "@/lib/local-store";
import { addRecent, parseRecent, serializeRecent, RECENT_KEY, type RecentEntry } from "@/lib/recent";

export type RecentTrackerProps = Omit<RecentEntry, "visitedAt">;

export default function RecentTracker({ slug, title, kind, entry, versionCount, createdAt, updatedAt }: RecentTrackerProps) {
  // Read-modify-write on every visit: read fresh from storage (not from a hook snapshot) so a visit
  // opened in another tab is never clobbered, and re-run when the site's own facts change — a rename
  // or a save should refresh the card the shelf will draw.
  useEffect(() => {
    const stored = parseRecent(readLocal(RECENT_KEY));
    const next = addRecent(stored, { slug, title, kind, entry, versionCount, createdAt, updatedAt, visitedAt: Date.now() });
    writeLocal(RECENT_KEY, serializeRecent(next));
  }, [slug, title, kind, entry, versionCount, createdAt, updatedAt]);

  return null;
}
