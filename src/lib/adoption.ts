"use client";

// Settling ownership of sites this browser made before the account existed: the stored edit
// tokens are handed to /api/me/adopt, which claims whatever is still unowned. One call per page
// load, shared by everyone who needs the answer — the welcome burst (to say how many became
// yours) and the folder hand-over (which must not file a site before it is yours, or the
// assignment is skipped as "not your site" and then forgotten). Idempotent server-side: a site
// that is already owned is simply not adopted again.
import { allStoredEditTokens } from "@/lib/edit-token";

let pending: Promise<number> | null = null;

/** Number of sites adopted on this page load (0 when there was nothing to offer or the call failed). */
export function adoptStoredSites(): Promise<number> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const sites = allStoredEditTokens();
      if (sites.length === 0) return 0;
      const res = await fetch("/api/me/adopt", {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ sites }),
      });
      if (!res.ok) return 0;
      return ((await res.json()) as { adopted?: number }).adopted ?? 0;
    } catch {
      return 0; // a failure is silent on purpose — the sign-in itself still succeeded
    }
  })();
  return pending;
}

/** Test hook: forget the memoised call. */
export function __resetAdoptionForTests(): void {
  pending = null;
}
