// The bootstrap injected into the edit frame, **actually running** inside a minimal fake DOM (see
// test/dom-harness). These tests pin down the handful of things where one wrong step either writes
// the user's edit to the wrong place or declares the whole page uneditable; each test reproduces
// the corresponding bug:
//   A1 can an artifact's own script impersonate the bootstrap and hijack saving? (the answer must be: it never gets the port, so no);
//   A2 when part of a write-back fails, are the patches cleared unconditionally? (only the successfully written keys may be cleared);
//   A4 after a script clones marked elements, which copy stays editable and where in the source the edit lands (the "first seen wins" group).
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeDocument,
  type FakeElement,
  type FakeWindow,
  type Harness,
  flush,
  marked,
  messageEvent,
  mountBootstrap,
  tick,
} from "./dom-harness";

const NONCE = "nonce_test";
const live: Harness[] = [];

afterEach(() => { for (const h of live.splice(0)) h.close(); });

function mount(...args: Parameters<typeof mountBootstrap>): Harness {
  const h = mountBootstrap(...args);
  live.push(h);
  return h;
}

function last(h: Harness, type: string): Record<string, unknown> {
  const hit = [...h.inbox].reverse().find((m) => m.type === type);
  if (!hit) throw new Error(`no ${type} in inbox: ${JSON.stringify(h.inbox)}`);
  return hit;
}

function types(h: Harness): string[] {
  return h.inbox.map((m) => String(m.type));
}

/** Double-click → change the text → confirm with Enter: one complete user edit. */
function edit(h: Harness, target: FakeElement, text: string): void {
  h.dblclick(target);
  const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
  if (!wrap) throw new Error("双击没有进入编辑态");
  wrap.textContent = text;
  h.doc.dispatch("input", { target: wrap });
  h.doc.dispatch("keydown", { key: "Enter", target: wrap });
}

describe("A1 · the channel must be a private MessagePort", () => {
  it("a message listener registered by the artifact's script never sees the handshake event, so it cannot obtain the port", async () => {
    const seen: unknown[] = [];
    const h = mount({
      build: (body) => { body.appendChild(marked("p", 1, ["hi"])); },
      // The artifact's own script: the bootstrap is injected at the very start of <head>, so this listener is always registered after the bootstrap's.
      extraScript: (win) => { win.addEventListener("message", (e) => { seen.push(e); }); },
    });

    h.handshake();
    await tick();

    expect(types(h)).toContain("ah-editor:ready"); // the bootstrap got the port
    expect(seen).toHaveLength(0);                  // the artifact's script never even saw the event
  });

  it("a ping the page itself postMessages cannot steal the channel (e.source is not parent)", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("p", 1, ["hi"])); } });
    const rogue = new MessageChannel();
    const stolen: unknown[] = [];
    rogue.port1.onmessage = (e) => { stolen.push(e.data); };
    rogue.port1.start();

    // The artifact's script knows the nonce (it is right there in the injected script's textContent), so it offers its own port in exchange.
    h.emit(messageEvent({ source: h.win, data: { type: "ah-editor:ping", nonce: NONCE }, ports: [rogue.port2] }));
    await tick();
    expect(stolen).toHaveLength(0);

    h.handshake();
    await tick();
    expect(types(h)).toContain("ah-editor:ready");
    expect(stolen).toHaveLength(0);

    rogue.port1.close();
    rogue.port2.close();
  });

  it("a ping forged via dispatchEvent cannot steal the channel (isTrusted is false)", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("p", 1, ["hi"])); } });
    const rogue = new MessageChannel();
    const stolen: unknown[] = [];
    rogue.port1.onmessage = (e) => { stolen.push(e.data); };
    rogue.port1.start();

    // Even source is forged as parent; only isTrusted gives it away.
    h.emit(messageEvent({ isTrusted: false, source: h.parent, data: { type: "ah-editor:ping", nonce: NONCE }, ports: [rogue.port2] }));
    await tick();
    expect(stolen).toHaveLength(0);

    rogue.port1.close();
    rogue.port2.close();
  });

  it("a ping whose nonce does not match is ignored", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("p", 1, ["hi"])); } });
    const rogue = new MessageChannel();
    const stolen: unknown[] = [];
    rogue.port1.onmessage = (e) => { stolen.push(e.data); };
    rogue.port1.start();

    h.emit(messageEvent({ source: h.parent, data: { type: "ah-editor:ping", nonce: "someone_elses" }, ports: [rogue.port2] }));
    await tick();
    expect(stolen).toHaveLength(0);

    rogue.port1.close();
    rogue.port2.close();
  });

  it("a handshake while the document is still loading sends no ready; it goes out only after DOMContentLoaded", async () => {
    const h = mount({ readyState: "loading", build: (body) => { body.appendChild(marked("p", 1, ["hi"])); } });

    h.handshake();
    await tick();
    expect(h.inbox).toHaveLength(0); // not booted yet

    h.doc.dispatch("DOMContentLoaded", {});
    await tick();
    expect(types(h)).toContain("ah-editor:ready");
  });

  it("patches come back only over the port and contain exactly the passages the user actually changed", async () => {
    let p!: FakeElement;
    const h = mount({ build: (body) => { p = marked("p", 4, ["旧文"]); body.appendChild(p); } });
    h.handshake();
    await tick();

    edit(h, p, "新文");
    h.send({ type: "ah-editor:save" });
    await tick();

    expect(last(h, "ah-editor:patch").patches).toEqual([{ el: 4, i: 0, before: "旧文", text: "新文" }]);
  });
});

