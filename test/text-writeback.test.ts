// Text write-back is the foundation of "pure visual editing": on save, only text ranges in the
// **original source string** are replaced; HTML is never regenerated from the live DOM. This suite
// guards that invariant and its safety nets:
//   · tags / attributes / whitespace / scripts / comments must not change by a single byte;
//   · user input must be escaped — typing <script> can only become literal text;
//   · when a patch cannot be located (a script rewrote the structure, an index is out of range,
//     before does not match) it must be skipped and reported truthfully — never dropped silently,
//     and never written somewhere else.
import { describe, expect, it } from "vitest";
import {
  applyTextPatches, escapeText, headInsertionIndex, markEditableText, MAX_PATCH_TEXT_LENGTH,
  NODE_ATTR, scanEditableText, scriptPrecedesHead, TEXTS_ATTR,
} from "@/lib/text-writeback";

/** Builds one patch for (el, i); before must be the decoded form of that passage in the source. */
const patch = (el: number, i: number, before: string, text: string) => ({ el, i, before, text });

/** Flattens a scan into [element index, that element's text ranges verbatim], sorted by index, for direct toEqual. */
const dump = (html: string): Array<[number, string[]]> =>
  [...scanEditableText(html).entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([el, s]) => [el, s.texts.map((t) => html.slice(t.start, t.end))]);

describe("scanEditableText — indices are derived from parsing the source", () => {
  it("numbers every element with text and records the range of each of its direct child text nodes", () => {
    const html = `<html><body><h1>标题</h1><p>前 <b>粗</b> 后</p></body></html>`;
    const slots = scanEditableText(html);
    const texts = [...slots.values()].map((s) => s.texts.map((t) => html.slice(t.start, t.end)));
    // h1 has one text node; b one; p two ("前 " and " 后", separated by <b>)
    expect(texts).toContainEqual(["标题"]);
    expect(texts).toContainEqual(["粗"]);
    expect(texts).toContainEqual(["前 ", " 后"]);
  });

  // This test guards against `if (a < b)` inside a script being read as a tag and shifting every later element's index.
  it("skips script / style content wholesale; the < > inside cannot derail the scanner", () => {
    const html = `<body><script>if(a<b){var s="</p>"}</script><style>i{content:"<"}</style><p>真文字</p></body>`;
    const slots = scanEditableText(html);
    const texts = [...slots.values()].map((s) => s.texts.map((t) => html.slice(t.start, t.end)));
    expect(texts).toContainEqual(["真文字"]);
    expect(texts.flat().join("")).not.toContain("var s");
  });

  it("text inside head / svg / template subtrees does not take part in visual editing", () => {
    const html = `<html><head><title>T</title></head><body><svg><text>S</text></svg><template><p>模板</p></template><p>正文</p></body></html>`;
    const rendered = [...scanEditableText(html).values()].map((s) => s.texts.map((t) => html.slice(t.start, t.end)).join(""));
    expect(rendered).toEqual(["正文"]);
  });

  it("a bare `<` in ordinary text does not split the text node (the browser parses only one too)", () => {
    const html = `<p>a < b 恒成立</p>`;
    const [slot] = [...scanEditableText(html).values()];
    expect(html.slice(slot.texts[0].start, slot.texts[0].end)).toBe("a < b 恒成立");
  });
});

