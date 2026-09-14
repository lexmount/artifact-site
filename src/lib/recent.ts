// Recently viewed — the sites THIS browser has opened, newest first. Pure list algebra plus a tolerant
// parser; nothing here touches localStorage or React, so the rules that actually matter (dedupe,
// ordering, the cap, surviving corrupt storage) are unit-testable on plain values.
//
// Why store a whole snapshot of each site instead of just the slug: most entries are OTHER people's
// sites, which are not in "mine" data at all. Without the title/kind we could not draw a card until
// a network round-trip, and a "Recently viewed" list that renders blank for a beat is worse than one that
// shows a slightly stale title.
import type { SiteKind, SiteSummary } from "@/lib/types";

export const RECENT_KEY = "sites:recent:v1";

/** Hard cap. A shelf, not a history log: 50 cards is already more than anyone scrolls, and the
 *  bound is what keeps this key from growing without limit in a store shared with edit tokens. */
export const RECENT_LIMIT = 50;

/** Stable empty value — required by useLocalJson (snapshots are compared by identity). Every
 *  function below returns a new array rather than mutating, so sharing one instance is safe. */
export const EMPTY_RECENT: RecentEntry[] = [];

/** A visited site: everything a card needs, plus when this browser last opened it. */
export interface RecentEntry {
  slug: string;
  title: string;
  kind: SiteKind;
  entry: string;
  versionCount: number;
  createdAt: number;
  updatedAt: number;
  /** Last time this browser opened it. The list is ordered by this, newest first. */
  visitedAt: number;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerce one stored record into an entry, or drop it. Deliberately forgiving about every field
 * except `slug`: an entry without a slug addresses nothing, while a missing title or count is
 * cosmetic and has an obvious stand-in. Older or hand-edited storage must degrade, never throw.
 */
function normalizeEntry(raw: unknown): RecentEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug.trim() : "";
  if (!slug) return null;
  const visitedAt = num(r.visitedAt, 0);
  const title = typeof r.title === "string" && r.title.trim() ? r.title : slug;
  return {
    slug,
    title,
    kind: r.kind === "folder" ? "folder" : "single",
    entry: typeof r.entry === "string" && r.entry ? r.entry : "index.html",
    versionCount: Math.max(0, Math.trunc(num(r.versionCount, 1))),
    createdAt: num(r.createdAt, visitedAt),
    updatedAt: num(r.updatedAt, visitedAt),
    visitedAt,
  };
}

/**
 * Read the stored list. Accepts the envelope we write (`{v:1, items:[…]}`) and a bare array, so a
 * value written by an older build still loads. Anything unparseable is treated as "no history":
 * a corrupt shelf must cost the user their history, never the home page.
 */
export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : null;
  if (!list) return [];

  const seen = new Set<string>();
  const items: RecentEntry[] = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.slug)) continue; // first wins — the stored order is the truth
    seen.add(entry.slug);
    items.push(entry);
    if (items.length >= RECENT_LIMIT) break;
  }
  // Deliberately NOT re-sorted by visitedAt. `addRecent` places a new visit first WITHOUT consulting
  // the clock precisely because the clock can jump backwards (NTP correction, a profile copied from
  // another machine, a manually changed date); sorting here would undo that on the very next read
  // and bury the page the user just opened. The stored order IS the order.
  return items;
}

export function serializeRecent(items: readonly RecentEntry[]): string {
  return JSON.stringify({ v: 1, items });
}

/**
 * Record a visit. Re-visiting a site moves it to the front rather than adding a second card, and
 * the new entry is placed first WITHOUT re-sorting: ordering by a clock that can jump backwards
 * (or by a snapshot copied between profiles) would sometimes bury the page the user just opened.
 */
export function addRecent(items: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...items.filter((i) => i.slug !== entry.slug)].slice(0, RECENT_LIMIT);
}

export function removeRecent(items: readonly RecentEntry[], slug: string): RecentEntry[] {
  return items.filter((i) => i.slug !== slug);
}

/**
 * Drop entries for sites that no longer exist. `liveSlugs` is the server's list; an EMPTY set is
 * treated as "we don't know" and prunes nothing, so a momentarily empty list can never wipe a
 * user's history.
 *
 * That list is no longer the whole universe: it hides Unlisted sites that are not the viewer's.
 * Yours survive — the home page asks for the list as YOU, so your own unlisted sites are in it —
 * but a stranger's unlisted site you opened from a link will be pruned from this shelf, since from
 * here it is indistinguishable from a deleted one. Telling those two apart needs a per-slug
 * "does this still exist" check the client does not have; until it does, this is the trade, and it
 * costs a history entry rather than showing dead cards. Do NOT widen the list to fix it.
 */
export function pruneRecent(items: readonly RecentEntry[], liveSlugs: ReadonlySet<string>): RecentEntry[] {
  if (liveSlugs.size === 0) return [...items];
  return items.filter((i) => liveSlugs.has(i.slug));
}

/** The card shape, for entries whose site we could not refresh from the server. */
export function toSummary(entry: RecentEntry): SiteSummary {
  const { slug, title, kind, entry: file, versionCount, createdAt, updatedAt } = entry;
  return { slug, title, kind, entry: file, versionCount, createdAt, updatedAt };
}
