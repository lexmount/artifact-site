import { appBasePath, localPath } from "@/lib/app-path";

export function viewerFamily(href: string): string | null {
  const path = localPath(new URL(href, "http://local").pathname);
  return path.match(/^\/(?:s|v)\/[^/]+/)?.[0] ?? null;
}

/** Only return to this application's pages, never an external origin or an API. */
export function safeReturn(href: string | null | undefined, current: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, current), here = new URL(current), prefix = appBasePath();
    if (url.origin !== here.origin || url.username || url.password) return null;
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    const path = localPath(url.pathname);
    if (/^\/(api|auth|preview|login)(\/|$)/.test(path)) return null;
    if (viewerFamily(url.href) && viewerFamily(url.href) === viewerFamily(current)) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}

export type ViewerEntry = { href: string; trail: string[] };
export type ViewerReturnState = { family: string; trail: string[] };
export const RETURN_HANDOFF = "artifact:return-entry";
let memoryHandoff: {target: string; trail: string[]; at: number} | undefined;

/** Keep a bounded, safe chain so returning through copied artifacts terminates. */
export function returnTrail(values: unknown, current: string): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>(), trail: string[] = [];
  for (const value of values.slice(0, 32)) {
    const safe = typeof value === "string" ? safeReturn(value, current) : null;
    if (!safe) continue;
    const key = viewerFamily(safe) ?? safe;
    if (seen.has(key)) continue;
    seen.add(key); trail.push(safe);
  }
  return trail;
}

export function entryTrail(href: string, state: ViewerReturnState | undefined, handoff: unknown, previous: ViewerEntry | null): string[] {
  // Back/Forward and reload restore the target entry, not the page just left.
  if (state?.family === viewerFamily(href)) return returnTrail(state.trail, href);
  if (Array.isArray(handoff)) return returnTrail(handoff, href);
  if (!previous) return [];
  return returnTrail(viewerFamily(previous.href) === viewerFamily(href) ? previous.trail : [previous.href, ...previous.trail], href);
}

/** Call before programmatic full navigation as well as native link activation. */
export function prepareViewerNavigation(href: string, returning = false): void {
  const current = window.location.href;
  const destination = new URL(href, current);
  if (!viewerFamily(destination.href) || !safeReturn(destination.href, new URL(appBasePath() + "/", current).href)) return;
  const state = history.state?.artifactViewerReturn as ViewerReturnState | undefined;
  const trail = state?.family === viewerFamily(current) ? returnTrail(state.trail, current) : [];
  const next = returning ? trail.slice(1) : viewerFamily(current) === viewerFamily(destination.href) ? trail : [current, ...trail];
  memoryHandoff = { target: destination.href, trail: returnTrail(next, destination.href), at: Date.now() };
  try {
    sessionStorage.setItem(RETURN_HANDOFF, JSON.stringify(memoryHandoff));
  } catch { /* Storage is optional; client navigation and history still retain their entries. */ }
}

export function takeViewerHandoff(href: string): string[] | undefined {
  let pending = memoryHandoff;
  memoryHandoff = undefined;
  try {
    pending ??= JSON.parse(sessionStorage.getItem(RETURN_HANDOFF) ?? "null");
    sessionStorage.removeItem(RETURN_HANDOFF);
  } catch { /* Storage is optional. */ }
  const age = Date.now() - (pending?.at ?? 0);
  if (pending?.target === href && age >= 0 && age < 30_000 && Array.isArray(pending.trail)) return returnTrail(pending.trail, href);
}
