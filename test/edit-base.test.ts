// The "base version" decision made before entering the editor. The UI itself needs a DOM (this repo's
// vitest runs in node, no jsdom), so the decisions are lifted into pure functions in lib/edit-base and
// asserted here against real inputs.
//
// This suite pins three things that would directly hurt users:
//   1. with a single version the picker must **not** get in the way;
//   2. a ?version= pointing at another site's / a nonexistent version must never be accepted as a base;
//   3. a chosen version whose entry filename differs from the current one must be refused — saving
//      writes back the current version's entry, so letting it through means the user edits a file
//      that is never served (they think they are done; nothing changes live).
import { describe, expect, it } from "vitest";
import {
  BASE_VERSION_ENTRY_NOTICE, BASE_VERSION_GONE_NOTICE, baseVersionUsable, firstParam, fmtBytes,
  planEditEntry, versionLabel,
} from "@/lib/edit-base";
import type { VersionInfo } from "@/lib/types";

/** The shape of listVersions: newest → oldest, each row carrying a current flag. */
function ver(id: string, over: Partial<VersionInfo> = {}): VersionInfo {
  return {
    id, siteId: "site_a", entry: "index.html", fileCount: 1, byteSize: 100,
    source: "edit", createdAt: 1_700_000_000_000, current: false, ...over,
  };
}

// newest → oldest, v3 is current
const V3 = ver("ver_3", { current: true });
const V2 = ver("ver_2");
const V1 = ver("ver_1", { source: "upload" });
const THREE = [V3, V2, V1];

const plan = (over: Partial<Parameters<typeof planEditEntry>[0]> = {}) => planEditEntry({
  versions: THREE, currentVersionId: "ver_3", currentEntry: "index.html", ...over,
});

describe("planEditEntry · with a single version nothing may get in the way", () => {
  it("single version + nothing specified → straight into the editor, base is the current version", () => {
    const got = planEditEntry({ versions: [V3], currentVersionId: "ver_3", currentEntry: "index.html" });
    expect(got).toEqual({ step: "editor", baseVersionId: "ver_3", baseIsCurrent: true });
  });

  it("an empty version list (history unreadable) still allows editing instead of stalling on the picker", () => {
    const got = planEditEntry({ versions: [], currentVersionId: "ver_3", currentEntry: "index.html" });
    expect(got).toEqual({ step: "editor", baseVersionId: "ver_3", baseIsCurrent: true });
  });

  it("with a single version even ?pick=1 must not show the picker — it would have one option", () => {
    const got = planEditEntry({ versions: [V3], currentVersionId: "ver_3", currentEntry: "index.html", forcePicker: true });
    expect(got.step).toBe("editor");
  });

  it("single version + garbage ?version= → quietly uses the only version, no error, no picker", () => {
    const got = planEditEntry({ versions: [V3], currentVersionId: "ver_3", currentEntry: "index.html", requestedVersion: "ver_nope" });
    expect(got).toEqual({ step: "editor", baseVersionId: "ver_3", baseIsCurrent: true });
  });
});

describe("planEditEntry · the three outcomes with multiple versions", () => {
  it("no version specified → pick first (this is the \"tell me which versions exist before I edit\" the user asked for)", () => {
    expect(plan()).toEqual({ step: "picker", notice: null });
  });

  it("current version specified → into the editor, flagged baseIsCurrent (the top bar must not show a based-on-an-old-version badge)", () => {
    expect(plan({ requestedVersion: "ver_3" })).toEqual({ step: "editor", baseVersionId: "ver_3", baseIsCurrent: true });
  });

  it("historical version specified → into the editor with it as the base and baseIsCurrent false", () => {
    expect(plan({ requestedVersion: "ver_1" })).toEqual({ step: "editor", baseVersionId: "ver_1", baseIsCurrent: false });
  });

  it("?pick=1 overrides an already specified version — \"Switch version\" from inside the editor must return to the picker", () => {
    expect(plan({ requestedVersion: "ver_1", forcePicker: true })).toEqual({ step: "picker", notice: null });
  });

  it("surrounding whitespace does not make a different version id", () => {
    expect(plan({ requestedVersion: "  ver_1  " })).toEqual({ step: "editor", baseVersionId: "ver_1", baseIsCurrent: false });
  });

  it("an empty string counts as unspecified (?version= with nothing after it)", () => {
    expect(plan({ requestedVersion: "" })).toEqual({ step: "picker", notice: null });
  });
});

describe("planEditEntry · security boundary: a version id not belonging to this site can never become the base", () => {
  // versions is the result of listVersions(slug), already filtered by siteId — so "another site's
  // version" cannot be found here. The point of this assertion is to pin the "not found → refuse"
  // behaviour itself: the truly fatal implementation would take the result of getVersion(id) (a global
  // lookup by id, ignoring siteId) as the base, which would serve another site's source under this slug.
  it("another site's version id → back to the picker with a reason, never used as the base", () => {
    const got = plan({ requestedVersion: "ver_other_site" });
    expect(got).toEqual({ step: "picker", notice: BASE_VERSION_GONE_NOTICE });
    // Crucially: not editor, and the id must not be passed through verbatim
    expect(JSON.stringify(got)).not.toContain("ver_other_site");
  });

  it("a version id that no longer exists (history was pruned) → likewise back to the picker", () => {
    expect(plan({ requestedVersion: "ver_deleted" })).toEqual({ step: "picker", notice: BASE_VERSION_GONE_NOTICE });
  });
});

describe("planEditEntry · must refuse when the entry filename differs from the current version", () => {
  const odd = ver("ver_odd", { entry: "slides.html" });
  const versions = [V3, odd, V1];

  it("refuses and explains why (otherwise the user thinks they are done while nothing changes live)", () => {
    const got = planEditEntry({ versions, currentVersionId: "ver_3", currentEntry: "index.html", requestedVersion: "ver_odd" });
    expect(got).toEqual({ step: "picker", notice: BASE_VERSION_ENTRY_NOTICE });
  });

  it("baseVersionUsable is clear on its own: same name usable, different name not", () => {
    expect(baseVersionUsable(V1, "index.html")).toBe(true);
    expect(baseVersionUsable(odd, "index.html")).toBe(false);
  });
});

describe("versionLabel · must match the v-number shown in the version history drawer", () => {
  it("counts from oldest to newest: the oldest is v1, the current (newest) is v3", () => {
    expect(versionLabel(THREE, "ver_1")).toBe("v1");
    expect(versionLabel(THREE, "ver_2")).toBe("v2");
    expect(versionLabel(THREE, "ver_3")).toBe("v3");
  });

  it("falls back to the raw id when not in the list instead of inventing a number", () => {
    expect(versionLabel(THREE, "ver_x")).toBe("ver_x");
  });
});

describe("firstParam · searchParams may be arrays", () => {
  it("takes the first of a repeated ?version=a&version=b", () => {
    expect(firstParam(["a", "b"])).toBe("a");
  });
  it("is null when absent", () => {
    expect(firstParam(undefined)).toBeNull();
    expect(firstParam([])).toBeNull();
  });
});

describe("fmtBytes · the size readout on a version row", () => {
  it("picks the B / KB / MB magnitude", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(999)).toBe("999 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(3 * 1048576)).toBe("3.0 MB");
  });
});