describe("A2 · a partial write-back failure must not wipe the patches along with it", () => {
  it("ah-editor:saved clears only the keys that were written back; the rest still count as unsaved and can be submitted again", async () => {
    let one!: FakeElement;
    let two!: FakeElement;
    const h = mount({
      build: (body) => {
        one = marked("p", 1, ["一"]);
        two = marked("p", 2, ["二"]);
        body.appendChild(one);
        body.appendChild(two);
      },
    });
    h.handshake();
    await tick();

    edit(h, one, "改一");
    edit(h, two, "改二");
    await tick();
    expect(last(h, "ah-editor:dirty").count).toBe(2);

    h.send({ type: "ah-editor:save" });
    await tick();
    expect((last(h, "ah-editor:patch").patches as unknown[])).toHaveLength(2);

    // This round the parent page wrote back only 1:0 (the other passage no longer matches the source).
    h.send({ type: "ah-editor:saved", keys: ["1:0"] });
    await tick();
    // The old implementation did patches={} and wiped everything: this would be 0, the unsaved badge would vanish and the edit would be lost silently.
    expect(last(h, "ah-editor:dirty").count).toBe(1);

    h.send({ type: "ah-editor:save" });
    await tick();
    expect(last(h, "ah-editor:patch").patches).toEqual([{ el: 2, i: 0, before: "二", text: "改二" }]);
  });

  it("when everything is written back the patches are cleared and the unsaved count drops to zero", async () => {
    let p!: FakeElement;
    const h = mount({ build: (body) => { p = marked("p", 1, ["一"]); body.appendChild(p); } });
    h.handshake();
    await tick();

    edit(h, p, "改一");
    h.send({ type: "ah-editor:saved", keys: ["1:0"] });
    await tick();
    expect(last(h, "ah-editor:dirty").count).toBe(0);

    h.send({ type: "ah-editor:save" });
    await tick();
    expect(last(h, "ah-editor:patch").patches).toEqual([]);
  });
});

