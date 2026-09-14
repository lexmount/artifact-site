// "Text writeback" for visual editing: write the text the user changed in the preview back into the
// **original source string**.
//
// Why we no longer serialize the whole DOM (PR#14's old approach): once a page ships its own
// scripts, the post-run DOM no longer equals the source -- serializing would freeze script output
// into the file, and reorder attributes, eat comments and indentation along the way. That is why
// pages with <script> used to be turned away, and folder sites never even got a door. With text
// writeback we only replace the content ranges of a few "text nodes" in the source string: tags,
// attributes, whitespace, scripts and comments are all preserved verbatim, so scripted pages and
// folder sites can enter pure visual editing.
//
// Locating relies on two indices; the injecting side (server-side /edit-frame) and the writeback
// side (browser, on save) each run the same scan:
//   el -- the element's index in the full element table, numbered in start-tag order;
//   i  -- the position of the element's **direct child text node** among them (whitespace-only nodes
//         included, to line up with DOM childNodes).
// el numbers every pushed element (not just the editable ones), so when some text is emptied and an
// element stops being "editable", the other elements' indices do not all shift.
//
// Before writeback the patch's own before must also match the text in the source; on mismatch the
// whole patch is skipped -- when a script has rewritten structure or copy, this is the only reliable
// "location failed" signal. Better to change one place fewer and tell the user honestly than write to
// the wrong place.
//
// The scanner must therefore follow HTML5 parsing rules rather than "close only on a matching end
// tag": `</li> </p> </td> </tr> </dt> </dd> </thead>` may all be omitted in HTML5, and such source
// is perfectly valid. Without the implied-close step, those pages yield no editable elements at all
// (double-click does nothing), or a child's text is credited to the parent and both fail the
// runtime's count self-check.

/** Marks injected into the start tag: element index + the element's direct child text node count in the source (the runtime uses it to self-check). */
export const NODE_ATTR = "data-ah-node";
export const TEXTS_ATTR = "data-ah-texts";

export interface TextRange {
  start: number;
  end: number;
}

export interface ElementSlot {
  el: number;
  /** Offset right after `<tag` in the start tag -- the mark attributes are inserted here. */
  attrAt: number;
  /** Source ranges of the direct child text nodes, in the same order as the text nodes in DOM childNodes. */
  texts: TextRange[];
}

/** One text change: turn the i-th child text node of element el from before into text. */
export interface TextPatch {
  el: number;
  i: number;
  before: string;
  text: string;
}

export interface WritebackResult {
  html: string;
  applied: TextPatch[];
  /** Changes that could not be located (or failed validation) -- must be reported to the user, never silently dropped. */
  skipped: TextPatch[];
}

// These tags have no end tag and are not pushed onto the stack.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// The content of these tags is not markup: a `<` inside does not open a tag. It must be skipped
// wholesale, or an `a < b` inside a script derails the scanner -- this is precisely the
// precondition for "supporting scripted pages".
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

// Text inside these subtrees does not take part in visual editing: either the user cannot see it
// (head), or the DOM structure is not one-to-one with the source (svg/math have different parsing
// rules; template content gets cloned by scripts into multiple copies).
const OPAQUE_TAGS = new Set([
  "head", "svg", "math", "canvas", "iframe", "object", "template", "noscript", "select",
]);

// Real text directly inside the table skeleton gets moved **before** the <table> by the browser's
// "foster parenting", so its source position does not match the parse tree; direct text of these
// elements is therefore never marked (the runtime's count self-check would reject it anyway).
const TABLE_TEXT_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

// In foreign content (SVG / MathML) a self-closing form like `<rect/>` really is self-closing; in
// the HTML namespace the parser **ignores** that slash -- `<div/>` is a start tag, and the slash in
// `<a href=/>` is even part of the attribute value.
const FOREIGN_TAGS = new Set(["svg", "math"]);