// `</li> </p> </td> </tr> </dt> </dd> </thead>` may all be omitted in HTML5; such source is perfectly
// valid. Slots used to be finalised only on an **explicit** end tag, so these pages yielded no
// editable element at all (size === 0) and the user saw "double-click does nothing". Each case below
// pins both "it is found" and "the text ranges match the parse tree".
//
// The expected values here are not guesses: after the change, the output of markEditableText was
// parsed with parse5 (the spec-grade parser jsdom uses) into a real DOM and compared element by
// element on "number / content of direct child text nodes" — 24 hand-written malformed samples plus
// 3000 random malformed documents all agreed (details in the PR description).
describe("scanEditableText — valid HTML5 with omitted end tags", () => {
  it("<li> without </li>: each li becomes its own editable element", () => {
    expect(dump("<ul>\n<li>一\n<li>二\n</ul>")).toEqual([[1, ["一\n"]], [2, ["二\n"]]]);
  });

  it("<p> without </p>: three paragraphs each keep their own p instead of collapsing into one", () => {
    expect(dump("<div><p>one<p>two<p>three</div>")).toEqual([[1, ["one"]], [2, ["two"]], [3, ["three"]]]);
  });

  it("<td>/<tr> without end tags: cells are editable one by one", () => {
    expect(dump("<table><tr><td>甲<td>乙</table>")).toEqual([[2, ["甲"]], [3, ["乙"]]]);
  });

  it("<dt>/<dd> without end tags", () => {
    expect(dump("<dl><dt>词<dd>解释</dl>")).toEqual([[1, ["词"]], [2, ["解释"]]]);
  });

  it("<p> displaced by a <div>: the text counts only the p's own segment (which is how the browser splits it)", () => {
    // In `<p>a<div>b</div>c</p>` the <div> implicitly closes the <p>; "c" is no longer inside the p
    expect(dump("<body><p>a<div>b</div>c</p><p>d</p></body>")).toEqual([
      [0, ["c"]], [1, ["a"]], [2, ["b"]], [3, ["d"]],
    ]);
  });

  it("elements still unclosed at end of file are picked up all the same", () => {
    expect(dump("<div><p>没写结束标签")).toEqual([[1, ["没写结束标签"]]]);
  });

  it("an outer end tag closing several unclosed levels at once: every level gets its slot", () => {
    expect(dump("<ul><li>外<ul><li>内</ul></ul>")).toEqual([[1, ["外"]], [3, ["内"]]]);
  });

  it("stray text in the table skeleton is not marked (the browser foster-parents it before the table, so source positions would not match)", () => {
    expect(dump("<table>散文<tr><td>格子</table>")).toEqual([[2, ["格子"]]]);
  });

  it("editable implies writable: editing an li with an omitted end tag changes only that passage", () => {
    const html = "<ul>\n<li>一\n<li>二\n</ul>";
    const out = applyTextPatches(html, [patch(2, 0, "二\n", "贰\n")]);
    expect(out.skipped).toHaveLength(0);
    expect(out.applied).toHaveLength(1);
    expect(out.html).toBe("<ul>\n<li>一\n<li>贰\n</ul>");
  });
});

// Both of these used to make the scanner attribute a child's text to the parent: the parent's count
// self-check then failed, so parent and child were **both** uneditable — a textbook case of valid
// HTML being judged uneditable.
describe("scanEditableText — self-closing slash and unquoted attribute values", () => {
  it("`/>` in the HTML namespace is not self-closing: <a href=/> is pushed on the stack as usual", () => {
    expect(dump("<body><a href=/>Home</a><p>x</p></body>")).toEqual([[1, ["Home"]], [2, ["x"]]]);
  });

  it("`<div/>` is a start tag, not self-closing", () => {
    expect(dump("<body><div/>Home<p>x</p></body>")).toEqual([[1, ["Home"]], [2, ["x"]]]);
  });

  it("`<rect/>` inside SVG really is self-closing, and the body text after it is unaffected", () => {
    // rect self-closes → not pushed → takes no index: body=0 svg=1 p=2
    expect(dump("<body><svg><rect x='1'/></svg><p>后面的字</p></body>")).toEqual([[2, ["后面的字"]]]);
  });

  it("quotes inside an unquoted attribute value are ordinary characters and do not swallow the markup that follows", () => {
    expect(dump('<body><div data-x=a"b>c</div><p>x</p></body>')).toEqual([[1, ["c"]], [2, ["x"]]]);
  });

  it("a quoted attribute value in an end tag does not eat the `>` either", () => {
    expect(dump('<body><div>文字</div foo=">"><p>x</p></body>')).toEqual([[1, ["文字"]], [2, ["x"]]]);
  });
});