// —— A4 · "first seen wins" ——
//
// Triggered by a real slide-deck artifact (slug A0nHe4kUhqPh): its assets/runtime.js builds a
// thumbnail panel by calling `cloneNode(true)` on every slide, so **every passage exists twice in
// the DOM**. The old rule was "exactly one element with this number", so double-clicking any word
// of the body text was rejected — not a single word on the page could be edited. Yet the user was
// clicking the original; the copy sat in a pointerEvents:none container that cannot be clicked at
// all. The rule was too coarse; the artifact was not at fault.
//
// The rule now: the element in which a given mark number **first** appears in the document is the
// authoritative one (the original from the source necessarily enters the document before any script
// clone). The original stays editable; copies are always refused.
describe("A4 · first seen wins", () => {
  /** Builds a "body + thumbnail panel" the way /tmp/art.js does: the panel holds a deep copy of the body. */
  function deck(body: FakeElement, doc: FakeDocument): { title: FakeElement; slide: FakeElement } {
    const slide = doc.createElement("section");
    const title = marked("h1", 2, ["第一页标题"]);
    slide.appendChild(title);
    slide.appendChild(marked("p", 3, ["第一页正文"]));
    body.appendChild(slide);
    return { title, slide };
  }
  /** The thumbnail runtime.js builds on load: a mini container (pointer-events:none) holding a deep copy. */
  function overview(body: FakeElement, doc: FakeDocument, slide: FakeElement): FakeElement {
    const panel = doc.createElement("div");
    const thumb = doc.createElement("div");
    const mini = doc.createElement("div");
    mini.appendChild(slide.cloneNode());
    thumb.appendChild(mini);
    const overlay = doc.createElement("div");
    const n = doc.createElement("div");
    n.appendChild(doc.createTextNode("1"));          // script-generated slide number
    const t = doc.createElement("div");
    t.appendChild(doc.createTextNode("第一页标题"));  // script-generated title (same text as the body, but unmarked)
    overlay.appendChild(n);
    overlay.appendChild(t);
    thumb.appendChild(overlay);
    panel.appendChild(thumb);
    body.appendChild(panel);
    return panel;
  }

  it("the original in the body stays editable even when the thumbnail panel holds an identical copy (this is the fix)", async () => {
    let title!: FakeElement;
    let slide!: FakeElement;
    const h = mount({ build: (body, doc) => { ({ title, slide } = deck(body, doc)); } });
    h.handshake();
    await flush();

    overview(h.doc.body, h.doc, slide);
    await flush();
    // The copy really is on the page, carrying the same mark number — exactly the one the old rule choked on.
    expect(h.doc.querySelectorAll('[data-ah-node="2"]')).toHaveLength(2);

    edit(h, title, "改过的标题");
    h.send({ type: "ah-editor:save" });
    await flush();
    // Old implementation: double-clicking the original was reject("duplicate"), editing never started, and edit() threw "double-click did not enter edit mode".
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 2, i: 0, before: "第一页标题", text: "改过的标题" },
    ]);
  });

  it("double-clicking a copy: refused with reason copy, and does **not** jump to the original (predictability first)", async () => {
    let slide!: FakeElement;
    const h = mount({ build: (body, doc) => { ({ slide } = deck(body, doc)); } });
    h.handshake();
    await flush();

    overview(h.doc.body, h.doc, slide);
    await flush();
    const copy = h.doc.querySelectorAll('[data-ah-node="2"]')[1];

    h.dblclick(copy);
    await flush();
    expect(last(h, "ah-editor:unmappable").reason).toBe("copy");
    expect(h.doc.querySelectorAll("[data-ah-wrap]")).toHaveLength(0); // the caret was not quietly moved to the original

    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([]);
  });

  it("ten copies do not affect the original either (the rule is 'is it the first seen', not 'how many are there')", async () => {
    let title!: FakeElement;
    let slide!: FakeElement;
    const h = mount({ build: (body, doc) => { ({ title, slide } = deck(body, doc)); } });
    h.handshake();
    await flush();

    for (let i = 0; i < 10; i++) h.doc.body.appendChild(slide.cloneNode());
    await flush();
    expect(h.doc.querySelectorAll('[data-ah-node="2"]')).toHaveLength(11);

    edit(h, title, "还是能改");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 2, i: 0, before: "第一页标题", text: "还是能改" },
    ]);
  });

  // This expectation is the **opposite** of the previous version, deliberately: the old
  // implementation reverted the user's edit and reported duplicate when a clone happened mid-typing.
  // But a copy can never displace the original; the user is editing the very passage in the source,
  // and that edit was always meant to land — "the thumbnails refreshed" swallowing what is being
  // typed is the real data loss.
  it("cloned by a script mid-typing: the edit lands as usual (a copy cannot displace the original)", async () => {
    let slide!: FakeElement;
    const h = mount({ build: (body) => { slide = marked("p", 7, ["原文"]); body.appendChild(slide); } });
    h.handshake();
    await flush();

    h.dblclick(slide);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    wrap.textContent = "改过的字";
    h.doc.body.appendChild(slide.cloneNode()); // the user is still typing when the page script clones this slide
    await flush();
    h.doc.dispatch("keydown", { key: "Enter", target: wrap });
    await flush();

    expect(last(h, "ah-editor:dirty").count).toBe(1);
    expect(slide.textContent).toBe("改过的字");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 7, i: 0, before: "原文", text: "改过的字" },
    ]);
  });

  // When a script removes the original from the document and only a copy remains, the copy must
  // **never** be promoted to authoritative: promoting it means accepting "any copy will do", which is
  // precisely the path that writes to the wrong place. The first-seen registry is append-only, so
  // this mark group becomes uneditable as a whole, and the reason is reported truthfully
  // (replaced ≠ copy: with copy the original in the body is still editable; with replaced nothing is).
  it("original swapped out by a script, only a copy left: the copy is not promoted, reason is replaced", async () => {
    let slide!: FakeElement;
    const h = mount({ build: (body) => { slide = marked("p", 7, ["原文"]); body.appendChild(slide); } });
    h.handshake();
    await flush();

    h.doc.body.appendChild(slide.cloneNode());
    await flush();
    h.doc.body.removeChild(slide); // the script removes the original
    await flush();

    const only = h.doc.querySelectorAll('[data-ah-node="7"]')[0];
    expect(only).not.toBe(slide);
    h.dblclick(only);
    await flush();
    expect(last(h, "ah-editor:unmappable").reason).toBe("replaced");
    expect(h.doc.querySelectorAll("[data-ah-wrap]")).toHaveLength(0);
  });

  it("original removed and re-inserted (same element object): still the first seen, still editable", async () => {
    let slide!: FakeElement;
    const h = mount({ build: (body) => { slide = marked("p", 7, ["原文"]); body.appendChild(slide); } });
    h.handshake();
    await flush();

    h.doc.body.removeChild(slide);
    await flush();
    h.doc.body.appendChild(slide);
    await flush();

    edit(h, slide, "改了");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 7, i: 0, before: "原文", text: "改了" },
    ]);
  });

  // In the browser the body is parsed after the bootstrap has run (this script is injected right
  // after <head> opens), so first-seen registration really goes through the MutationObserver path,
  // not the scan at boot. This test exercises that path specifically.
  it("marked elements that enter the document after boot (parser/script insertion): the one that arrives first is the first seen", async () => {
    const h = mount({ build: () => { /* body is empty at mount time, as in the browser */ } });
    h.handshake();
    await flush();

    const original = marked("p", 5, ["后来才解析出来的文字"]);
    h.doc.body.appendChild(original);
    await flush();
    h.doc.body.appendChild(original.cloneNode());
    await flush();

    const copy = h.doc.querySelectorAll('[data-ah-node="5"]')[1];
    h.dblclick(copy);
    await flush();
    expect(last(h, "ah-editor:unmappable").reason).toBe("copy");

    edit(h, original, "改了原件");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 5, i: 0, before: "后来才解析出来的文字", text: "改了原件" },
    ]);
  });

  // The rule is **insertion order into the document**, not the current document order — the two can
  // diverge: a script may insert the copy before the original, or move the original later (carousel
  // reflows do this), so the first in document order becomes the copy. Going by insertion order is
  // what keeps the original from suddenly losing its status just because it was moved. (This is also
  // the proof that the MutationObserver is really doing the work: the document-order-only fallback
  // path picks the wrong element here.)
  it("copy sorted before the original in document order: the original still wins (first seen = insertion order)", async () => {
    const h = mount({ build: () => { /* body empty; elements enter the document later */ } });
    h.handshake();
    await flush();

    const original = marked("p", 9, ["原文"]);
    h.doc.body.appendChild(original);
    await flush();                       // the observer records the original as first seen here

    const copy = original.cloneNode();
    h.doc.body.appendChild(copy);
    h.doc.body.removeChild(original);
    h.doc.body.appendChild(original);    // the original is moved behind the copy
    await flush();
    expect(h.doc.querySelectorAll('[data-ah-node="9"]')[0]).toBe(copy); // the copy comes first in document order

    h.dblclick(copy);
    await flush();
    expect(last(h, "ah-editor:unmappable").reason).toBe("copy");

    edit(h, original, "改了");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 9, i: 0, before: "原文", text: "改了" },
    ]);
  });

  // Without MutationObserver (very old browsers) degrade to "first in document order" rather than
  // making the whole page uneditable. Getting it wrong cannot corrupt anything: before writing back,
  // the parent page still compares before against that passage in the source.
  it("no MutationObserver: falls back to the first in document order, and the original stays editable", async () => {
    let slide!: FakeElement;
    const h = mount({
      noMutationObserver: true,
      build: (body) => { slide = marked("p", 7, ["原文"]); body.appendChild(slide); },
    });
    h.handshake();
    await flush();

    h.doc.body.appendChild(slide.cloneNode());
    await flush();

    const copy = h.doc.querySelectorAll('[data-ah-node="7"]')[1];
    h.dblclick(copy);
    await flush();
    expect(last(h, "ah-editor:unmappable").reason).toBe("copy");

    edit(h, slide, "改了");
    h.send({ type: "ah-editor:save" });
    await flush();
    expect(last(h, "ah-editor:patch").patches).toEqual([
      { el: 7, i: 0, before: "原文", text: "改了" },
    ]);
  });
});