// In HTML5 a range of end tags may be omitted (`</li> </p> </td> </tr> </dt> </dd> </thead>` ...).
// On the start tags below, the browser first implicitly closes the displaced elements on the
// stack; the scanner does the same so the parse tree matches. The table reads "on start tag key,
// keep popping while the stack top belongs to value" -- stop as soon as it does not, so genuine
// nesting like `<li><ul><li>` is not popped by mistake.
const CLOSES_P: readonly string[] = [
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "listing", "main", "menu", "nav", "ol", "p", "plaintext", "pre",
  "search", "section", "summary", "table", "ul", "xmp",
];
const IMPLIED_END: Record<string, ReadonlySet<string>> = {
  li: new Set(["li", "p"]),
  dt: new Set(["dt", "dd", "p"]),
  dd: new Set(["dt", "dd", "p"]),
  td: new Set(["td", "th", "p"]),
  th: new Set(["td", "th", "p"]),
  tr: new Set(["tr", "td", "th", "p"]),
  thead: new Set(["thead", "tbody", "tfoot", "tr", "td", "th", "p"]),
  tbody: new Set(["thead", "tbody", "tfoot", "tr", "td", "th", "p"]),
  tfoot: new Set(["thead", "tbody", "tfoot", "tr", "td", "th", "p"]),
  option: new Set(["option"]),
  optgroup: new Set(["option", "optgroup"]),
  rt: new Set(["rt", "rp"]),
  rp: new Set(["rt", "rp"]),
};
for (const tag of CLOSES_P) {
  IMPLIED_END[tag] = IMPLIED_END[tag] ?? new Set(["p"]);
}

interface Frame {
  tag: string;
  el: number;
  attrAt: number;
  texts: TextRange[];
  nonWs: boolean;
  opaque: boolean;
  foreign: boolean;
}

type Token =
  | { kind: "skip"; next: number }
  | { kind: "open"; tag: string; attrAt: number; next: number; selfClosing: boolean }
  | { kind: "close"; tag: string; next: number };

function isNameStart(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function isNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === ":" || ch === "_";
}

/** Read a tag name starting at lower[from]; return "" when none can be read (this `<` is just plain text). */
function tagNameAt(lower: string, from: number): string {
  if (!isNameStart(lower.charAt(from))) return "";
  let j = from;
  while (j < lower.length && isNameChar(lower.charAt(j))) j++;
  return lower.slice(from, j);
}

/**
 * Find the tag's `>`, skipping quoted attribute values (which may contain `>`).
 *
 * A quote only acts as a "quote" right after `=` -- that is the HTML tokenizer's rule: quotes in an
 * attribute name or in an unquoted attribute value are ordinary characters. A naive "enter quoted
 * state on any quote" would, on `<div data-x=a"b>`, swallow everything up to the next quote and
 * derail all the markup after it.
 * Likewise `/` is a self-closing marker only outside an attribute value: the slash in `<a href=/>`
 * belongs to that unquoted attribute value.
 */
function findTagEnd(html: string, from: number): { end: number; selfClosing: boolean } {
  let quote = "";
  // tag = attribute name/tag body; beforeValue = just saw `=`; unquoted = reading an unquoted attribute value
  let mode: "tag" | "beforeValue" | "unquoted" = "tag";
  for (let j = from; j < html.length; j++) {
    const ch = html.charAt(j);
    if (quote) {
      if (ch === quote) { quote = ""; mode = "tag"; }
      continue;
    }
    if (ch === ">") {
      return { end: j, selfClosing: mode !== "unquoted" && html.charAt(j - 1) === "/" };
    }
    if (ch === '"' || ch === "'") {
      if (mode === "beforeValue") quote = ch;
      continue;
    }
    if (ch === "=" ) {
      if (mode === "tag") mode = "beforeValue";
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r") {
      if (mode !== "beforeValue") mode = "tag"; // whitespace between `=` and the value is skipped per the rules
      continue;
    }
    if (mode === "beforeValue") mode = "unquoted";
  }
  return { end: -1, selfClosing: false };
}