describe("markEditableText — injecting the locator marks", () => {
  it("adds only two data attributes to the start tag; everything else is untouched", () => {
    const out = markEditableText(`<div class="x"><p>你好</p></div>`);
    expect(out).toContain(`<p ${NODE_ATTR}="1" ${TEXTS_ATTR}="1">你好</p>`);
    expect(out).toContain(`class="x"`); // existing attributes were not touched
  });

  // The injected attributes use double quotes; once one lands inside a JS string it splits it in
  // two: that script in the edit frame throws a SyntaxError and the user is editing text on an
  // already broken page. So the end tag of raw text must be recognised by the tokenizer's rules.
  it("a pseudo end tag `</scriptx>` inside a script body does not end it; the script is untouched byte for byte", () => {
    const script = `var s="</scriptx> <b>bold</b>";`;
    const html = `<body><script>${script}</script><p>正文</p></body>`;
    expect(dump(html)).toEqual([[1, ["正文"]]]); // the <b> inside the script was not taken for an element
    const out = markEditableText(html);
    expect(out).toContain(`<script>${script}</script>`); // the injected attribute did not split the JS string
    expect(out.match(new RegExp(NODE_ATTR, "g")) ?? []).toHaveLength(1);
  });

  it("does not mark anything inside head / script / style", () => {
    const out = markEditableText(`<html><head><title>T</title></head><body><script>var a=1</script><p>正文</p></body></html>`);
    expect(out).toContain(`<title>T</title>`);
    expect(out).toContain(`<script>var a=1</script>`);
    expect(out.match(new RegExp(NODE_ATTR, "g")) ?? []).toHaveLength(1);
  });
});

describe("applyTextPatches — changes text only", () => {
  it("replaces one passage; structure, attributes, indentation and comments all stay intact", () => {
    const html = `<!doctype html>\n<html>\n  <head><style>p{color:red}</style></head>\n  <body>\n    <!-- 保留我 -->\n    <p class="hi" data-x='1'>Hello</p>\n  </body>\n</html>\n`;
    const el = [...scanEditableText(html).keys()].pop()!;
    const out = applyTextPatches(html, [patch(el, 0, "Hello", "Hi there")]);
    expect(out.skipped).toHaveLength(0);
    expect(out.html).toBe(html.replace("Hello", "Hi there"));
    expect(out.html).toContain("<!-- 保留我 -->");
    expect(out.html).toContain(`<p class="hi" data-x='1'>`);
  });

  it("multiple text nodes of the same element are edited independently; the inline tag between them is unaffected", () => {
    const html = `<p>前 <b>粗</b> 后</p>`;
    const slots = scanEditableText(html);
    const p = [...slots.entries()].find(([, s]) => s.texts.length === 2)![0];
    const b = [...slots.entries()].find(([, s]) => s.texts.length === 1)![0];
    const out = applyTextPatches(html, [patch(p, 0, "前 ", "左 "), patch(p, 1, " 后", " 右"), patch(b, 0, "粗", "重")]);
    expect(out.applied).toHaveLength(3);
    expect(out.html).toBe(`<p>左 <b>重</b> 右</p>`);
  });

  it("Chinese replaced with Chinese: length changes do not shift the offsets that follow", () => {
    const html = `<ul><li>第一项</li><li>第二项</li><li>第三项</li></ul>`;
    const keys = [...scanEditableText(html).keys()];
    const out = applyTextPatches(html, [
      patch(keys[0], 0, "第一项", "改得很长很长的第一项"),
      patch(keys[2], 0, "第三项", "三"),
    ]);
    expect(out.html).toBe(`<ul><li>改得很长很长的第一项</li><li>第二项</li><li>三</li></ul>`);
  });

  // A user can break the document structure (or even inject a script) just by typing a tag, so write-back must escape.
  it("user input is escaped: <script> can only become literal text", () => {
    const html = `<p>安全</p>`;
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 0, "安全", `<script>alert(1)</script> & <b>`)]);
    expect(out.html).toBe(`<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;</p>`);
    expect(scanEditableText(out.html).size).toBe(1); // the structure was not blown open; still one element
  });

  it("entities in the source decode to match the before captured at runtime", () => {
    const html = `<p>Tom &amp; Jerry&nbsp;·&#8212;</p>`;
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 0, "Tom & Jerry ·—", "Tom and Jerry")]);
    expect(out.skipped).toHaveLength(0);
    expect(out.html).toBe(`<p>Tom and Jerry</p>`);
  });

  // The old implementation (serialising the live DOM) had to refuse exactly this kind of page; text write-back no longer has that precondition.
  it("a page with <script> is still text-editable, and the script content is untouched byte for byte", () => {
    const script = `document.getElementById("n").textContent = 1 < 2 ? "1" : "2";`;
    const html = `<body><h1>计数</h1><div id="n">0</div><script>\n${script}\n</script></body>`;
    const slots = scanEditableText(html);
    const el = [...slots.entries()].find(([, s]) => html.slice(s.texts[0].start, s.texts[0].end) === "计数")![0];
    const out = applyTextPatches(html, [patch(el, 0, "计数", "计数器")]);
    expect(out.html).toContain(`<h1>计数器</h1>`);
    expect(out.html).toContain(script);
  });
});