// A3 · On entering the editor, say up front how much can be edited and why the rest cannot. In the
// user's words: "I'm already in and still can't edit — popping that notice is weird" — so this must
// not wait until a double-click.
describe("A3 · editable / uneditable statistics", () => {
  function statsOf(h: Harness): Record<string, unknown> {
    return last(h, "ah-editor:stats");
  }

  // The stats must exist the moment ready is sent — without waiting for load, let alone a user
  // double-click. Only tick() is awaited here (microtasks + port delivery), deliberately excluding
  // the follow-up report after load.
  it("reports the stats together with ready (without waiting for load or for a user double-click)", async () => {
    const h = mount({
      readyState: "loading",
      build: (body, doc) => {
        body.appendChild(marked("h1", 1, ["标题"]));
        body.appendChild(marked("p", 2, ["一段", "两段"]));
        const script = doc.createElement("script");
        script.appendChild(doc.createTextNode("var a=1;"));
        body.appendChild(script); // a script body must not be counted as "an uneditable passage"
      },
    });
    h.handshake();
    h.doc.dispatch("DOMContentLoaded", {});
    await tick();

    expect(types(h)).toContain("ah-editor:stats");
    expect(statsOf(h)).toMatchObject({ editable: 3, script: 0, structure: 0, copied: 0 });
  });

  it("text inside copies is not double-counted (not even the script-generated text inside a copy); script-generated text is its own bucket", async () => {
    let slide!: FakeElement;
    const h = mount({
      readyState: "loading",
      build: (body, doc) => {
        slide = doc.createElement("section");
        slide.appendChild(marked("h1", 2, ["第一页标题"]));
        const body3 = marked("p", 3, ["第一页正文"]);
        // The body already has two script-generated passages (unmarked); they get cloned into the
        // thumbnail along with everything else — the two inside the copy must not be counted again,
        // or the "uneditable" number doubles outright. The two sit in deliberately different places
        // to cover both decision paths:
        //   · inside a **marked element** → recognised because "this element itself is a copy";
        //   · under the cloned root (the <section> itself is unmarked) → recognised because "one level down, a child is a copy".
        const inner = doc.createElement("em");
        inner.appendChild(doc.createTextNode("脚本填的小字"));
        body3.appendChild(inner);
        slide.appendChild(body3);
        const badge = doc.createElement("div");
        badge.appendChild(doc.createTextNode("脚本填的角标"));
        slide.appendChild(badge);
        body.appendChild(slide);
      },
    });
    h.handshake();
    h.doc.dispatch("DOMContentLoaded", {});
    await flush();
    expect(statsOf(h)).toMatchObject({ editable: 2, script: 2 });

    // The artifact script builds the thumbnail on load: the two passages are cloned once, and two passages of its own are generated.
    const mini = h.doc.createElement("div");
    mini.appendChild(slide.cloneNode());
    const label = h.doc.createElement("div");
    label.appendChild(h.doc.createTextNode("1"));
    const label2 = h.doc.createElement("div");
    label2.appendChild(h.doc.createTextNode("第一页标题"));
    h.doc.body.appendChild(mini);
    h.doc.body.appendChild(label);
    h.doc.body.appendChild(label2);

    h.load();
    await flush();
    // editable does not shrink because of the clone; the 2 cloned marked passages and the two script
    // passages inside the copy are **not** counted again; only the 2 the thumbnail generated itself
    // (number + title) are added to script: 2 (existing) + 2 = 4.
    expect(statsOf(h)).toMatchObject({ editable: 2, script: 4, structure: 0, copied: 0 });
  });

  it("passages whose original was swapped out, leaving only a copy, go to copied; structural mismatches go to structure", async () => {
    let gone!: FakeElement;
    let bent!: FakeElement;
    const h = mount({
      readyState: "loading",
      build: (body) => {
        gone = marked("p", 7, ["会被换掉的一段"]);
        bent = marked("p", 8, ["结构会被动的一段"]);
        body.appendChild(gone);
        body.appendChild(bent);
      },
    });
    h.handshake();
    h.doc.dispatch("DOMContentLoaded", {});
    await flush();
    expect(statsOf(h)).toMatchObject({ editable: 2, structure: 0, copied: 0 });

    h.doc.body.appendChild(gone.cloneNode());
    h.doc.body.removeChild(gone);                        // the script removed the original; only the copy remains on the page
    bent.appendChild(h.doc.createTextNode("脚本追加的")); // data-ah-texts says 1, there are actually 2
    h.load();
    await flush();
    expect(statsOf(h)).toMatchObject({ editable: 0, script: 0, structure: 2, copied: 1 });
  });

  it("the whole page is script-rendered: editable is 0, so the parent page keeps the user from poking around inside", async () => {
    const h = mount({
      build: (body, doc) => {
        const div = doc.createElement("div");
        div.appendChild(doc.createTextNode("脚本渲染的"));
        body.appendChild(div);
      },
    });
    h.handshake();
    await flush();
    expect(statsOf(h)).toMatchObject({ editable: 0, script: 1 });
  });
});