/**
 * The real end tag of raw text (script/style/...): the tag name must be immediately followed by
 * `[\t\n\f\r />]` to count. Without this step, a `"</scriptx>"` inside a script makes the scanner
 * leave the script early and treat the script body as markup -- the result is attributes injected
 * into a JS string, and that script throws a SyntaxError in the edit frame.
 */
function findRawTextEnd(lower: string, tag: string, from: number): number {
  const needle = `</${tag}`;
  let at = from;
  for (;;) {
    const found = lower.indexOf(needle, at);
    if (found < 0) return -1;
    const after = lower.charAt(found + needle.length);
    if (after === "") return -1; // reached the end before the tag name completed; this is not an end tag
    if (after === " " || after === "\t" || after === "\n" || after === "\f" || after === "\r"
      || after === "/" || after === ">") return found;
    at = found + needle.length;
  }
}

function readToken(html: string, lower: string, lt: number): Token | null {
  const c = html.charAt(lt + 1);
  if (c === "!") {
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      return { kind: "skip", next: end < 0 ? html.length : end + 3 };
    }
    const end = html.indexOf(">", lt);
    return { kind: "skip", next: end < 0 ? html.length : end + 1 };
  }
  if (c === "?") {
    const end = html.indexOf(">", lt);
    return { kind: "skip", next: end < 0 ? html.length : end + 1 };
  }
  if (c === "/") {
    const name = tagNameAt(lower, lt + 2);
    if (!name) {
      const bogus = html.indexOf(">", lt);
      return { kind: "skip", next: bogus < 0 ? html.length : bogus + 1 };
    }
    // An end tag may also carry (discarded) attributes, and `>` may likewise hide inside quotes
    const { end } = findTagEnd(html, lt + 2 + name.length);
    return { kind: "close", tag: name, next: end < 0 ? html.length : end + 1 };
  }
  const name = tagNameAt(lower, lt + 1);
  if (!name) return null; // the `<` in `a < b`: treat as plain text, do not split the text node
  const attrAt = lt + 1 + name.length;
  const { end, selfClosing } = findTagEnd(html, attrAt);
  return { kind: "open", tag: name, attrAt, selfClosing, next: end < 0 ? html.length : end + 1 };
}

// --- Injection position --------------------------------------------------------

/**
 * Two landmarks in the document: the editor script's injection point (right after the first
 * `<head>` start tag), and the first `<script>` start tag that comes **before** it.
 *
 * Uses the tokenizer above, not a regex like `/<head[^>]*>/` -- `<!-- <head> -->` inside a comment,
 * `"<head>"` inside a script string, and `<head data-x="a>b">` all mislead a regex.
 * Stop as soon as `<head>` is found: any `<script>` after it comes after the injection point anyway
 * and is irrelevant to this check.
 */
function findLandmarks(html: string): { headAt: number; scriptAt: number } {
  const lower = html.toLowerCase();
  let headAt = -1;
  let scriptAt = -1;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const token = readToken(html, lower, lt);
    if (!token) { i = lt + 1; continue; } // the `<` in `a < b`
    let next = token.next;
    if (token.kind === "open") {
      if (token.tag === "head") { headAt = next; break; }
      if (token.tag === "script" && scriptAt < 0) scriptAt = lt;
      if (RAW_TEXT_TAGS.has(token.tag)) {
        // Skip the content wholesale: the `<head>` in `<script>"</head>"</script>` is not markup
        const close = findRawTextEnd(lower, token.tag, next);
        if (close < 0) {
          next = html.length;
        } else {
          const { end } = findTagEnd(html, close + token.tag.length + 2);
          next = end < 0 ? html.length : end + 1;
        }
      }
    }
    i = next;
  }
  return { headAt, scriptAt };
}

/**
 * Injection point for the editor script / `<base>` / storage shim: the offset right after the first
 * **real** `<head>` start tag; -1 when the document has no `<head>` (the injector must then prepend
 * the fragment to the very front of the document, where it is still the first script).
 */
