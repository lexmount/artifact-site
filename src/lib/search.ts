import "server-only";

// Search over the text index (lib/site-text): the words → tokens → store → hits with a snippet.
import { searchSiteTexts, type ListViewer } from "@/lib/db";
import { siteUrl } from "@/lib/sites";
import { queryTokens, snippetOf } from "@/lib/site-text";
import type { SiteKind, Visibility } from "@/lib/types";

export interface SearchResult {
  slug: string;
  title: string;
  kind: SiteKind;
  visibility: Visibility;
  /** Set when an administrator took the site down; only its owner sees such a hit, and opening it answers 410. */
  takenDownAt: number | null;
  updatedAt: number;
  url: string;
  snippet: string;
}

/** Sites the viewer may list whose current text contains every word of `query`, best first. */
export async function searchSites(viewer: ListViewer | undefined, query: string, limit: number): Promise<SearchResult[]> {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const hits = await searchSiteTexts(viewer, tokens, limit);
  return hits.map((h) => ({ slug: h.slug, title: h.title, kind: h.kind, visibility: h.visibility, takenDownAt: h.takenDownAt, updatedAt: h.updatedAt, url: siteUrl(h.slug), snippet: snippetOf(h.body, query) }));
}