// document.execCommand("insertText") has been flagged deprecated since Chrome 127, but it is still
// the only way to record an insertion in the **browser's native undo stack** — replacing it with
// manual Range edits kills Ctrl+Z inside contenteditable. So the implementation is "try execCommand
// first, fall back only when it clearly fails"; this group pins that order and the completeness of
// the fallback. (The fake DOM has no execCommand at all, so without a stub the fallback path is what runs.)
describe("paste: execCommand first, manual selection replacement only when it fails", () => {
  function withExecCommand(h: Harness, fn: (...args: unknown[]) => unknown): unknown[][] {
    const calls: unknown[][] = [];
    (h.doc as unknown as { execCommand: (...args: unknown[]) => unknown }).execCommand = (...args) => {
      calls.push(args);
      return fn(...args);
    };
    return calls;
  }

  /** Enter edit mode; paste() then pastes plain text (the clipboard also carries rich text — the implementation must take only text/plain). */
  function open(h: Harness, target: FakeElement): FakeElement {
    h.dblclick(target);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    if (!wrap) throw new Error("双击没有进入编辑态");
    return wrap;
  }
  function paste(h: Harness, wrap: FakeElement, text: string) {
    return h.doc.dispatch("paste", {
      target: wrap,
      clipboardData: { getData: (kind: string) => (kind === "text/plain" ? text : "<b>富文本</b>") },
    });
  }

  function mountOne(): { h: Harness; p: FakeElement } {
    let p!: FakeElement;
    const h = mount({ build: (body) => { p = marked("p", 1, ["原文"]); body.appendChild(p); } });
    return { h, p };
  }

  it("uses execCommand when it is available (the only route to the native undo stack) and does not touch the DOM by hand", async () => {
    const { h, p } = mountOne();
    h.handshake();
    await tick();
    const wrap = open(h, p);
    const calls = withExecCommand(h, () => true);

    const event = paste(h, wrap, "粘来的字");
    expect(calls).toEqual([["insertText", false, "粘来的字"]]);
    expect(event.defaultPrevented).toBe(true); // rich text must never land in the contenteditable on its own
    // execCommand said it handled it, so the fallback must not insert again (the fake execCommand does not touch the DOM, so the text is unchanged)
    expect(wrap.textContent).toBe("原文");
  });

  it("execCommand returns false / throws / does not exist → falls back to manual insertion; a paste must never be dropped silently", async () => {
    for (const stub of ["none", "false", "throw"] as const) {
      const { h, p } = mountOne();
      h.handshake();
      await tick();
      const wrap = open(h, p);
      if (stub === "false") withExecCommand(h, () => false);
      if (stub === "throw") withExecCommand(h, () => { throw new Error("removed"); });

      paste(h, wrap, "补上的\r\n那段");
      expect(wrap.textContent, stub).toBe("原文补上的 那段"); // newlines fold to spaces; only text/plain is taken
      expect(wrap.textContent, stub).not.toContain("<b>");
      await tick();
      // Editing the DOM by hand fires no input event, so the fallback must report the unsaved count itself, or the "unsaved" badge never lights up
      expect(last(h, "ah-editor:dirty").count, stub).toBe(1);
    }
  });

  it("text inserted by the fallback really makes it into the patch (all the way to save)", async () => {
    const { h, p } = mountOne();
    h.handshake();
    await tick();
    const wrap = open(h, p);

    paste(h, wrap, "粘贴内容");
    h.doc.dispatch("keydown", { key: "Enter", target: wrap });
    h.send({ type: "ah-editor:save" });
    await tick();
    expect(last(h, "ah-editor:patch").patches).toEqual([{ el: 1, i: 0, before: "原文", text: "原文粘贴内容" }]);
  });

  it("does nothing when the clipboard has no plain text (and must not report a fake change either)", async () => {
    const { h, p } = mountOne();
    h.handshake();
    await tick();
    const wrap = open(h, p);

    paste(h, wrap, "");
    await tick();
    expect(wrap.textContent).toBe("原文");
    expect(types(h)).not.toContain("ah-editor:dirty");
  });
});

