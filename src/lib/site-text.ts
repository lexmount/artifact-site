import "server-only";

// The searchable text of a site — what lets an agent find a site by what it says and read it
// without downloading the tree.
//
// One row per site (`site_texts`), always for the CURRENT version: every path that makes a
// version current schedules a re-extraction (see lib/sites.ts) once the response is out, and the
// maintenance tick backfills whatever is missing or stale (sites from before this table existed,
// a process that died mid-extraction). A failure — unreadable files, a body the store refuses —
// is recorded as an empty body rather than retried forever: the backfill orders by freshness,
// and one broken site must not sit at the top of that list for good, starving everything behind it.
//
// Tokens, not language: both databases index a pre-tokenised string built here (see tokenize),
// so search works the same on Postgres and SQLite and needs no extension for Chinese.
import { afterResponse, flushAfterResponseForTests } from "@/lib/after-response";
import { getSite, getSiteText, getVersion, listSitesNeedingText, updateSiteTextTitle, upsertSiteText, SITE_TEXT_EXTRACTOR_VERSION, type SearchToken } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import type { SiteKind } from "@/lib/types";
import { unzipBounded } from "@/lib/unzip";

/** Stored body is capped here; the read endpoint's own `max_chars` cap is lower by default. */
export const MAX_TEXT_CHARS = 300_000;
const MAX_TEXT_FILES = 50;
const MAX_PDF_PAGES = 200;
const TEXT_EXTENSIONS = /\.(html?|md|markdown|txt)$/i;
// Memory is bounded BEFORE anything is read, not after: an uploaded file may be as large as the
// per-file limit (hundreds of MB), and the text of a page never needs more than its opening.
/** Of a text file, only this much is read (the body is capped at MAX_TEXT_CHARS anyway). */
export const MAX_TEXT_FILE_READ = 2 * 1024 * 1024;
/** A document larger than this is not parsed at all — pdf.js and the office unzip need the whole file in memory. */
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
/** An office archive is inflated only as far as the parts that carry text, and never past these. */
const OFFICE_CAPS = { maxFiles: 2000, maxBytes: 32 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024 };
/** Extractions running at once, process-wide: a burst of uploads queues here instead of multiplying the peak. */
const MAX_CONCURRENT_EXTRACTIONS = 2;
/**
 * Postgres refuses a tsvector whose lexeme data passes 1,048,575 bytes, and tsvectorCost below
 * counts exactly what that check counts. Prose of any length fits (its cost is its vocabulary,
 * and a lexeme carries only its distinct positions); a directory-shaped page — tens of thousands
 * of distinct names, in any script — is cut to the largest index that fits rather than refused.
 * The budget leaves room for the title's lexemes, which share the vector.
 */
export const TSVECTOR_BUDGET_BYTES = 1_000_000;

// ---- tokenizer ------------------------------------------------------------------------------

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}_]+/gu;
const HEX_DIGITS = 5; // every code point fits; a fixed width keeps prefix matches from crossing planes

/**
 * Search tokens of a text — the same function indexes and queries, which is what makes a query
 * match at all. Latin (and any spaced script) words stay words, folded to ASCII (café → cafe,
 * ＡＢＣ → abc); Chinese, Japanese and Korean runs become character bigrams, so "配额设置" is found
 * by "配额", by "设置" and by "额设" alike, without a dictionary. Every token is `[a-z0-9]+`: CJK
 * bigrams are spelled as their code points (`z04f60597d`), so the database's own parser sees plain
 * ASCII words whatever its locale and can never drop a character it does not classify as a letter.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const folded = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
  for (const run of folded.match(WORD) ?? []) {
    let latin = "";
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (CJK.test(ch)) {
        if (latin) { out.push(asciiToken(latin)); latin = ""; }
        const next = chars[i + 1];
        if (next && CJK.test(next)) out.push(cjkToken(ch + next));
        else if (!(i > 0 && CJK.test(chars[i - 1]))) out.push(cjkToken(ch)); // a lone character still counts
      } else {
        latin += ch;
      }
    }
    if (latin) out.push(asciiToken(latin));
  }
  return out;
}

const CODE_POINT_TOKEN = /^z[0-9a-f]{5}$/;

function asciiToken(word: string): string {
  const ascii = word.replace(/[^a-z0-9]/g, (c) => `x${c.codePointAt(0)!.toString(16)}`);
  // A word that happens to be spelled like a code-point token ("zabbed") is escaped, so the shape
  // below identifies CJK tokens exactly — index and query go through here alike.
  return CODE_POINT_TOKEN.test(ascii) ? `x7a${ascii.slice(1)}` : ascii;
}

function cjkToken(chars: string): string {
  return "z" + Array.from(chars).map((c) => c.codePointAt(0)!.toString(16).padStart(HEX_DIGITS, "0")).join("");
}

/** A token that spells exactly one CJK character (as opposed to a bigram, or a word). */
function isSingleCjk(token: string): boolean {
  return CODE_POINT_TOKEN.test(token);
}

