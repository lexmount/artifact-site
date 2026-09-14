// Folders — a per-browser shelf for organising "My sites". Pure state algebra + a tolerant parser;
// no localStorage, no React, so every rule below is unit-testable on plain values.
//
// Two deliberate limits shape the model:
//   · a site belongs to at most ONE folder (a plain map slug → folderId). Multi-membership needs
//     set semantics, an order and a UI to express both, and buys nothing for a personal shelf.
//   · folders are LABELS, not containers. Deleting one deletes no site — the members simply fall
//     back to Unfiled. A destructive folder delete would make organising feel dangerous, which is
//     the opposite of what a shelf is for.
import type { SiteSummary } from "@/lib/types";

export const FOLDERS_KEY = "sites:folders:v1";
export const MAX_FOLDERS = 50;
export const MAX_FOLDER_NAME = 40;

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

/** `assign` maps a site slug to the folder holding it. Absent = Unfiled. */
export interface FolderState {
  folders: Folder[];
  assign: Record<string, string>;
}

/** Stable empty value — required by useLocalJson (snapshots are compared by identity). Every
 *  function below returns a new state rather than mutating, so sharing one instance is safe. */
export const EMPTY_FOLDERS: FolderState = { folders: [], assign: {} };

/** The two non-folder rows in the filter rail. Prefixed ids keep them un-collidable with real ones. */
export const FILTER_ALL = "all";
export const FILTER_UNFILED = "unfiled";

/** Collapse whitespace and cap the length. A folder name is a chip label, not a document. */
export function normalizeFolderName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_FOLDER_NAME);
}

/** Ids are opaque and browser-local; only uniqueness matters. `f_` keeps them out of the
 *  FILTER_* namespace even if a future id generator gets shorter. */
export function newFolderId(): string {
  const rand = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `f_${rand}`;
}

function normalizeFolder(raw: unknown): Folder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  const name = normalizeFolderName(typeof r.name === "string" ? r.name : "");
  return {
    id,
    name: name || "Untitled folder",
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0,
  };
}

/**
 * Read the stored shelf. Every field is re-validated rather than trusted, and an assignment
 * pointing at a folder that is not in the list is dropped — that dangling case is the one that
 * would otherwise hide a site from BOTH Unfiled and every folder, i.e. lose it in plain sight.
 */
export function parseFolders(raw: string | null): FolderState {
  if (!raw) return { folders: [], assign: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { folders: [], assign: {} };
  }
  if (!data || typeof data !== "object") return { folders: [], assign: {} };
  const r = data as { folders?: unknown; assign?: unknown };

  const folders: Folder[] = [];
  const ids = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const item of r.folders) {
      const folder = normalizeFolder(item);
      if (!folder || ids.has(folder.id)) continue;
      ids.add(folder.id);
      folders.push(folder);
      if (folders.length >= MAX_FOLDERS) break;
    }
  }

  const assign: Record<string, string> = {};
  if (r.assign && typeof r.assign === "object" && !Array.isArray(r.assign)) {
    for (const [slug, folderId] of Object.entries(r.assign as Record<string, unknown>)) {
      if (!slug || typeof folderId !== "string" || !ids.has(folderId)) continue;
      assign[slug] = folderId;
    }
  }
  return { folders, assign };
}

export function serializeFolders(state: FolderState): string {
  return JSON.stringify({ v: 1, folders: state.folders, assign: state.assign });
}

/** Add a folder. Total by design: a blank name, a duplicate id or a full shelf returns the state
 *  untouched (callers compare by identity to decide whether to report a failure). */
export function createFolder(state: FolderState, name: string, id: string, now: number): FolderState {
  const clean = normalizeFolderName(name);
  if (!clean || !id) return state;
  if (state.folders.length >= MAX_FOLDERS) return state;
  if (state.folders.some((f) => f.id === id)) return state;
  return { folders: [...state.folders, { id, name: clean, createdAt: now }], assign: state.assign };
}

export function renameFolder(state: FolderState, id: string, name: string): FolderState {
  const clean = normalizeFolderName(name);
  if (!clean) return state;
  if (!state.folders.some((f) => f.id === id)) return state;
  return { folders: state.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)), assign: state.assign };
}

/** Remove a folder and un-file its members. The sites themselves are never touched. */
export function deleteFolder(state: FolderState, id: string): FolderState {
  if (!state.folders.some((f) => f.id === id)) return state;
  const assign: Record<string, string> = {};
  for (const [slug, folderId] of Object.entries(state.assign)) {
    if (folderId !== id) assign[slug] = folderId;
  }
  return { folders: state.folders.filter((f) => f.id !== id), assign };
}

/** File a site, or un-file it with `null`. Assigning to a folder that does not exist is a no-op
 *  rather than a dangling pointer. */
export function assignSite(state: FolderState, slug: string, folderId: string | null): FolderState {
  if (!slug) return state;
  if (folderId === null) {
    if (!(slug in state.assign)) return state;
    const assign = { ...state.assign };
    delete assign[slug];
    return { folders: state.folders, assign };
  }
  if (!state.folders.some((f) => f.id === folderId)) return state;
  if (state.assign[slug] === folderId) return state;
  return { folders: state.folders, assign: { ...state.assign, [slug]: folderId } };
}

export function folderOf(state: FolderState, slug: string): string | null {
  return state.assign[slug] ?? null;
}

/**
 * Forget assignments for sites that no longer exist, so a browser that has been deleting sites for
 * a year does not carry their slugs forever. Same guard as pruneRecent: an EMPTY `liveSlugs` means
 * "we don't know" and prunes nothing — folders themselves are never touched, only the membership
 * of gone sites. An empty folder is a perfectly good folder.
 */
export function pruneAssignments(state: FolderState, liveSlugs: ReadonlySet<string>): FolderState {
  if (liveSlugs.size === 0) return state;
  const assign: Record<string, string> = {};
  for (const [slug, folderId] of Object.entries(state.assign)) {
    if (liveSlugs.has(slug)) assign[slug] = folderId;
  }
  const changed = Object.keys(assign).length !== Object.keys(state.assign).length;
  return changed ? { folders: state.folders, assign } : state;
}

/** The rail's numbers: total, un-filed, and per folder (folders with no members show 0). */
export function countsByFolder(
  sites: readonly SiteSummary[],
  state: FolderState,
): { all: number; unfiled: number; byId: Record<string, number> } {
  const byId: Record<string, number> = {};
  for (const folder of state.folders) byId[folder.id] = 0;
  let unfiled = 0;
  for (const site of sites) {
    const id = state.assign[site.slug];
    if (id && id in byId) byId[id] += 1;
    else unfiled += 1;
  }
  return { all: sites.length, unfiled, byId };
}

/** Apply the rail's selection. Unknown filter ids fall back to All, so a deleted folder that is
 *  still selected shows everything instead of an empty grid with no explanation. */
/** Title or address contains the query, case-insensitively; a blank query keeps everything. */
export function filterBySearch(sites: readonly SiteSummary[], query: string): SiteSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sites];
  return sites.filter((s) => s.title.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q));
}

export function filterByFolder(sites: readonly SiteSummary[], state: FolderState, filter: string): SiteSummary[] {
  if (filter === FILTER_UNFILED) return sites.filter((s) => !(s.slug in state.assign));
  if (filter !== FILTER_ALL && state.folders.some((f) => f.id === filter)) {
    return sites.filter((s) => state.assign[s.slug] === filter);
  }
  return [...sites];
}
