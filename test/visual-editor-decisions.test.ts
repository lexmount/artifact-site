// The parent-page side of the visual editor: the handful of decisions where one wrong step loses the
// user's edit or shifts the blame onto the user. The component itself needs a DOM (this repo's vitest
// environment is node, without jsdom), so the decisions are extracted into pure functions and
// asserted here with real inputs — how a save wraps up, what the notice says, whose draft is dropped
// when switching views.
import { describe, expect, it } from "vitest";
import {
  checkServedVersion, editFrameUrl, expectedFrameVersion, FRAME_BLOCKED_MESSAGE, type FrameStats,
  planWriteback, readFrameStats, reloadOutdatesBaseline, statsCopy, unmappableNotice,
  VERSION_DRIFT_MESSAGE,
} from "@/components/visual-editor";
import { visualSwitchPlan } from "@/components/editor";
import { applyTextPatches, scanEditableText, type TextPatch } from "@/lib/text-writeback";

const patch = (el: number, i: number, before: string, text: string): TextPatch => ({ el, i, before, text });

describe("A2 · planWriteback — a partial write-back failure must not count as fully saved", () => {
  it("everything written back: clears the patches by key, and nothing is unsaved afterwards", () => {
    const plan = planWriteback([patch(1, 0, "a", "A"), patch(3, 1, "b", "B")], []);
    expect(plan.savedKeys).toEqual(["1:0", "3:1"]);
    expect(plan.reload).toBe(false);
    expect(plan.dirtyAfter).toBe(false);
    expect(plan.notice).toBeNull();
  });

  it("some could not be written back: clears **only** the successfully written keys; the rest still count as unsaved", () => {
    const plan = planWriteback([patch(1, 0, "a", "A")], [patch(9, 0, "c", "C")]);
    // Key point: 9:0 is not in there. The old implementation sent the iframe a saved message with no
    // arguments; the bootstrap did patches={} on receipt and wiped the unwritten ones too — the page
    // still showed the new text while the unsaved badge disappeared.
    expect(plan.savedKeys).toEqual(["1:0"]);
    expect(plan.dirtyAfter).toBe(true);
    expect(plan.notice).toContain("Not written back: 1");
    expect(plan.reload).toBe(false);
  });

  it("one passage emptied to a blank string: reloads the whole edit frame and says the unwritten passages were reverted", () => {
    const plan = planWriteback([patch(1, 0, "a", "   ")], [patch(9, 0, "c", "C")]);
    expect(plan.reload).toBe(true);
    expect(plan.savedKeys).toEqual([]); // reloaded, so clearing patches by key is meaningless
    expect(plan.dirtyAfter).toBe(false);
    expect(plan.notice).toContain("reverted");
  });

  it("fed a real half-written result: the numbers and keys come from applyTextPatches, not from guesswork", () => {
    const src = "<html><body><h1>标题</h1><p>正文</p></body></html>";
    const [h1] = [...scanEditableText(src).keys()]; // the first element with text under body
    const result = applyTextPatches(src, [
      { el: h1, i: 0, before: "标题", text: "新标题" },     // matches → applied
      { el: h1, i: 0, before: "标题", text: "重复的一条" },  // same key → skipped
      { el: 999, i: 0, before: "早就不在了", text: "无所谓" }, // cannot be located → skipped
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);

    const plan = planWriteback(result.applied, result.skipped);
    expect(plan.savedKeys).toEqual([`${h1}:0`]);
    expect(plan.dirtyAfter).toBe(true);
    expect(plan.notice).toContain("Changes saved: 1");
    expect(plan.notice).toContain("Not written back: 2");
  });
});

// "This site was updated elsewhere. Refresh the page before editing" may appear only when someone
// **really** changed the site elsewhere. On the path that triggers a reload (a passage edited to
// empty → indices shift → marks must be re-applied on the new source), the server has already
// produced a new version id at save time; if the save response does not carry versionId back
// (`/edit` always does today, but a middle layer mangling the body, or the endpoint dropping a field
// some day, both land here), the parent's baseline is doomed to lag the server, and the check after
// the reload is bound to mismatch — the user just saved successfully, yet the UI tells them "someone
// else changed it, refresh", with no way to verify.
describe("version drift can only be real drift — your own save does not count", () => {
  it("normal path: the save returned a versionId, so the check need not be skipped", () => {
    expect(reloadOutdatesBaseline(true, "v2", true)).toBe(false);
    expect(checkServedVersion("v2", "v2", false)).toEqual({ ok: true, adopt: null });
  });

  it("someone really changed the site elsewhere: still blocked, with the refresh notice", () => {
    expect(reloadOutdatesBaseline(true, "v2", false)).toBe(false);
    expect(checkServedVersion("v9", "v2", false)).toEqual({ ok: false, adopt: null });
    expect(VERSION_DRIFT_MESSAGE).toContain("Refresh");
  });

  // This is the bug: save succeeds → a patch emptied some text → plan.reload → the edit frame is
  // re-fetched, and the server reports the freshly created version, which does not match the old
  // baseline in hand.
  it("save succeeded without a versionId and a reload is needed: skips the check and adopts the version the server reports as the new baseline", () => {
    const plan = planWriteback([patch(1, 0, "a", "  ")], []); // emptied → must reload
    expect(plan.reload).toBe(true);

    const selfSaved = reloadOutdatesBaseline(true, null, plan.reload);
    expect(selfSaved).toBe(true);

    const gate = checkServedVersion("v3-刚生成", "v2-旧基线", selfSaved);
    expect(gate.ok).toBe(true);            // the old implementation threw "the site was updated elsewhere" here
    expect(gate.adopt).toBe("v3-刚生成");   // the new baseline comes from served, not from comparing against the old one again
  });

  it("the skip is one-shot: after adopting the new baseline, the next real drift is still caught", () => {
    const first = checkServedVersion("v3", "v2", true);
    expect(first.adopt).toBe("v3");
    // In the component skipVersionCheckRef is read once and cleared, so the second time selfSaved=false.
    expect(checkServedVersion("v4", first.adopt!, false)).toEqual({ ok: false, adopt: null });
    expect(checkServedVersion("v3", first.adopt!, false)).toEqual({ ok: true, adopt: null });
  });

  it("no POST at all (every patch was 'no real change'): no skip, since the server produced no new version and the baseline is still valid", () => {
    expect(reloadOutdatesBaseline(false, null, true)).toBe(false);
  });

  it("the server reported no version: nothing to compare and nothing to adopt", () => {
    expect(checkServedVersion(null, "v2", false)).toEqual({ ok: true, adopt: null });
    expect(checkServedVersion(null, "v2", true)).toEqual({ ok: true, adopt: null });
  });
});

describe("A6 · the failed-lookup notice must not shift the blame", () => {
  it("no longer insists 'this text was generated by the page script'; every reason offers a next step", () => {
    for (const reason of [undefined, "unmarked", "copy", "duplicate", "replaced", "structure", 42]) {
      const notice = unmappableNotice(reason);
      expect(notice).not.toContain("generated by the page script");
      // "Edit that passage in the main content" and "use the source editor" both count as a way out; a bare "cannot edit" is not allowed.
      expect(notice.includes("Edit source") || notice.includes("main content")).toBe(true);
    }
  });

  it("gives different wording when the reasons can be told apart, and only states the fact when they cannot", () => {
    const copy = unmappableNotice("copy");
    const replaced = unmappableNotice("replaced");
    const structure = unmappableNotice("structure");
    const unknown = unmappableNotice("unmarked");
    expect(new Set([copy, replaced, structure, unknown]).size).toBe(4);
    expect(structure).toContain("structure");
    expect(unmappableNotice(undefined)).toBe(unknown); // when the reason is unknown it falls back to the same neutral description
  });

  // Once the rule changed from "more than one element with this number means refuse" to "first
  // seen wins", the meaning of this notice changed too: no longer "this text cannot be edited" but
  // "the one you clicked is a copy; the one in the main content is editable". The copy must say
  // where the editable one is, or the user assumes the whole page is frozen — which is exactly the
  // experience that was reported.
  it("clicked a copy: says it is a copy and where the editable one is, without pushing the user to the source editor", () => {
    const copy = unmappableNotice("copy");
    expect(copy).toContain("copy");
    expect(copy).toContain("main content");
    expect(copy).not.toContain("Edit source");
    // `duplicate` is the name from before the rule change: a mixed-version edit frame (new parent
    // page + the iframe script from the previous deployment) must not fall through to the vaguest
    // fallback.
    expect(unmappableNotice("duplicate")).toBe(copy);
  });

  it("original swapped out, only a copy left: says 'nobody can edit this', not 'edit it in the main content'", () => {
    const replaced = unmappableNotice("replaced");
    expect(replaced).toContain("Edit source");
    expect(replaced).not.toBe(unmappableNotice("copy"));
  });

  it("the framing-timeout explanation gives the real reason, not 'the page is large'", () => {
    expect(FRAME_BLOCKED_MESSAGE).not.toContain("page is large");
    expect(FRAME_BLOCKED_MESSAGE).toContain("Content-Security-Policy");
    expect(FRAME_BLOCKED_MESSAGE).toContain("Edit source");
  });
});

// A3 · Be upfront on entering the editor. In the user's words: "I'm already in and still can't edit
// — popping that notice is weird" — so "how much of this page is editable and why the rest is not"
// must be a permanent note on the toolbar, not a refusal that pops after a double-click.
describe("A3 · the permanent note and the 'nothing is editable' terminal state", () => {
  const stats = (over: Partial<FrameStats> = {}): FrameStats =>
    ({ editable: 0, script: 0, structure: 0, copied: 0, ...over });

  it("everything editable: says only how much, without inventing bad news", () => {
    const copy = statsCopy(stats({ editable: 42 }));
    expect(copy.blocked).toBe(false);
    expect(copy.line).toContain("42");
    expect(copy.line).not.toContain("another");
  });

  it("some uneditable: lays out both the counts and the reasons", () => {
    const copy = statsCopy(stats({ editable: 42, script: 8 }));
    expect(copy.blocked).toBe(false);
    expect(copy.line).toContain("42 passages");
    expect(copy.line).toContain("8 passages");
    expect(copy.line).toContain("script");
    expect(copy.line).toContain("Edit source");
  });

  it("all three uneditable reasons can appear at once, each with its own number", () => {
    const copy = statsCopy(stats({ editable: 5, script: 8, structure: 3, copied: 2 }));
    expect(copy.line).toContain("8 passages");
    expect(copy.line).toContain("3 passages");
    expect(copy.line).toContain("2 passages");
  });

  // When the whole page is script-rendered, do not let the user go in and try word by word.
  it("nothing editable: blocked is true, and the reason is explained", () => {
    const copy = statsCopy(stats({ editable: 0, script: 30 }));
    expect(copy.blocked).toBe(true);
    expect(copy.line).toContain("30 passages");
    expect(copy.line).toContain("Edit source");
  });

  it("nothing editable and no reason to give: still the terminal state, just without guessing at a reason", () => {
    const copy = statsCopy(stats());
    expect(copy.blocked).toBe(true);
    expect(copy.line).toContain("Edit source");
    expect(copy.line).not.toContain("0 passages");
  });

  it("the stats arrive by postMessage from the iframe; their shape is not trusted input", () => {
    expect(readFrameStats({ editable: 3, script: 1, structure: 0, copied: 0 }))
      .toEqual({ editable: 3, script: 1, structure: 0, copied: 0 });
    // Missing fields / wrong types / negatives / NaN / fractions: treated as 0 or truncated; NaN must never seep into the copy
    expect(readFrameStats({})).toEqual({ editable: 0, script: 0, structure: 0, copied: 0 });
    expect(readFrameStats({ editable: "42", script: -1, structure: Number.NaN, copied: 2.7 }))
      .toEqual({ editable: 0, script: 0, structure: 0, copied: 2 });
    expect(statsCopy(readFrameStats({ editable: Number.NaN })).line).not.toContain("NaN");
  });
});

// A4 · The version contract. "This site was updated elsewhere. Refresh the page before editing" may
// appear only when **someone else** changed the site; a user picking a historical version as the
// base asked for exactly that, and it is not drift.
describe("A4 · fetching the edit frame for a pinned version", () => {
  it("no version means the plain URL; a version adds ?version= with the value escaped", () => {
    expect(editFrameUrl("abc")).toBe("/api/sites/abc/edit-frame");
    expect(editFrameUrl("abc", undefined)).toBe("/api/sites/abc/edit-frame");
    expect(editFrameUrl("abc", "ver_1")).toBe("/api/sites/abc/edit-frame?version=ver_1");
    expect(editFrameUrl("abc", "a b&c=d")).toBe("/api/sites/abc/edit-frame?version=a%20b%26c%3Dd");
  });

  it("expected version: the pinned historical version when pinned, otherwise the baseline that advances with each save", () => {
    expect(expectedFrameVersion(undefined, "v-current")).toBe("v-current");
    expect(expectedFrameVersion("v-old", "v-current")).toBe("v-old");
  });

  // This pins the "two version checks fighting each other" trap: the user picks v1 as the base,
  // saves once on top of it (the baseline advances to the newly created v9), and the edit-frame
  // reload fires right after — the server still serves ?version=v1 and reports v1. Comparing
  // against the baseline would declare the version the user just chose as "updated elsewhere".
  it("pinned to a historical version + just saved: not drift", () => {
    const pinned = "v1";
    const baselineAfterSave = "v9"; // the version the save created; versionRef has already advanced
    const gate = checkServedVersion(pinned, expectedFrameVersion(pinned, baselineAfterSave), false);
    expect(gate.ok).toBe(true);
    // Comparing against the baseline goes red — exactly the mistake the old code made.
    expect(checkServedVersion(pinned, baselineAfterSave, false).ok).toBe(false);
  });

  it("without a pinned version, real drift is still caught", () => {
    expect(checkServedVersion("v9", expectedFrameVersion(undefined, "v2"), false))
      .toEqual({ ok: false, adopt: null });
  });
});

describe("A5 · switching to visual editing may drop only the entry file's draft", () => {
  const saved = { "index.html": "<h1>H</h1>", "app.js": "let a=1;", "style.css": "b{}" };

  it("only other files are dirty: no confirmation, and the draft is untouched", () => {
    const draft = { ...saved, "app.js": "let a=2; // 改了一半" };
    const plan = visualSwitchPlan(draft, saved, "index.html");
    expect(plan.needsConfirm).toBe(false);
    expect(plan.nextDraft).toBe(draft); // same reference: nothing was touched at all
  });

  it("the entry is dirty: after confirming only the entry is rolled back; unsaved edits in other files survive intact", () => {
    const draft = { ...saved, "index.html": "<h1>改过</h1>", "app.js": "let a=2;", "style.css": "b{color:red}" };
    const plan = visualSwitchPlan(draft, saved, "index.html");
    expect(plan.needsConfirm).toBe(true);
    // The old implementation was setDraft({ ...saved }): the two lines below would revert to saved,
    // and the user's half-edited app.js/style.css would simply be gone, while the confirm dialog
    // only said "source edits will not be carried over".
    expect(plan.nextDraft["app.js"]).toBe("let a=2;");
    expect(plan.nextDraft["style.css"]).toBe("b{color:red}");
    expect(plan.nextDraft["index.html"]).toBe(saved["index.html"]);
  });

  it("nothing changed: no confirmation", () => {
    const plan = visualSwitchPlan({ ...saved }, saved, "index.html");
    expect(plan.needsConfirm).toBe(false);
  });

  it("an entry missing from the file table must not pop a dialog either", () => {
    const plan = visualSwitchPlan({ ...saved }, saved, "missing.html");
    expect(plan.needsConfirm).toBe(false);
  });
});