/** The tokens as one space-separated string — what the stores index. */
export function tokenString(text: string): string {
  return tokenize(text).join(" ");
}

// Postgres's tsvector limits (tsvector.c): a position past this is clamped to it, a lexeme keeps
// at most this many distinct positions, and the size check (`lenstr`) counts, per lexeme, the
// spelling rounded up to an even length plus 2 + 2 bytes per kept position — nothing else.
const PG_LIMIT_POS = 16_383;
const PG_MAX_POSITIONS = 255;

/** Per lexeme: the bytes Postgres's own limit check charges it, given the positions it would keep. */
function lexemeCosts(tokens: string[]): Map<string, number> {
  const positions = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    const p = Math.min(i + 1, PG_LIMIT_POS);
    let arr = positions.get(t);
    if (!arr) { arr = []; positions.set(t, arr); }
    if (arr.length < PG_MAX_POSITIONS && arr[arr.length - 1] !== p) arr.push(p);
  });
  const costs = new Map<string, number>();
  for (const [t, arr] of positions) costs.set(t, t.length + (t.length % 2) + 2 + 2 * arr.length);
  return costs;
}

/** The bytes Postgres would count these tokens' tsvector at — the number its 1 MB refusal compares. */
export function tsvectorCost(tokens: string[]): number {
  let total = 0;
  for (const c of lexemeCosts(tokens).values()) total += c;
  return total;
}

/**
 * The body's tokens, cut to what a tsvector can hold (TSVECTOR_BUDGET_BYTES). Lexemes are kept in
 * order of first appearance until the budget is spent; every occurrence of a kept lexeme stays,
 * so ranking and phrase adjacency are untouched. Prose is never cut — a lexeme costs its distinct
 * positions, and long prose repeats a modest vocabulary. Dropping lexemes shifts the positions of
 * the rest, which can un-clamp a few, so the cut is re-measured until it fits.
 */
export function limitTokens(tokens: string[], budget = TSVECTOR_BUDGET_BYTES): string[] {
  let current = tokens;
  for (let round = 0; round < 8; round++) {
    const costs = lexemeCosts(current);
    let spent = 0;
    const kept = new Set<string>();
    for (const [t, cost] of costs) { // Map iterates in insertion order = first appearance
      if (spent + cost > budget) continue;
      spent += cost;
      kept.add(t);
    }
    if (kept.size === costs.size) return current;
    current = current.filter((t) => kept.has(t));
  }
  return current;
}

/**
 * A query's tokens. A single CJK character is emitted as a bigram's prefix, so `国` finds a page
 * that says 中国人民 (it starts the bigram 国人) — only a run-final occurrence escapes it.
 */
export function queryTokens(query: string): SearchToken[] {
  const seen = new Set<string>();
  const out: SearchToken[] = [];
  for (const text of tokenize(query)) {
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, prefix: isSingleCjk(text) });
  }
  return out;
}

// ---- extraction -----------------------------------------------------------------------------

const DROP_ELEMENTS = /<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|nav|main|aside|blockquote|pre|hr|dt|dd|figure|figcaption|summary|details)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", copy: "©" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function collapse(s: string): string {
  return s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n+ */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Readable text of an HTML document: title and meta description first, then the body prose. */
