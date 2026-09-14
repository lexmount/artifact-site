// Account-level folders (issue #35): the server-side counterpart of the browser-local shelf in
// lib/folders.ts. Same shape (`FolderState`: a folder list plus slug → folderId), so the UI can
// render either source with one component; the difference is where it lives and who can see it.
//
// Rules that are policy, not plumbing:
//   · a user may only file sites that are theirs to see in "My sites": owned, or shared with them
//     as a collaborator. Anything else is refused, never silently stored.
//   · importing the browser-local shelf after sign-in only FILLS GAPS: a folder with the same name
//     is reused, a site already filed on the account keeps its server folder. The account is the
//     source of truth the moment it exists; the local copy is evidence, not an overwrite.
import "server-only";
import {
  createId, deleteFolder as deleteFolderRow, getSiteBySlug, insertFolder, listFolderAssignments, listFolders,
  listSitesByOwner, listSitesForCollaborator, renameFolder as renameFolderRow, setFolderAssignment,
} from "@/lib/db";
import { MAX_FOLDERS, normalizeFolderName, type FolderState } from "@/lib/folders";

export class FolderError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "FolderError";
  }
}

export async function getFolderState(userId: string): Promise<FolderState> {
  const [folders, assignments] = await Promise.all([listFolders(userId), listFolderAssignments(userId)]);
  const assign: Record<string, string> = {};
  for (const a of assignments) assign[a.slug] = a.folderId;
  return { folders: folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })), assign };
}

export async function createUserFolder(userId: string, rawName: string, now = Date.now()): Promise<{ id: string; name: string; createdAt: number }> {
  const name = normalizeFolderName(rawName);
  if (!name) throw new FolderError("A folder name cannot be empty");
  const id = createId("fld");
  // The cap is enforced by the insert itself (count + sort + write in one statement), so two
  // concurrent creates cannot both slip under it.
  if (!(await insertFolder({ id, userId, name, createdAt: now }, MAX_FOLDERS))) throw new FolderError(`At most ${MAX_FOLDERS} folders`);
  return { id, name, createdAt: now };
}

export async function renameUserFolder(userId: string, id: string, rawName: string, now = Date.now()): Promise<void> {
  const name = normalizeFolderName(rawName);
  if (!name) throw new FolderError("A folder name cannot be empty");
  if (!(await renameFolderRow(id, userId, name, now))) throw new FolderError("Folder not found", 404);
}

export async function deleteUserFolder(userId: string, id: string): Promise<void> {
  if (!(await deleteFolderRow(id, userId))) throw new FolderError("Folder not found", 404);
}

/** Slugs the user may file: what "My sites" shows them when signed in. */
async function fileableSlugs(userId: string): Promise<Set<string>> {
  const [owned, collaborating] = await Promise.all([listSitesByOwner(userId), listSitesForCollaborator(userId)]);
  return new Set([...owned, ...collaborating].map((s) => s.slug));
}

export async function assignUserSite(userId: string, slug: string, folderId: string | null, now = Date.now()): Promise<void> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) throw new FolderError("site not found", 404);
  if (!(await fileableSlugs(userId)).has(slug)) throw new FolderError("site not found", 404);
  if (!(await setFolderAssignment(userId, site.id, folderId, now))) throw new FolderError("Folder not found", 404);
}

/** Bounds on a one-time import: a browser's shelf is small; anything larger is not a shelf. */
const MAX_IMPORT_ASSIGNMENTS = 500;

export interface ImportReport {
  foldersCreated: number;
  foldersMatched: number;
  sitesFiled: number;
  sitesSkipped: number;
}

/**
 * Merge a browser-local shelf into the account (once, right after sign-in). Folders match by
 * normalised name (case-insensitive); unknown names are created up to the cap; assignments are
 * applied only for sites the user may file that are not already filed on the account.
 */
export async function importFolderState(userId: string, local: FolderState, now = Date.now()): Promise<{ state: FolderState; report: ImportReport }> {
  const report: ImportReport = { foldersCreated: 0, foldersMatched: 0, sitesFiled: 0, sitesSkipped: 0 };
  const existing = await listFolders(userId);
  const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f.id]));
  const idMap = new Map<string, string>(); // local id → server id

  for (const folder of local.folders) {
    const name = normalizeFolderName(folder.name);
    if (!name) continue;
    const matched = byName.get(name.toLowerCase());
    if (matched) { idMap.set(folder.id, matched); report.foldersMatched += 1; continue; }
    const id = createId("fld");
    if (!(await insertFolder({ id, userId, name, createdAt: now }, MAX_FOLDERS))) continue; // cap reached: leave the rest un-imported
    byName.set(name.toLowerCase(), id);
    idMap.set(folder.id, id);
    report.foldersCreated += 1;
  }

  const fileable = await fileableSlugs(userId);
  const already = new Set((await listFolderAssignments(userId)).map((a) => a.slug));
  for (const [slug, localFolderId] of Object.entries(local.assign).slice(0, MAX_IMPORT_ASSIGNMENTS)) {
    const folderId = idMap.get(localFolderId);
    if (!folderId || !fileable.has(slug) || already.has(slug)) { report.sitesSkipped += 1; continue; }
    const site = await getSiteBySlug(slug);
    if (!site || site.deletedAt) { report.sitesSkipped += 1; continue; }
    if (await setFolderAssignment(userId, site.id, folderId, now)) report.sitesFiled += 1;
    else report.sitesSkipped += 1;
  }

  return { state: await getFolderState(userId), report };
}
