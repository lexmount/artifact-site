// The "base version" decision made before entering the editor. Pure logic, no React, no DOM -- the
// server-side /s/[slug]/edit page and the client-side version picker share the same judgement, which
// is also why it can be asserted on directly in vitest under node.
//
// [Why there is a "base version" concept at all]
// Saving is always forward: /api/sites/:slug/edit creates a new version **on top of the current
// one** and never rewrites an old version. "Editing from a historical version" only means **the
// editor opens with that old version's content**; after saving it becomes the new current version
// (equivalent to "roll back, then tweak a few words" -- no history is lost). The UI must say this
// clearly, or users will believe they are modifying an old version in place.
//
// [Why entry is validated]
// Text writeback relies on aligning "mark index <-> source character offset", and editSite writes
// back using the **current version's** entry (a single-file site writes current.entry; a folder
// site copies the current tree and overwrites the path the caller passed). So as soon as the chosen
// version's entry filename differs from the current version's, the file the user edits and the file
// that ends up being served are not the same -- they will think the edit landed while nothing
// changed online. Today no code path can make versions of the same site have different entries
// (upload fixes entry, editSite reuses current.entry, rollbackTo reuses target.entry), yet we still
// reject it here: better to make the user pick another version than write changes into a file that
// will never be served.
import type { VersionInfo } from "@/lib/types";

/** With fewer versions than this there is nothing to choose from -- go straight to the editor instead of blocking with a one-option screen. */
export const PICKER_MIN_VERSIONS = 2;

/** The version named in the link is no longer in this site's version table (a different site, or the site was deleted and recreated). */
export const BASE_VERSION_GONE_NOTICE = "The version named in the link does not belong to this site (or no longer exists). Please pick another version.";

/** The selected version's entry filename differs from the current one -- see "Why entry is validated" in the file header. */
export const BASE_VERSION_ENTRY_NOTICE = "The selected version has a different entry file from the current one; editing from it would write changes into a file that is never served. Please pick another version.";

/** What the editor shows as "which old version I am editing from" -- present only when the base is not the current version. */
export interface EditBaseInfo {
  id: string;
  /** Version ordinal, e.g. "v3". Ordinals count from oldest to newest, matching the version-history drawer. */
  label: string;
  createdAt: number;
}

export type EditEntryPlan =
  /** Let the user pick a base version first. A non-null notice explains why "the previous choice does not count". */
  | { step: "picker"; notice: string | null }
  /** Go straight to the editor, with content taken from baseVersionId. */
  | { step: "editor"; baseVersionId: string; baseIsCurrent: boolean };

/**
 * Version ordinal. `listVersions` returns **newest -> oldest**, while the user thinks of v1 as the
 * earliest, so ordinal = total - index. Same algorithm as the version-history drawer; both places
 * must show the same v number.
 */
export function versionLabel(versions: readonly VersionInfo[], id: string): string {
  const at = versions.findIndex((v) => v.id === id);
  return at < 0 ? id : `v${versions.length - at}`;
}

/** Size readout on a version row: "how big is the whole site in this version". Below a KB, decimals are not worth showing. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Can this version serve as a base (its entry must match the current version's; see the file header). */
export function baseVersionUsable(version: VersionInfo, currentEntry: string): boolean {
  return version.entry === currentEntry;
}

/**
 * What to do first when /s/:slug/edit opens: enter the picker step, or go straight to the editor
 * (based on which version).
 *
 * `versions` must be the result of `listVersions(slug)` -- it is already filtered by siteId, so
 * "a version id from another site" is not found here and takes the same path as "does not exist".
 * Do **not** swap in something like `getVersion(id)` that looks up globally by id: that function
 * does not check siteId and would accept another site's version as a legitimate base.
 */
export function planEditEntry(input: {
  versions: readonly VersionInfo[];
  currentVersionId: string;
  currentEntry: string;
  /** Base version id given by ?version=. */
  requestedVersion?: string | null;
  /** ?pick=1 -- the user deliberately came back from the editor to switch versions; re-pick even if a version was specified. */
  forcePicker?: boolean;
}): EditEntryPlan {
  const { versions, currentVersionId, currentEntry } = input;
  const requested = input.requestedVersion?.trim() || null;
  // With only one version (or no version table at all) the picker step carries no information; always go straight to the editor.
  const canPick = versions.length >= PICKER_MIN_VERSIONS;
  const editCurrent = { step: "editor" as const, baseVersionId: currentVersionId, baseIsCurrent: true };

  if (input.forcePicker) return canPick ? { step: "picker", notice: null } : editCurrent;

  if (requested) {
    const target = versions.find((v) => v.id === requested);
    // Not found = does not exist, or does not belong to this site at all (versions is already filtered by siteId).
    if (!target) return canPick ? { step: "picker", notice: BASE_VERSION_GONE_NOTICE } : editCurrent;
    if (!baseVersionUsable(target, currentEntry)) {
      return canPick ? { step: "picker", notice: BASE_VERSION_ENTRY_NOTICE } : editCurrent;
    }
    return { step: "editor", baseVersionId: target.id, baseIsCurrent: target.id === currentVersionId };
  }

  return canPick ? { step: "picker", notice: null } : editCurrent;
}

/** Collapse a searchParams value that may be an array into a single string. */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