describe("a failed lookup must be able to say why (upstream of A6)", () => {
  it("a script inserted a text node into the element → structure", async () => {
    let p!: FakeElement;
    const h = mount({ build: (body) => { p = marked("p", 2, ["文字"]); body.appendChild(p); } });
    h.handshake();
    await tick();

    // In the source this element has exactly 1 child text node; at runtime there is one more → the indices no longer line up.
    p.appendChild(h.doc.createTextNode(" 追加"));

    h.dblclick(p);
    await tick();
    expect(last(h, "ah-editor:unmappable").reason).toBe("structure");
  });

  it("the whole passage is script-generated and carries no mark at all → unmarked", async () => {
    const h = mount({
      build: (body, doc) => {
        const div = doc.createElement("div");
        div.appendChild(doc.createTextNode("脚本插进来的"));
        body.appendChild(div);
      },
    });
    h.handshake();
    await tick();

    h.dblclick(h.doc.querySelectorAll("[data-ah-node]")[0] ?? h.doc.body.childNodes[0] as FakeElement);
    await tick();
    expect(last(h, "ah-editor:unmappable").reason).toBe("unmarked");
  });
});

// —— While editing text, the artifact's own interactions must yield ——
//
// The user's report: "after I added some text the next slide came up over it and they overlapped".
// The culprit is the global shortcuts that slide-deck artifact attaches to document, without looking
// at the event target: Space/Enter → go(idx+1) next slide, Backspace → go(idx-1), typing o → the
// thumbnail overview. The user types in the editor while the artifact flips slides behind it, and
// two slides are visible at once mid-transition. preventDefault alone does not stop it (it only
// cancels the default action); propagation must be stopped.
describe("keys must not leak to the artifact while editing text", () => {
  /** Simulates the artifact's own global shortcuts: like the real one, it ignores e.target entirely. */
  function deckShortcuts(): { keys: string[]; install: (win: FakeWindow, doc: FakeDocument) => void } {
    const keys: string[] = [];
    return {
      keys,
      install: (_win, doc) => { doc.addEventListener("keydown", (e) => { keys.push(String(e.key)); }); },
    };
  }

  it("while editing, none of Space / Backspace / arrow keys reach the artifact's shortcut handler", () => {
    const deck = deckShortcuts();
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: deck.install,
    });
    const target = h.doc.querySelectorAll("[data-ah-node]")[0];
    h.dblclick(target);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    expect(wrap, "双击应进入编辑态").toBeTruthy();

    for (const key of [" ", "Backspace", "ArrowRight", "ArrowLeft", "PageDown", "o", "f"]) {
      h.doc.dispatch("keydown", { key, target: wrap });
    }
    expect(deck.keys, "产物的快捷键处理器一次都不该被调用").toEqual([]);
  });

  it("but normal typing still works — only propagation is blocked, not the default action", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); } });
    h.handshake();
    await tick();
    const target = h.doc.querySelectorAll("[data-ah-node]")[0];
    h.dblclick(target);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    // Typing itself is done by the browser's default action; simulate it here and confirm the dirty mark is reported as usual.
    h.doc.dispatch("keydown", { key: " ", target: wrap });
    wrap.textContent = "今 天 推进";
    h.doc.dispatch("input", { target: wrap });
    await tick(); // the dirty mark travels over the MessagePort and arrives asynchronously
    expect(Number(last(h, "ah-editor:dirty").count)).toBe(1);
    // Space must not be preventDefault-ed by us, or the user cannot type a space at all.
    const ev = h.doc.dispatch("keydown", { key: " ", target: wrap });
    expect(ev.defaultPrevented, "空格不该被 preventDefault").not.toBe(true);
  });

  it("does not intercept when not editing — otherwise the artifact's own slide navigation breaks and later slides become unreachable", () => {
    const deck = deckShortcuts();
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: deck.install,
    });
    h.doc.dispatch("keydown", { key: "ArrowRight", target: h.doc.body });
    expect(deck.keys, "未进编辑态时产物照常收到按键").toEqual(["ArrowRight"]);
  });

  it("restored after confirming with Enter: the artifact receives keys again", () => {
    const deck = deckShortcuts();
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: deck.install,
    });
    const target = h.doc.querySelectorAll("[data-ah-node]")[0];
    h.dblclick(target);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    h.doc.dispatch("keydown", { key: "Enter", target: wrap }); // our confirm key
    deck.keys.length = 0;
    h.doc.dispatch("keydown", { key: "ArrowRight", target: h.doc.body });
    expect(deck.keys, "退出编辑态后产物恢复响应").toEqual(["ArrowRight"]);
  });

  it("stray clicks on the artifact's buttons/hot zones while editing are not passed through either", () => {
    const clicks: string[] = [];
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: (_win, doc) => {
        for (const t of ["click", "mousedown", "pointerdown"]) {
          doc.addEventListener(t, () => { clicks.push(t); });
        }
      },
    });
    const target = h.doc.querySelectorAll("[data-ah-node]")[0];
    h.dblclick(target);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    for (const t of ["click", "mousedown", "pointerdown"]) h.doc.dispatch(t, { target: wrap });
    expect(clicks, "编辑态里产物的指针处理器不该被触发").toEqual([]);
  });
});