export function headInsertionIndex(html: string): number {
  return findLandmarks(html).headAt;
}

/**
 * Does the first `<script>` in the entry HTML come **before** `<head>`?
 *
 * The security of the whole visual-editing scheme rests on one condition: "the injected bootstrap
 * is the first script the document executes". That positional advantage is how it registers its
 * message listener first and snapshots the MessageEvent primitives first, so that it can
 * stopImmediatePropagation during the handshake and keep artifact scripts from ever touching the
 * port. But HTML5 allows `<script>` before `<html>`/`<head>` (the browser runs it first as implicit
 * head content):
 *
 *     <script>...</script>
 *     <head></head>
 *
 * Such an artifact script runs before the bootstrap; its earlier-registered message listener is the
 * first to receive the parent's handshake ping -- it reads e.ports[0], calls
 * stopImmediatePropagation, and can then impersonate the bootstrap on that private channel, writing
 * forged patches into the user's source (and the audit records it as the user's own method=visual
 * edit). So this is not merely "an artifact author breaking their own editor"; the whole thing must
 * be rejected before injection, rather than injecting and making the user wait out an 8-second
 * timeout.
 *
 * Only scripts that would actually execute count: `<!doctype>`, comments, whitespace, and the
 * `<html>`/`<head>` tags themselves coming first are all perfectly normal.
 */
export function scriptPrecedesHead(html: string): boolean {
  const { headAt, scriptAt } = findLandmarks(html);
  return scriptAt >= 0 && headAt >= 0 && scriptAt < headAt;
}

/**
 * Scan the source to determine "which elements carry editable text, and which source range each
 * of their texts occupies". The injecting side and the writeback side must call the same function
 * and get the same numbering; that is the foundation of the whole locating scheme.
 */
export function scanEditableText(html: string): Map<number, ElementSlot> {
  const lower = html.toLowerCase();
  const slots = new Map<number, ElementSlot>();
  const stack: Frame[] = [];
  let elIndex = 0;
  let opaqueDepth = 0;
  let foreignDepth = 0;
  let i = 0;
  let pending = 0; // start of the current text run

  const addText = (start: number, end: number) => {
    if (end <= start || opaqueDepth > 0) return;
    const top = stack[stack.length - 1];
    if (!top) return; // top-level bare text has no element to hang a mark on; give up editing it (the browser stuffs it into an implicit body)
    top.texts.push({ start, end });
    if (/\S/.test(html.slice(start, end))) top.nonWs = true;
  };

  // Close the top element and record its slot. Explicit end tags, displaced implied closes, and
  // whatever is left on the stack when scanning ends all take this path -- omitting end tags
  // (`<li>`/`<p>`/`<td>` ...) is fully valid HTML5, and those elements used to be merely popped,
  // never recorded as slots, which made whole pages "not editable".
  const closeTop = () => {
    const frame = stack.pop();
    if (!frame) return;
    if (frame.opaque) opaqueDepth--;
    if (frame.foreign) foreignDepth--;
    if (TABLE_TEXT_TAGS.has(frame.tag)) return;
    if (!frame.opaque && opaqueDepth === 0 && frame.nonWs && frame.texts.length > 0) {
      slots.set(frame.el, { el: frame.el, attrAt: frame.attrAt, texts: frame.texts });
    }
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const token = readToken(html, lower, lt);
    if (!token) {
      i = lt + 1; // a `<` in plain text; the text run is not broken
      continue;
    }
    addText(pending, lt);
    let next = token.next;

    if (token.kind === "open") {
      const tag = token.tag;
      // First pop the displaced elements per HTML5's implied-close rules (`<li>` displaces the
      // previous `<li>`, `<div>` displaces an unclosed `<p>` ...), or they would pose as the new
      // element's ancestors and all text would be credited to the wrong element.
      const implied = IMPLIED_END[tag];
      if (implied && foreignDepth === 0) {
        while (stack.length && implied.has(stack[stack.length - 1].tag)) closeTop();
      }
      if (RAW_TEXT_TAGS.has(tag)) {
        // Skip the content wholesale: `<` and `>` inside script/style are not markup
        const close = findRawTextEnd(lower, tag, next);
        if (close < 0) {
          next = html.length;
        } else {
          const { end } = findTagEnd(html, close + tag.length + 2);
          next = end < 0 ? html.length : end + 1;
        }
      } else if (!VOID_TAGS.has(tag) && !(token.selfClosing && foreignDepth > 0)) {
        // `/>` is truly self-closing only inside SVG/MathML; in the HTML namespace the parser ignores it and the element is pushed as usual.
        const opaque = OPAQUE_TAGS.has(tag);
        const foreign = FOREIGN_TAGS.has(tag);
        if (opaque) opaqueDepth++;
        if (foreign) foreignDepth++;
        stack.push({ tag, el: elIndex++, attrAt: token.attrAt, texts: [], nonWs: false, opaque, foreign });
      }
    } else if (token.kind === "close") {
      let at = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === token.tag) { at = k; break; }
      }
      // No matching start tag -> ignore this stray end tag. The elements in between that never got
      // an end tag are implicitly closed here by the browser; we do the same (rather than discard
      // them) -- otherwise `<ul><li>a<li>b</ul>` would be entirely uneditable.
      if (at >= 0) {
        while (stack.length > at) closeTop();
      }
    }

    i = next;
    pending = next;
  }
  addText(pending, html.length);
  while (stack.length) closeTop(); // same for elements left unclosed at the end of the document
  return slots;
}

