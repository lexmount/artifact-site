// The editor's one bar (design 04): back · title · version on the left, Edit / Preview in the middle, unsaved ·
// the other editor · "···" · Save new version on the right. The mode switch and the save belong to the visual
// editor's frame channel, so the visual editor REPORTS its state up and the page renders the controls — these
// tests pin that split, so nobody quietly grows a second toolbar inside the frame component again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");
const editor = read("src/components/editor.tsx");
const visual = read("src/components/visual-editor.tsx");
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, " ");

const block = (src: string, head: string, tail: string) => {
  const start = src.indexOf(head);
  expect(start, `找不到 ${head}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(tail, start + head.length);
  expect(end, `找不到 ${tail}`).toBeGreaterThan(start);
  return src.slice(start, end + tail.length);
};

describe("the editor header is the only toolbar", () => {
  // The locked ("no edit access") screen has a header of the same class before this one; the editor proper starts at the keyboard-handling root.
  const page = editor.slice(editor.indexOf('<div className="editor" onKeyDown={onKeyDown}>'));
  const header = block(page, '<header className="editor-bar">', "</header>");

  it("three parts, in order: where you are, Edit / Preview, the way out", () => {
    const left = header.indexOf('className="editor-bar-left"');
    const mode = header.indexOf('className="segmented ve-mode"');
    const right = header.indexOf('className="editor-bar-right"');
    expect(left).toBeGreaterThanOrEqual(0);
    expect(mode).toBeGreaterThan(left);
    expect(right).toBeGreaterThan(mode);
  });

  it("the mode switch and the save drive the visual editor through its reported state, and only in visual mode", () => {
    const mode = block(header, '{visual && (\n          <div className="segmented ve-mode"', "</div>\n        )}");
    expect(mode).toContain("ve?.togglePreview(false)");
    expect(mode).toContain("ve?.togglePreview(true)");
    expect(mode).toContain("aria-pressed={!ve?.previewing}");
    expect(mode).toContain("disabled={!ve?.ready}");
    const right = block(header, '<div className="editor-bar-right">', "</header>");
    expect(right).toContain("onClick={() => ve?.save()} disabled={!ve?.dirty || !!ve?.busy || !ve?.ready}");
    expect(right).toContain("onClick={save} disabled={!sourceDirty || busy}"); // the source editor's own save, same button
    expect(right.match(/\{t\("Save new version"\)\}/g)).toHaveLength(2);
    expect(right).not.toContain('{t("Save")}'); // one name for the one action
  });

  it("unsaved is shown before the primary action, the other editor stays a quiet secondary, the rest folds behind ···", () => {
    const right = block(header, '<div className="editor-bar-right">', "</header>");
    expect(right.indexOf('{anyDirty && <span className="ve-pill">')).toBeLessThan(right.indexOf("<MoreMenu"));
    expect(right).toContain('className="ve-secondary" type="button" onClick={enterSource}');
    expect(right).toContain('className="ve-secondary" type="button" onClick={enterVisual}');
    const menu = block(right, "<MoreMenu", "</MoreMenu>");
    expect(menu).toContain('label={t("More")} iconOnly');
    for (const item of ['{t("Open in new tab")}', '{t("Save as new site")}', '{t("Switch version")}']) expect(menu).toContain(item);
    expect(menu.match(/role="menuitem"/g)?.length).toBe(3);
    expect(header).not.toContain('className="btn sm ghost"'); // nothing in the bar outside the menu but the two designed buttons
  });

  it("which version is being edited stays on the bar (an old base must never be invisible)", () => {
    const left = block(header, '<div className="editor-bar-left">', "</div>\n\n");
    expect(left).toContain('t("Based on {label}", { label: baseVersion.label })');
    expect(left).toContain('t("Editing version {version}", { version: shortVer })');
  });
});

describe("the visual editor reports, it does not render controls", () => {
  it("reports mode, dirty, busy, readiness and the two actions whenever they change", () => {
    expect(visual).toContain("onState?: (state: VisualEditorState) => void;");
    expect(visual).toContain('onState?.({ previewing, dirty, busy, ready: phase === "ready", togglePreview, save });');
    expect(visual).toContain("}, [onState, previewing, dirty, busy, phase, togglePreview, save]);");
    expect(editor).toContain("onState={setVe}");
  });

  it("no segmented switch, no save button of its own; the hint line sits under the canvas", () => {
    expect(visual).not.toContain('className="segmented ve-mode"');
    expect(visual).not.toContain("visual-editor-bar");
    expect(visual).not.toMatch(/className="btn[^"]*"[^>]*onClick=\{save\}/);
    const foot = block(visual, '<div className="visual-editor-foot">', "</div>\n    </div>\n  );");
    expect(foot).toContain('{t("Double-click any text to rewrite it · Enter to confirm · Esc to cancel")}');
    expect(visual.indexOf('className="visual-editor-stage"')).toBeLessThan(visual.indexOf('className="visual-editor-foot"'));
  });
});

describe("the CSS carries the bar and nothing for the toolbar that is gone", () => {
  it("one bar, three columns; the foot line exists; the old in-frame bar has no rules left", () => {
    const bar = [...css.matchAll(/^\.editor-bar \{([^}]*)\}/gm)].map((m) => m[1]).join(" "); // every top-level .editor-bar rule
    expect(bar).toContain("display: grid");
    expect(bar).toContain("grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)");
    expect(css).toContain(".editor-bar > .ve-mode { grid-column: 2;");
    expect(css).toContain(".editor-bar-right { grid-column: 3;");
    expect(css).toContain(".visual-editor-foot {");
    expect(css).not.toContain(".visual-editor-bar");
  });
});