export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const description = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? "";
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(DROP_ELEMENTS, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");
  const head = [title, description].map((s) => collapse(decodeEntities(s))).filter(Boolean).join("\n");
  const prose = collapse(decodeEntities(body));
  return [head, prose].filter(Boolean).join("\n\n");
}

/** Text of a pdf, page by page. pdf.js is already a dependency (the viewer); its legacy build runs in Node. */
export async function pdfToText(bytes: Uint8Array, maxPages = MAX_PDF_PAGES): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js refuses a Node Buffer (which the local store returns); a plain Uint8Array VIEW over the
  // same memory satisfies it without a second copy of the file.
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const task = pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ""; }
        else if (item.str && !item.str.endsWith(" ")) line += " ";
      }
      if (line) lines.push(line);
      pages.push(collapse(lines.join("\n")));
      page.cleanup();
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    await task.destroy();
  }
}

const DOCX_PART = /^word\/document\.xml$/;
const PPTX_PART = /^ppt\/slides\/slide\d+\.xml$/;

/**
 * Text of a docx / pptx without a converter: the XML inside the zip, tags stripped. Only the parts
 * that carry text are inflated, under the same bounded inflation the upload path uses — an
 * archive whose document part inflates to hundreds of megabytes is refused, not read into memory.
 */
export function officeToText(bytes: Uint8Array, format: "docx" | "pptx"): string {
  const want = format === "docx" ? DOCX_PART : PPTX_PART;
  const parts = unzipBounded(bytes, { caps: OFFICE_CAPS, only: (name) => want.test(name) })
    .sort((a, b) => Number(a.name.match(/\d+/)?.[0] ?? 0) - Number(b.name.match(/\d+/)?.[0] ?? 0));
  const texts: string[] = [];
  for (const part of parts) {
    const xml = new TextDecoder().decode(part.bytes);
    texts.push(collapse(decodeEntities(xml
      .replace(/<\/(w|a):p>/g, "\n")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<(w|a):br\/?>/g, "\n")
      .replace(/<[^>]+>/g, ""))));
  }
  return texts.filter(Boolean).join("\n\n");
}

export interface TextSource {
  kind: SiteKind;
  entry: string;
  files: string[];
  /**
   * The first `max` bytes of a file and the file's full size — the ONLY way files are read here,
   * so the cap holds whatever the storage backend can or cannot say up front (a size probe that
   * fails would otherwise fail open into a whole-file read).
   */
  readUpTo(relpath: string, max: number): Promise<{ bytes: Uint8Array; total: number }>;
  /** Bytes on disk when cheaply known (a HEAD), else null — spares transferring a document only to drop it. */
  size?(relpath: string): Promise<number | null>;
}

/**
 * The searchable text of one version. Sites: the entry page first, then every other html/markdown/
 * text file in path order, each after its own path so a match can be placed. Documents: the pdf
 * (the upload, or the converter's preview of an office file), else the office XML itself; a legacy
 * .doc/.ppt with no converter yields nothing, and the title alone is indexed.
 */
export async function extractText(source: TextSource): Promise<string> {
  const decode = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
  if (source.kind === "document") {
    const pdf = source.files.find((f) => f === "preview.pdf") ?? source.files.find((f) => /^original\/.*\.pdf$/i.test(f));
    const office = source.files.find((f) => /^original\/.*\.(docx|pptx)$/i.test(f));
    const file = pdf ?? office;
    if (!file) return "";
    // A cheap probe first, so a document past the cap is never transferred; the bounded read is the
    // check that holds when the probe cannot answer (it must never widen into a whole-file read).
    const known = source.size ? await source.size(file) : null;
    if (known !== null && known > MAX_DOCUMENT_BYTES) return ""; // the title alone is indexed
    const { bytes, total } = await source.readUpTo(file, MAX_DOCUMENT_BYTES);
    if (total > MAX_DOCUMENT_BYTES) return "";
    if (pdf) return cap(await pdfToText(bytes));
    return cap(officeToText(bytes, office!.toLowerCase().endsWith(".docx") ? "docx" : "pptx"));
  }
  const ordered = [source.entry, ...source.files.filter((f) => f !== source.entry && TEXT_EXTENSIONS.test(f)).sort()].slice(0, MAX_TEXT_FILES);
  const parts: string[] = [];
  let total = 0;
  for (const path of ordered) {
    if (total >= MAX_TEXT_CHARS) break;
    let raw: string;
    try {
      raw = decode((await source.readUpTo(path, MAX_TEXT_FILE_READ)).bytes);
    } catch (error) {
      // One unreadable file costs that file's text, never the site's.
      console.error(`[site-text] skipping ${path}:`, error);
      continue;
    }
    const text = /\.html?$/i.test(path) ? htmlToText(raw) : collapse(raw);
    if (!text) continue;
    const piece = path === source.entry ? text : `# ${path}\n${text}`;
    parts.push(piece);
    total += piece.length;
  }
  return cap(parts.join("\n\n"));
}