/** Add locating marks to the start tag of every element carrying editable text; not a single other byte changes. */
export function markEditableText(html: string): string {
  const slots = [...scanEditableText(html).values()].sort((a, b) => a.attrAt - b.attrAt);
  if (!slots.length) return html;
  const parts: string[] = [];
  let cursor = 0;
  for (const slot of slots) {
    parts.push(html.slice(cursor, slot.attrAt), ` ${NODE_ATTR}="${slot.el}" ${TEXTS_ATTR}="${slot.texts.length}"`);
    cursor = slot.attrAt;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

// --- Text comparison -----------------------------------------------------------

// Small fallback table, reached only when there is **no DOM** (server side / unit tests). Browsers
// know 2231 named entities plus the semicolon-less legacy forms; comparing before against a
// hand-copied table is bound to miss -- something like `Caf&eacute;` could never be saved.
// The path that actually handles a user's save is decodeEntities: with a DOM, the browser decodes.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", shy: "\u00ad", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
  middot: "·", bull: "•", hellip: "…", mdash: "—", ndash: "–", dagger: "†",
  sect: "§", para: "¶", times: "×", divide: "÷", plusmn: "±", frac12: "½",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
  euro: "€", pound: "£", yen: "¥", cent: "¢", check: "✓", cross: "✗",
};

function fromCodePoint(cp: number, original: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return original;
  return String.fromCodePoint(cp);
}

/**
 * Decode entities with the browser's own parser: textarea content is RCDATA, `<` does not open a
 * tag, only entities are decoded -- the result is exactly the textContent this source would have as
 * a text node, which naturally matches the before captured at runtime.
 * Returns null when this path is unavailable (no DOM, or the text contains `</` and risks escaping
 * RCDATA), deferring to the fallback table.
 */
function domDecode(text: string): string | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  if (text.includes("</")) return null; // an end tag can escape the textarea's RCDATA; not worth the risk
  try {
    const box = document.createElement("textarea");
    box.innerHTML = text;
    return typeof box.value === "string" ? box.value : null;
  } catch {
    return null;
  }
}