describe("applyTextPatches — a failed lookup must be skipped and reported", () => {
  const html = `<p>原文</p><div>另一段</div>`;

  it("before does not match (a script changed the copy) → skipped, the source is unchanged", () => {
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 0, "脚本换过的内容", "新文字")]);
    expect(out.applied).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(html);
  });

  it("element index does not exist (a node the script created) → skipped", () => {
    const out = applyTextPatches(html, [patch(999, 0, "原文", "新文字")]);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(html);
  });

  it("child text node index out of range → skipped", () => {
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 7, "原文", "新文字")]);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(html);
  });

  it("when some patches can be written and some cannot, the writable ones are written and the rest are listed truthfully", () => {
    const keys = [...scanEditableText(html).keys()];
    const out = applyTextPatches(html, [patch(keys[0], 0, "原文", "改了"), patch(keys[1], 0, "对不上的旧文案", "白改")]);
    expect(out.applied).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(`<p>改了</p><div>另一段</div>`);
  });

  // The fallback comment used to say "a `<` in text can only mean the scanner lost sync", but when
  // `<` is not followed by a letter, both the browser and readToken treat it as ordinary text (the
  // "bare `<` does not split the text node" test above pins that behaviour). Such text could be
  // double-clicked in the UI yet the whole patch was dropped on save — the check had to be narrowed
  // to "contains a `<` that could open a tag".
  it("a bare `<` in text (a < b) is still written back; the whole patch is no longer thrown away", () => {
    const src = `<p>a < b 恒成立</p>`;
    const el = [...scanEditableText(src).keys()][0];
    const out = applyTextPatches(src, [patch(el, 0, "a < b 恒成立", "a < b 总成立")]);
    expect(out.skipped).toHaveLength(0);
    expect(out.applied).toHaveLength(1);
    expect(out.html).toBe(`<p>a &lt; b 总成立</p>`); // what needs escaping is still escaped on write-back
  });

  it("malformed patches (they come from the iframe and are not trusted input) are dropped outright", () => {
    const out = applyTextPatches(html, [null, { el: "0", i: 0 }, { el: 0, i: 0, before: 1, text: 2 }, "x"]);
    expect(out.applied).toHaveLength(0);
    expect(out.html).toBe(html);
  });

  it("when the same position is submitted twice only the first patch counts", () => {
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 0, "原文", "A"), patch(el, 0, "原文", "B")]);
    expect(out.applied).toHaveLength(1);
    expect(out.html).toBe(`<p>A</p><div>另一段</div>`);
  });
});