function cap(text: string): string {
  return cutText(text, MAX_TEXT_CHARS);
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair (an emoji or a rare
 *  CJK character straddling the cut would otherwise leave a lone surrogate that JSON cannot carry). */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, pairSafe(text, max));
}

/** `at`, moved back one unit if it would split a surrogate pair. */
function pairSafe(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at;
  const before = text.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at;
}

// ---- the index ------------------------------------------------------------------------------

/**
 * What an extraction did: wrote the row; skipped the write because the version is no longer
 * current (or the site is gone); or could not write. `body` is the extracted text whenever the
 * version's files were read, whatever happened to the write — a reader asked for THAT version.
 */
export type IndexOutcome = { outcome: "written" | "skipped" | "failed"; body: string };

/** One extraction per site version at a time: a burst of reads on an un-indexed site shares the parse. */
const inFlight = new Map<string, Promise<IndexOutcome>>();

/** The process-wide gate (MAX_CONCURRENT_EXTRACTIONS): callers past it wait their turn in order. */
let running = 0;
const waiting: Array<() => void> = [];
async function withExtractionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_EXTRACTIONS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}
/** Tests only. */
export function __extractionsRunningForTests(): number {
  return running;
}

/**
 * Extract and store the text of this version. The write lands only while the version is still
 * current (a slower extraction of an OLDER version can finish after a newer one and must not win),
 * and a store that refuses the tokens still gets a title-only row, so the site is never left
 * outside the index for the backfill to trip over. Returns the stored body ("" on failure).
 */
export async function indexSiteText(siteId: string, versionId: string): Promise<string> {
  return (await indexSiteTextOutcome(siteId, versionId)).body;
}