/** Turn a source fragment into what the browser's textContent would give, for comparison with the before captured at runtime. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  const byDom = domDecode(text);
  if (byDom !== null) return byDom;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      return fromCodePoint(parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10), match);
    }
    const exact = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined;
    if (exact !== undefined) return exact;
    const lower = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
  });
}

/** Text must be escaped on writeback, or a casually typed `<div>` could break the document structure (i.e. become an injection vector). */
export function escapeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "") // control characters never enter the source
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Is the text in the source the same passage as the before captured at runtime? Whitespace differences are tolerated; the substantive text must match. */
function sameText(fromSource: string, fromDom: string): boolean {
  const a = fromSource.replace(/\r\n?/g, "\n");
  const b = fromDom.replace(/\r\n?/g, "\n");
  return a === b || collapse(a) === collapse(b);
}

/**
 * Upper bound (in characters) on text / before within a single patch.
 *
 * Patches arrive via postMessage from the iframe; both count and length are dictated by that
 * document. A hand-edited passage is nowhere near 100k characters; reaching that scale can only mean
 * an artifact script is pumping data (or something is buggy) -- every patch runs through
 * decodeEntities / sameText / escapeText, and a few oversized patches are enough to turn one save
 * into a CPU incident.
 */
export const MAX_PATCH_TEXT_LENGTH = 100_000;

/** Patches arrive via postMessage from the iframe; their shape cannot be treated as trusted input. */
function normalizePatch(raw: unknown): TextPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const { el, i, before, text } = raw as Record<string, unknown>;
  if (typeof el !== "number" || !Number.isInteger(el) || el < 0) return null;
  if (typeof i !== "number" || !Number.isInteger(i) || i < 0) return null;
  if (typeof before !== "string" || typeof text !== "string") return null;
  return { el, i, before, text };
}

/**
 * Write a set of text changes back into the original source. Structure/styles/scripts/attributes/
 * whitespace are untouched; only the matched text ranges are replaced. A patch that cannot be
 * located, or whose source text no longer equals before, is skipped wholesale and placed in skipped
 * for the caller to report to the user.
 */
export function applyTextPatches(html: string, patches: readonly unknown[]): WritebackResult {
  const slots = scanEditableText(html);
  const applied: TextPatch[] = [];
  const skipped: TextPatch[] = [];
  const edits: Array<{ start: number; end: number; text: string; patch: TextPatch }> = [];
  const seen = new Set<string>();

  for (const raw of patches) {
    const patch = normalizePatch(raw);
    if (!patch) continue;
    // Oversized patches are not written back, but **not silently dropped** either: they take the
    // same skipped path as "does not match the source", so the user sees "N more could not be
    // written back" instead of a change vanishing into thin air.
    if (patch.before.length > MAX_PATCH_TEXT_LENGTH || patch.text.length > MAX_PATCH_TEXT_LENGTH) {
      skipped.push(patch);
      continue;
    }
    const key = `${patch.el}:${patch.i}`;
    if (seen.has(key)) { skipped.push(patch); continue; }
    seen.add(key);

    const range = slots.get(patch.el)?.texts[patch.i];
    if (!range) { skipped.push(patch); continue; }
    const source = html.slice(range.start, range.end);
    // A tag-opening `<` inside a text range can only mean the scanner has lost sync with the real
    // structure; touching it now would corrupt the file. But the `<` in `a < b` is plain text to
    // both the browser and the scanner -- dropping that patch would be pure collateral damage.
    if (/<[a-zA-Z!?/]/.test(source)) { skipped.push(patch); continue; }
    if (!sameText(decodeEntities(source), patch.before)) { skipped.push(patch); continue; }
    if (patch.text === patch.before) { applied.push(patch); continue; } // nothing actually changed; do not launder away entity forms (&mdash; and the like)
    edits.push({ start: range.start, end: range.end, text: escapeText(patch.text), patch });
  }

  edits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    // Text nodes never overlap; if they do collide, prefer not to change -- but this change **was
    // not written**, so it must go into skipped, or the frontend (which only looks at
    // skipped.length) would let the user believe everything was saved.
    if (edit.start < cursor) { skipped.push(edit.patch); continue; }
    applied.push(edit.patch);
    parts.push(html.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(html.slice(cursor));
  return { html: parts.join(""), applied, skipped };
}