// —— In-place "preview": hand the page back to the artifact without losing unsaved edits ——
//
// The user's words: "preview should release the key lock on the current page so the edited artifact
// can play", later adding that it should not be called "play" — most artifacts have no notion of
// playing. So it is two states, edit/preview, switched by one message and **not** by reloading the
// edit frame: a reload would wipe the pending patches.
describe("preview mode: handing control back in place", () => {
  function deckShortcuts(): { keys: string[]; install: (win: FakeWindow, doc: FakeDocument) => void } {
    const keys: string[] = [];
    return { keys, install: (_win, doc) => { doc.addEventListener("keydown", (e) => { keys.push(String(e.key)); }); } };
  }

  it("switching to preview: double-click no longer enters edit mode, and keys go back to the artifact", async () => {
    const deck = deckShortcuts();
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: deck.install,
    });
    h.handshake(); await tick();
    h.port.postMessage({ type: "ah-editor:mode", nonce: "nonce_test", preview: true });
    await tick();
    expect(last(h, "ah-editor:mode").previewing, "frame 要回执模式已生效").toBe(true);

    h.dblclick(h.doc.querySelectorAll("[data-ah-node]")[0]);
    expect(h.doc.querySelectorAll("[data-ah-wrap]").length, "预览模式下双击不该进编辑态").toBe(0);
    h.doc.dispatch("keydown", { key: " ", target: h.doc.body });
    expect(deck.keys, "预览模式下按键归产物").toEqual([" "]);
  });

  it("switching to preview does not lose unsaved edits, and saving still works after switching back", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); } });
    h.handshake(); await tick();
    edit(h, h.doc.querySelectorAll("[data-ah-node]")[0], "今天推进");
    await tick();
    expect(Number(last(h, "ah-editor:dirty").count), "改完应有 1 处未保存").toBe(1);

    h.port.postMessage({ type: "ah-editor:mode", nonce: "nonce_test", preview: true });
    await tick();
    h.port.postMessage({ type: "ah-editor:mode", nonce: "nonce_test", preview: false });
    await tick();
    expect(last(h, "ah-editor:mode").previewing).toBe(false);

    // The patches are still there: they are handed over on save as usual.
    h.port.postMessage({ type: "ah-editor:save", nonce: "nonce_test" });
    await tick();
    const patches = last(h, "ah-editor:patch").patches as Array<Record<string, unknown>>;
    expect(patches, "来回切模式后补丁不该消失").toHaveLength(1);
    expect(patches[0].text).toBe("今天推进");
    expect(patches[0].before).toBe("今推进");
  });

  it("commits the passage being edited before switching to preview, leaving no half-open edit state", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); } });
    h.handshake(); await tick();
    h.dblclick(h.doc.querySelectorAll("[data-ah-node]")[0]);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    wrap.textContent = "改到一半";
    h.doc.dispatch("input", { target: wrap });
    h.port.postMessage({ type: "ah-editor:mode", nonce: "nonce_test", preview: true });
    await tick();
    expect(h.doc.querySelectorAll("[data-ah-wrap]").length, "包裹层应已拆除").toBe(0);
    h.port.postMessage({ type: "ah-editor:save", nonce: "nonce_test" });
    await tick();
    const patches = last(h, "ah-editor:patch").patches as Array<Record<string, unknown>>;
    expect(patches[0].text, "改到一半的内容也要落定，不能丢").toBe("改到一半");
  });

  // At the moment of deployment there may be a window where the parent page is still old (sends
  // play) while the injected script is already new (reads preview); that must not break. Both field
  // names are accepted, and the acknowledgement carries both too.
  it("accepts both old and new field names: an old parent page sending play still switches", async () => {
    const h = mount({ build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); } });
    h.handshake(); await tick();
    h.port.postMessage({ type: "ah-editor:mode", nonce: NONCE, play: true }); // old field
    await tick();
    const echo = last(h, "ah-editor:mode");
    expect(echo.previewing).toBe(true);
    expect(echo.playing, "回执同时带旧字段，旧父页面才读得懂").toBe(true);
    h.dblclick(h.doc.querySelectorAll("[data-ah-node]")[0]);
    expect(h.doc.querySelectorAll("[data-ah-wrap]").length, "旧字段也要真的生效").toBe(0);
  });

  it("takes the keys over again after switching back to edit", async () => {
    const deck = deckShortcuts();
    const h = mount({
      build: (body) => { body.appendChild(marked("h1", 1, ["今推进"])); },
      extraScript: deck.install,
    });
    h.handshake(); await tick();
    h.port.postMessage({ type: "ah-editor:mode", nonce: "nonce_test", preview: false });
    await tick();
    h.dblclick(h.doc.querySelectorAll("[data-ah-node]")[0]);
    const wrap = h.doc.querySelectorAll("[data-ah-wrap]")[0];
    expect(wrap, "切回编辑后双击应能进编辑态").toBeTruthy();
    deck.keys.length = 0;
    h.doc.dispatch("keydown", { key: " ", target: wrap });
    expect(deck.keys, "改字时按键仍不给产物").toEqual([]);
  });
});