/** Same, reporting what happened — what the backfill counts on. */
export function indexSiteTextOutcome(siteId: string, versionId: string): Promise<IndexOutcome> {
  const key = `${siteId}:${versionId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = doIndex(siteId, versionId).finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}

async function doIndex(siteId: string, versionId: string): Promise<IndexOutcome> {
  const [site, version] = await Promise.all([getSite(siteId), getVersion(versionId)]);
  if (!site || !version || version.siteId !== siteId) return { outcome: "skipped", body: "" };
  // A version that is no longer current is still extracted — a read that raced a commit wants its
  // text — but it is never written: the index holds the current version only, and the currency
  // check is made at the write (below, and by the store's own guard).
  let body = "";
  try {
    const storage = getStorage();
    body = await withExtractionSlot(async () => {
      const files = await storage.list(siteId, versionId);
      return extractText({
        kind: site.kind,
        entry: version.entry,
        files,
        readUpTo: (p, max) => storage.readRange(siteId, versionId, p, 0, max - 1),
        size: (p) => storage.sizeOf(siteId, versionId, p),
      });
    });
  } catch (error) {
    console.error(`[site-text] extraction failed for ${site.slug}@${versionId}:`, error);
  }
  const skipped: IndexOutcome = { outcome: "skipped", body };
  // The title is read again HERE, not at the start: a rename that landed during a long parse must
  // win, and the store's own guard decides whether the version is still current at the write.
  const fresh = await getSite(siteId);
  if (!fresh || fresh.currentVersionId !== versionId) return skipped;
  const row = { siteId, versionId, title: fresh.title, body, titleTokens: tokenString(fresh.title), extractedAt: Date.now(), extractorVersion: SITE_TEXT_EXTRACTOR_VERSION };
  try {
    const written = await upsertSiteText({ ...row, bodyTokens: limitTokens(tokenize(body)).join(" ") });
    return written ? { outcome: "written", body } : skipped;
  } catch (error) {
    console.error(`[site-text] store refused the tokens of ${site.slug}@${versionId}; keeping the title only:`, error);
    try {
      const written = await upsertSiteText({ ...row, bodyTokens: "" });
      return written ? { outcome: "written", body } : skipped;
    } catch (again) {
      console.error(`[site-text] could not record ${site.slug}@${versionId} at all:`, again);
      return { outcome: "failed", body };
    }
  }
}

/**
 * For the write paths: the extraction runs once the response is out (Next's `after()`), so an
 * upload — or a document publish, whose pdf parse would otherwise share the main thread with the
 * response — is never slower for it. Errors are logged, never thrown: the site exists whether or
 * not it is searchable yet.
 */
export function scheduleTextIndex(siteId: string, versionId: string): void {
  afterResponse(() => indexSiteText(siteId, versionId).catch((error) => console.error("[site-text]", error)));
}

/** A rename changes the indexed title without re-reading the body. No row yet = nothing to do (the backfill will index it). */
export function scheduleTextRetitle(siteId: string, title: string): void {
  afterResponse(() => updateSiteTextTitle(siteId, title, tokenString(title)).catch((error) => console.error("[site-text]", error)));
}

/** Tests only: wait for every scheduled extraction to land. */
export function flushTextIndexForTests(): Promise<void> {
  return flushAfterResponseForTests();
}

/**
 * The maintenance job: index sites whose current version has no text yet, freshest first, in
 * batches until the worklist is empty or the time budget is spent. A site that cannot be
 * indexed is counted and skipped, never allowed to stop the batch.
 */
export async function backfillSiteTexts(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ indexed: number; skipped: number; failed: number; remaining: number }> {
  const batch = opts.limit ?? 20;
  const deadline = Date.now() + (opts.budgetMs ?? 0);
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  for (;;) {
    const todo = await listSitesNeedingText(batch);
    if (!todo.length) return { indexed, skipped, failed, remaining: 0 };
    let written = 0;
    for (const { siteId, versionId } of todo) {
      let outcome: IndexOutcome["outcome"];
      try {
        outcome = (await indexSiteTextOutcome(siteId, versionId)).outcome;
      } catch (error) {
        outcome = "failed";
        console.error(`[site-text] backfill could not index ${siteId}@${versionId}:`, error);
      }
      if (outcome === "written") { indexed++; written++; } else if (outcome === "skipped") skipped++; else failed++;
    }
    // Only a written row leaves the worklist. A batch that wrote nothing would come back the same
    // (a site whose version keeps changing under it, a store that keeps refusing): stop, do not spin.
    if (written === 0 || todo.length < batch || Date.now() >= deadline) {
      return { indexed, skipped, failed, remaining: (await listSitesNeedingText(1)).length };
    }
  }
}

/** The stored text of a site's current version, extracting on the spot when the index has not caught up. */
export async function siteTextOf(siteId: string, versionId: string): Promise<string> {
  const row = await getSiteText(siteId);
  if (row && row.versionId === versionId && row.extractorVersion >= SITE_TEXT_EXTRACTOR_VERSION) return row.body;
  return indexSiteText(siteId, versionId);
}

/**
 * The passage of `text` around the first term that occurs, for a search result. Terms are the
 * user's own words (not tokens) so the snippet is what they typed; falls back to the opening.
 */
export function snippetOf(text: string, query: string, radius = 120): string {
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return ellipsis(cutText(text, radius * 2), text.length > radius * 2, false);
  const start = pairSafe(text, Math.max(0, at - radius));
  const end = pairSafe(text, Math.min(text.length, at + radius));
  return ellipsis(text.slice(start, end), end < text.length, start > 0);
}

function ellipsis(s: string, after: boolean, before: boolean): string {
  const t = s.replace(/\s+/g, " ").trim();
  return `${before ? "…" : ""}${t}${after ? "…" : ""}`;
}
