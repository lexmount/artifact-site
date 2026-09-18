"use client";
import { readLocal, writeLocal } from "@/lib/local-store";
import { RECENT_KEY, parseRecent, serializeRecent, type RecentEntry } from "@/lib/recent";

/** Serialize read/modify/write across tabs where Web Locks is supported. */
export async function updateRecent(change: (entries: RecentEntry[]) => RecentEntry[]): Promise<void> {
  let started = false;
  const write = () => { started = true; writeLocal(RECENT_KEY, serializeRecent(change(parseRecent(readLocal(RECENT_KEY))))); };
  if (typeof navigator !== "undefined" && navigator.locks) {
    try { await navigator.locks.request(RECENT_KEY, write); return; }
    catch (error) {
      // Only fall back if acquiring the lock failed; never replay a callback that ran.
      if (started) throw error;
    }
  }
  write();
}