// The number and length of patches are dictated by the document inside the iframe (an artifact
// script has no route other than the port, but a user's own page containing a huge text node is
// entirely legitimate). Without a cap, a few oversized patches are enough to burn a lot of CPU in
// decodeEntities / sameText / escapeText during one save.
describe("applyTextPatches — patch length cap", () => {
  const html = `<p>原文</p>`;
  const el = () => [...scanEditableText(html).keys()][0];

  it("text over the cap → not written back, but it lands in skipped (the user sees 'one passage was not written back')", () => {
    const out = applyTextPatches(html, [patch(el(), 0, "原文", "x".repeat(MAX_PATCH_TEXT_LENGTH + 1))]);
    expect(out.applied).toHaveLength(0);
    expect(out.skipped).toHaveLength(1); // key point: not a silent continue
    expect(out.html).toBe(html);
  });

  it("before over the cap is refused too (the comparison itself is where the cost lies)", () => {
    const out = applyTextPatches(html, [patch(el(), 0, "原".repeat(MAX_PATCH_TEXT_LENGTH + 1), "短")]);
    expect(out.applied).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(html);
  });

  it("exactly at the cap is still written back: the cap catches abnormal sizes, not long text", () => {
    const long = "x".repeat(MAX_PATCH_TEXT_LENGTH);
    const out = applyTextPatches(html, [patch(el(), 0, "原文", long)]);
    expect(out.skipped).toHaveLength(0);
    expect(out.applied).toHaveLength(1);
    expect(out.html).toBe(`<p>${long}</p>`);
  });

  it("the oversized patch is refused while the normal ones in the same batch are written", () => {
    const doc = `<p>甲</p><div>乙</div>`;
    const [a, b] = [...scanEditableText(doc).keys()];
    const out = applyTextPatches(doc, [
      patch(a, 0, "甲", "x".repeat(MAX_PATCH_TEXT_LENGTH + 1)),
      patch(b, 0, "乙", "改乙"),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(`<p>甲</p><div>改乙</div>`);
  });
});

// The whole security of visual editing rests on "the injected bootstrap is the first script to run".
// HTML5 allows <script> before <html>/<head>; such a script runs before the bootstrap → registers a
// message listener first → grabs the port handed over in the handshake and stopImmediatePropagation
// → then impersonates the bootstrap and forges patches into the user's source. So this precondition
// must be detectable, without false positives on normal markup.
describe("scriptPrecedesHead / headInsertionIndex — the precondition for the injection point", () => {
  it("<script> before <head> → detected", () => {
    expect(scriptPrecedesHead(`<script>MessageEvent.prototype.__defineGetter__('ports',function(){return []})</script>\n<head></head>`)).toBe(true);
    expect(scriptPrecedesHead(`<!doctype html>\n<script src="a.js"></script><html><head></head><body>x</body></html>`)).toBe(true);
  });

  it("doctype / comments / whitespace / the <html>/<head> tags themselves coming first do not count", () => {
    expect(scriptPrecedesHead(`<!doctype html>\n<html>\n<head>\n<script>var a=1</script>\n</head><body>x</body></html>`)).toBe(false);
    expect(scriptPrecedesHead(`<!-- <script>骗人的</script> -->\n<head></head><body><script>var a=1</script></body>`)).toBe(false);
    expect(scriptPrecedesHead(`<!DOCTYPE HTML><!--x--><HTML><HEAD><SCRIPT>var a=1</SCRIPT></HEAD></HTML>`)).toBe(false);
  });

  it("document without any <head>: the injection is prepended, the bootstrap is still first → not detected", () => {
    expect(scriptPrecedesHead(`<script>var a=1</script><body><p>x</p></body>`)).toBe(false);
    expect(scriptPrecedesHead(`<p>纯片段</p>`)).toBe(false);
  });

  it("the injection point is the **real** <head>: fake heads inside comments, script strings or attribute values cannot fool it", () => {
    // A regex implementation would insert wrongly in all three places: into the comment, into the JS string, and after `a>` (truncating the attribute value).
    const inComment = `<!-- <head> --><head><title>t</title></head>`;
    expect(headInsertionIndex(inComment)).toBe(inComment.lastIndexOf("<head>") + "<head>".length);

    const inScript = `<script>var s="<head>";</script><head></head>`;
    expect(headInsertionIndex(inScript)).toBe(inScript.indexOf("<head></head>") + "<head>".length);

    // A `>` inside an attribute value does not end the tag: the insertion point is after the `>` before <title>, not the one inside the quotes.
    const quoted = `<head data-x="a>b"><title>t</title></head>`;
    expect(headInsertionIndex(quoted)).toBe(quoted.indexOf("><title>") + 1);

    expect(headInsertionIndex(`<body>无 head</body>`)).toBe(-1);
  });
});

// The front end tells the user "N passages were not written back" purely from skipped.length. So
// applied must mean "really written": any patch that is neither written nor in skipped is a silent
// loss the user never notices.
describe("applyTextPatches — applied and skipped must partition every patch exactly", () => {
  const DOCS = [
    `<p>一</p><div>二</div><span>三</span>`,
    `<ul>\n<li>甲\n<li>乙\n<li>丙\n</ul>`,
    `<div><p>a<p>b<p>c</div><h1>标题</h1>`,
    `<table><tr><td>x<td>y</table><p>尾</p>`,
  ];

  it("every well-formed patch is either written into the source or listed in skipped; there is no third destination", () => {
    for (const doc of DOCS) {
      const slots = scanEditableText(doc);
      const submitted = [...slots.entries()].flatMap(([el, s]) =>
        s.texts.map((t, i) => patch(el, i, doc.slice(t.start, t.end), `改${el}_${i}`)));
      const junk = [patch(9999, 0, "不存在", "x"), patch([...slots.keys()][0], 42, "越界", "x")];
      const out = applyTextPatches(doc, [...submitted, ...junk]);

      expect(out.applied.length + out.skipped.length).toBe(submitted.length + junk.length);
      expect(out.skipped).toHaveLength(junk.length);
      // "Written" must survive a recheck: rescan the output, and each applied patch's new text must be in place
      const after = scanEditableText(out.html);
      for (const p of out.applied) {
        const range = after.get(p.el)?.texts[p.i];
        expect(range, `${doc} → el=${p.el} i=${p.i}`).toBeTruthy();
        expect(out.html.slice(range!.start, range!.end)).toBe(p.text);
      }
    }
  });

  it("whitespace text nodes count too: a whole page of patches is partitioned without a single one going missing", () => {
    const doc = `<div>\n  <p>甲</p>\n  <p>乙</p>\n</div>`;
    const slots = scanEditableText(doc);
    const submitted = [...slots.entries()].flatMap(([el, s]) =>
      s.texts.map((t, i) => patch(el, i, doc.slice(t.start, t.end), doc.slice(t.start, t.end))));
    const out = applyTextPatches(doc, submitted);
    expect(out.applied.length + out.skipped.length).toBe(submitted.length);
    expect(out.html).toBe(doc); // all "no real change", so the source is untouched byte for byte
  });
});

// Browsers know 2231 named entities, plus legacy forms like `&copy` without a semicolon; the
// hand-written table has around 50. before is compared against the decoded result, so an entity
// missing from the table never matches — the user cannot save a single character of a
// `Caf&eacute;` passage. The user's save really runs in the browser (applyTextPatches' only call
// site is visual-editor.tsx), so when a DOM exists the browser decodes. Node has no DOM, so a fake
// document that knows only é/è stands in — and what it knows are precisely entities **absent** from
// the built-in table, so passing proves the DOM path was really taken.
describe("decodeEntities — delegates to the browser when a DOM is available", () => {
  interface FakeBox { innerHTML: string; value: string }
  const FAKE: Record<string, string> = { "&eacute;": "é", "&egrave;": "è", "&aelig;": "æ" };
  function withFakeDom<T>(run: () => T): T {
    const g = globalThis as unknown as { document?: { createElement(tag: string): FakeBox } };
    const had = "document" in g;
    const prev = g.document;
    g.document = {
      createElement: () => {
        let v = "";
        return {
          get innerHTML() { return v; },
          set innerHTML(raw: string) { v = raw.replace(/&[a-z]+;/g, (m) => FAKE[m] ?? m); },
          get value() { return v; },
          set value(x: string) { v = x; },
        };
      },
    };
    try { return run(); } finally { if (had) g.document = prev; else delete g.document; }
  }

  it("an entity missing from the built-in table (&eacute;) still matches the runtime before, and the edit is saved", () => {
    const html = `<p>Caf&eacute; ouvert</p>`;
    const el = [...scanEditableText(html).keys()][0];
    const out = withFakeDom(() => applyTextPatches(html, [patch(el, 0, "Café ouvert", "Café fermé")]));
    expect(out.skipped).toHaveLength(0);
    expect(out.applied).toHaveLength(1);
    expect(out.html).toBe(`<p>Café fermé</p>`);
  });

  it("the same text without a DOM (server / unit tests) uses the fallback table and, when unrecognised, is skipped as before — never mis-written", () => {
    const html = `<p>Caf&eacute; ouvert</p>`;
    const el = [...scanEditableText(html).keys()][0];
    const out = applyTextPatches(html, [patch(el, 0, "Café ouvert", "Café fermé")]);
    expect(out.applied).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.html).toBe(html);
  });

  it("the fallback table still knows the common entities (the DOM path is merely more complete, not a change of semantics)", () => {
    const html = `<p>Tom &amp; Jerry&nbsp;·&#8212;</p>`;
    const el = [...scanEditableText(html).keys()][0];
    expect(applyTextPatches(html, [patch(el, 0, "Tom & Jerry ·—", "Tom and Jerry")]).skipped).toHaveLength(0);
  });
});

describe("escapeText", () => {
  it("escapes & < >, normalises newlines and drops control characters", () => {
    expect(escapeText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeText("a\r\nb")).toBe("a\nb");
    expect(escapeText("a\u0007b")).toBe("ab");
  });
});
