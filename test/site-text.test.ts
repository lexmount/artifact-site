// Search and read for agents: the tokenizer (Chinese bigrams, ASCII-only tokens), the extractors
// (html, pdf, office XML), the index following every version, the visibility scope of a search,
// and the two routes. SQLite here; the CI integration job runs this file on Postgres too, which is
// what proves the tsvector side matches the FTS5 side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { closeDbForTests, createEditToken, createId, getSiteBySlug, getSiteText, insertPublishToken, insertSiteWithVersion, setSiteTakenDown, updateSiteSharing, upsertUser, addCollaborator } from "@/lib/db";
import { hashTokenSecret } from "@/lib/publish-token";
import { createSite, deleteSite, editSite, forkSite, renameSite, rollbackTo } from "@/lib/sites";
import { setCurrentVersion, upsertSiteText } from "@/lib/db";
import { __extractionsRunningForTests, type TextSource, backfillSiteTexts, cutText, extractText, flushTextIndexForTests, htmlToText, limitTokens, MAX_DOCUMENT_BYTES, MAX_TEXT_FILE_READ, officeToText, pdfToText, queryTokens, siteTextOf, snippetOf, TSVECTOR_BUDGET_BYTES, tsvectorCost, tokenize } from "@/lib/site-text";
import { searchSites } from "@/lib/search";
import { writeVersionFiles } from "@/lib/store";
import { getStorage } from "@/lib/storage";
import { BadRequestError } from "@/lib/errors";
import { GET as SEARCH } from "@/app/api/search/route";
import { GET as TEXT } from "@/app/api/sites/[slug]/text/route";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { folderFiles, testAudit, u8 } from "./helpers";

const dirs: string[] = [];
async function resetPostgres(): Promise<void> {
  if (process.env.ARTIFACT_DB_DRIVER !== "postgres") return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  try { await pool.query("TRUNCATE users, sites, admin_log, publish_tokens, sessions, upload_sessions, site_texts CASCADE"); }
  catch (error) { if ((error as { code?: string }).code !== "42P01") throw error; }
  finally { await pool.end(); }
}
beforeEach(async () => {
  await resetPostgres();
  const dir = mkdtempSync(join(tmpdir(), "text-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_CREATE_POLICY = "open";
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "private"; // the public-internet posture: what is not shared is not found
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
  __resetRateLimitForTests();
});
afterEach(async () => {
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_CREATE_POLICY;
  for (const key of ["ARTIFACT_DEFAULT_VISIBILITY", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[key];
});

const B = "http://localhost";
const user = async (subject = "u1") => (await upsertUser({ authProvider: "t", providerSubject: subject, email: `${subject}@example.net`, emailVerified: true })).id;
async function bearerFor(userId: string, secret = `ahp_${userId}`): Promise<Record<string, string>> {
  await insertPublishToken({ id: hashTokenSecret(secret), userId, name: "t", createdAt: Date.now() });
  return { authorization: `Bearer ${secret}` };
}
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const search = async (q: string, headers: Record<string, string> = {}, extra = "") =>
  SEARCH(new Request(`${B}/api/search?q=${encodeURIComponent(q)}${extra}`, { headers }));
const results = async (q: string, headers: Record<string, string> = {}) =>
  ((await (await search(q, headers)).json()) as { results: { slug: string; snippet: string; url: string }[] }).results;

/** Long CJK prose: a 35,000-word vocabulary over 200 characters with a Zipf-ish spread — ~38k distinct bigrams in ~275k tokens, most seen once or twice. */
function longProse(chars: number): string {
  const words = Array.from({ length: 35_000 }, (_, i) => String.fromCodePoint(0x4e00 + (i % 200)) + String.fromCodePoint(0x4e00 + Math.floor(i / 200) % 200));
  let out = "";
  for (let i = 0; out.length < chars; i++) {
    // Skewed pick: most words are rare, a few are common.
    const r = (i * 2654435761) % 1_000_003;
    const idx = r % 4 === 0 ? r % 200 : r % 35_000;
    out += words[idx] + (i % 11 === 0 ? "。" : "");
  }
  return out;
}

/** The budget that admits exactly `keep` of the lexemes in `tokens` (their first-seen order). */
function lexemeBudget(keep: string[], tokens: string[]): number {
  return tsvectorCost(tokens.filter((t) => keep.includes(t)));
}

/** A TextSource over in-memory files, with the same prefix/size semantics as the storage-backed one. */
function memorySource(kind: "single" | "folder" | "document", entry: string, files: Record<string, string | Uint8Array>): TextSource {
  const bytes = (p: string) => (typeof files[p] === "string" ? u8(files[p] as string) : (files[p] as Uint8Array));
  return {
    kind, entry, files: Object.keys(files),
    readUpTo: async (p: string, max: number) => ({ bytes: bytes(p).slice(0, max), total: bytes(p).byteLength }),
  };
}

/** A one-page pdf with `text` in Helvetica — offsets computed, so pdf.js reads it without repair. */
function minimalPdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 40 700 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("tokenize", () => {
  it("keeps latin words, bigrams CJK runs, and spells every token in ASCII", () => {
    expect(tokenize("Quota Settings")).toEqual(["quota", "settings"]);
    const cjk = tokenize("配额设置");
    expect(cjk).toHaveLength(3); // 配额 额设 设置
    for (const t of [...cjk, ...tokenize("naïve café_1")]) expect(t).toMatch(/^[a-z0-9]+$/);
    // A query is tokenised the same way, so a two-character word is a subset of the page's tokens.
    for (const t of tokenize("设置")) expect(cjk).toContain(t);
    expect(tokenize("中")).toHaveLength(1); // a lone character still counts
    expect(tokenize("v2配额quota")).toEqual(["v2", ...tokenize("配额"), "quota"]);
    expect(tokenize("  --  ")).toEqual([]);
    // Folded to ASCII: accents and full-width forms match their plain spelling.
    expect(tokenize("Café")).toEqual(tokenize("cafe"));
    expect(tokenize("ＡＢＣ")).toEqual(["abc"]);
    // Code points are fixed-width, so a BMP character can never be a prefix of a SIP one.
    expect(tokenize("中")[0]).toHaveLength(6);
    expect(tokenize("𠀀")[0]).toHaveLength(6);
  });

  it("queryTokens: a lone CJK character becomes a prefix, everything else an exact token, duplicates dropped", () => {
    expect(queryTokens("国 quota quota")).toEqual([{ text: tokenize("国")[0], prefix: true }, { text: "quota", prefix: false }]);
    expect(queryTokens("配额").every((t) => !t.prefix)).toBe(true);
    // A word is never mistaken for a code-point token: six-letter z-words stay exact, and a word
    // spelled like one ("zabbed" = z + five hex letters) is escaped on both sides.
    expect(queryTokens("zombie zenith zipper zabbed").every((t) => !t.prefix)).toBe(true);
    expect(tokenize("zabbed")).toEqual(["x7aabbed"]);
    expect(tokenize("zabbed")).toEqual(tokenize("ZABBED"));
  });

  it("limitTokens budgets tsvector bytes: long prose goes through whole, a directory in any script is cut to what fits", () => {
    // 300k characters of CJK prose over a 35,000-word vocabulary (what real long-form looks like):
    // ~35k distinct lexemes with a handful of positions each — well under the budget, untouched.
    const proseTokens = tokenize(longProse(300_000));
    expect(proseTokens.length).toBeGreaterThan(200_000);
    expect(new Set(proseTokens).size).toBeGreaterThan(30_000);
    expect(tsvectorCost(proseTokens)).toBeLessThan(TSVECTOR_BUDGET_BYTES);
    expect(limitTokens(proseTokens)).toBe(proseTokens);
    // The model counts what Postgres counts: spelling (even-aligned) + 2 + 2 per DISTINCT clamped
    // position, at most 255 of them, and no per-entry overhead.
    expect(tsvectorCost(["ab"])).toBe(2 + 2 + 2);
    expect(tsvectorCost(["abc"])).toBe(4 + 2 + 2);
    expect(tsvectorCost(Array.from({ length: 1000 }, () => "ab"))).toBe(2 + 2 + 2 * 255);
    expect(tsvectorCost(Array.from({ length: 20_000 }, (_, i) => (i < 19_000 ? `w${i}` : "tail")))).toBe(
      tsvectorCost(Array.from({ length: 19_000 }, (_, i) => `w${i}`)) + 4 + 2 + 2); // every "tail" sits past 16,383 → one clamped position
    // A Cyrillic directory: 33k distinct 8-letter names spell as 32-byte tokens — over the budget, cut so it fits.
    const cyr = "абвгдежзийклмнопрстуфхцчшщ";
    const names = Array.from({ length: 33_000 }, (_, i) => Array.from({ length: 8 }, (_, k) => cyr[Math.floor(i / 26 ** k) % 26]).join(""));
    const dirTokens = tokenize(names.join(" "));
    expect(tsvectorCost(dirTokens)).toBeGreaterThan(TSVECTOR_BUDGET_BYTES);
    const cut = limitTokens(dirTokens);
    expect(tsvectorCost(cut)).toBeLessThanOrEqual(TSVECTOR_BUDGET_BYTES);
    expect(cut.length).toBeLessThan(dirTokens.length);
    expect(cut[0]).toBe(dirTokens[0]); // first-seen lexemes are the ones kept
    // Every occurrence of a kept lexeme stays, in order.
    const mixed = ["a", "b", "c", "a", "a", "d"];
    expect(limitTokens(mixed, lexemeBudget(["a", "b"], mixed))).toEqual(["a", "b", "a", "a"]);
  });
});

describe("extractors", () => {
  it("htmlToText: title and description first, scripts/styles gone, entities decoded, blocks separated", () => {
    const text = htmlToText(`<html><head><title>Q3 &amp; Q4</title><meta name="description" content="the numbers"><style>p{color:red}</style></head>
      <body><script>var secret = 1;</script><h1>Revenue</h1><p>up&nbsp;12%</p><ul><li>one</li><li>two</li></ul><!-- hidden --></body></html>`);
    expect(text).toBe("Q3 & Q4\nthe numbers\n\nRevenue\nup 12%\none\ntwo");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color");
  });

  it("pdfToText reads the page text with the bundled pdf.js", async () => {
    expect(await pdfToText(minimalPdf("Quarterly quota review"))).toContain("Quarterly quota review");
  });

  it("officeToText reads docx paragraphs and pptx slides in order without a converter", () => {
    const docx = zipSync({ "word/document.xml": u8('<w:document><w:body><w:p><w:r><w:t>First &amp; para</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>') });
    expect(officeToText(docx, "docx")).toBe("First & para\nSecond");
    const pptx = zipSync({
      "ppt/slides/slide10.xml": u8("<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>"),
      "ppt/slides/slide2.xml": u8("<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>"),
      "ppt/notesSlides/notesSlide1.xml": u8("<p:notes><a:t>not a slide</a:t></p:notes>"),
    });
    expect(officeToText(pptx, "pptx")).toBe("Two\n\nTen");
  });

  it("officeToText inflates only the text parts, and refuses a document part that inflates past the cap", () => {
    // Media in the archive is never inflated: an entry that would be corrupt if touched is skipped.
    const withMedia = zipSync({ "word/document.xml": u8("<w:p><w:t>hello</w:t></w:p>"), "word/media/image1.png": new Uint8Array(1024) });
    expect(officeToText(withMedia, "docx")).toBe("hello");
    // A 32 MB cap on the part itself: a document.xml that inflates to 40 MB is refused, not read.
    const bomb = zipSync({ "word/document.xml": u8("<w:t>" + "a".repeat(40 * 1024 * 1024) + "</w:t>") }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(200_000);
    expect(() => officeToText(bomb, "docx")).toThrow(BadRequestError);
  });

  it("extractText: entry first, other pages under their path, non-text files skipped", async () => {
    const files: Record<string, string> = { "index.html": page("Home", "<p>welcome</p>"), "about/team.html": page("Team", "<p>people</p>"), "app.js": "var x = 'not indexed';", "notes.md": "# Notes\nplain" };
    const text = await extractText(memorySource("folder", "index.html", files));
    expect(text.startsWith("Home\n\nwelcome")).toBe(true);
    expect(text).toContain("# about/team.html\nTeam\n\npeople");
    expect(text).toContain("# notes.md\n# Notes\nplain");
    expect(text).not.toContain("not indexed");
  });

  it("cutText never leaves half an emoji behind", () => {
    const text = "ab😀cd"; // the emoji is two UTF-16 units: positions 2 and 3
    expect(cutText(text, 3)).toBe("ab");
    expect(cutText(text, 4)).toBe("ab😀");
    expect(cutText(text, 10)).toBe(text);
    expect(JSON.stringify(cutText(text, 3))).not.toContain("\\ud83d");
  });

  it("memory is bounded before reading: a text file is read as a prefix, an oversized document is not parsed at all", async () => {
    let asked = 0;
    const huge = "<p>opening words</p>" + "x".repeat(6 * 1024 * 1024) + "<p>closing words</p>";
    const src = memorySource("single", "index.html", { "index.html": huge });
    src.readUpTo = async (p, max) => { asked = max; return { bytes: u8(huge).slice(0, max), total: huge.length }; };
    const text = await extractText(src);
    expect(asked).toBe(MAX_TEXT_FILE_READ);
    expect(text).toContain("opening words");
    expect(text).not.toContain("closing words"); // past the prefix — never read
    expect(text.length).toBeLessThanOrEqual(300_000);

    // A document is asked for at most the cap; when the total turns out larger, what was read is dropped unparsed.
    const doc = memorySource("document", "index.html", { "index.html": "<html></html>", "original/big.pdf": new Uint8Array(0) });
    let askedDoc = 0;
    doc.readUpTo = async (p, max) => { askedDoc = max; return { bytes: u8("%PDF-not-parsed"), total: MAX_DOCUMENT_BYTES + 1 }; };
    expect(await extractText(doc)).toBe(""); // title-only site
    expect(askedDoc).toBe(MAX_DOCUMENT_BYTES);
  });

  it("one unreadable file costs its own text, not the site's; a size probe spares transferring an oversized document", async () => {
    const src = memorySource("folder", "index.html", { "index.html": page("Home", "<p>alpha</p>"), "empty.txt": "", "notes.md": "gamma" });
    const real = src.readUpTo;
    src.readUpTo = async (p, max) => { if (p === "empty.txt") throw new Error("416 InvalidRange"); return real(p, max); };
    const text = await extractText(src);
    expect(text).toContain("alpha");
    expect(text).toContain("gamma");

    const doc = memorySource("document", "index.html", { "index.html": "<html></html>", "original/big.pdf": new Uint8Array(0) });
    doc.size = async () => MAX_DOCUMENT_BYTES + 1;
    doc.readUpTo = async () => { throw new Error("transferred a document the probe already ruled out"); };
    expect(await extractText(doc)).toBe("");
  });

  it("snippetOf cuts around the first query word, with ellipses where text continues", () => {
    const text = `${"a".repeat(300)} the QUOTA word ${"b".repeat(300)}`;
    const s = snippetOf(text, "quota", 20);
    expect(s).toMatch(/^…a+ the QUOTA word b+…$/);
    expect(snippetOf("short text", "missing")).toBe("short text");
  });
});

describe("the index follows the current version", () => {
  it("publish → searchable; edit → the new text, not the old; rename → the new title; fork and rollback indexed too", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Budget", "<p>quota planning for the north region</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    const me = { userId: owner };
    expect((await searchSites(me, "quota north", 10)).map((r) => r.slug)).toEqual([site.slug]);

    await editSite(site.slug, { content: page("Budget", "<p>headcount planning for the south region</p>") }, testAudit());
    await flushTextIndexForTests();
    expect(await searchSites(me, "quota", 10)).toEqual([]);
    expect((await searchSites(me, "south", 10)).map((r) => r.slug)).toEqual([site.slug]);

    const before = (await getSiteText(site.id))!;
    await renameSite(site.slug, "Staffing plan");
    await flushTextIndexForTests();
    expect((await searchSites(me, "staffing", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect((await searchSites(me, "south staffing", 10)).map((r) => r.slug)).toEqual([site.slug]); // the body's tokens survived the retitle
    const after = (await getSiteText(site.id))!;
    expect(after.title).toBe("Staffing plan");
    expect(after.extractedAt).toBe(before.extractedAt); // the body was not read again

    const fork = await forkSite(site.slug, { ownerId: owner });
    await flushTextIndexForTests();
    expect((await searchSites(me, "south", 10)).map((r) => r.slug).sort()).toEqual([site.slug, fork!.site.slug].sort());

    const versions = (await import("@/lib/sites")).listVersions;
    const first = (await versions(site.slug))!.find((v) => v.source === "upload")!;
    await rollbackTo(site.slug, first.id);
    await flushTextIndexForTests();
    expect((await searchSites(me, "north", 10)).map((r) => r.slug)).toEqual([site.slug]);
  });

  it("Chinese: a two-character query finds a page that contains it inside a longer run, ranked by title match first", async () => {
    const owner = await user();
    const a = await createSite({ mode: "paste", html: page("季度报告", "<p>本季度的配额设置已经完成。</p>") }, { ownerId: owner });
    const b = await createSite({ mode: "paste", html: page("配额说明", "<p>这里解释配额。</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    const hits = await searchSites({ userId: owner }, "配额", 10);
    expect(hits.map((r) => r.slug)).toEqual([b.site.slug, a.site.slug]);
    expect(hits[1].snippet).toContain("配额设置");
    expect(await searchSites({ userId: owner }, "配额 报告", 10)).toHaveLength(1); // every word must occur
  });

  it("extractions run at most two at a time, whatever the burst", async () => {
    const owner = await user();
    const sites = [];
    for (let i = 0; i < 6; i++) sites.push(await createSite({ mode: "paste", html: page(`Burst ${i}`, "<p>burst</p>") }, { ownerId: owner }));
    await flushTextIndexForTests(); // the creates' own extractions are done; now start six at once
    const storage = getStorage();
    const realList = storage.list.bind(storage);
    let peak = 0;
    let calls = 0;
    const spy = vi.spyOn(storage, "list").mockImplementation(async (s, v) => {
      peak = Math.max(peak, __extractionsRunningForTests());
      await new Promise((r) => setTimeout(r, 20));
      return realList(s, v);
    });
    try {
      // Re-index by hand (a rollback would do the same): all six scheduled in the same tick.
      const { indexSiteText } = await import("@/lib/site-text");
      await Promise.all(sites.map((s) => indexSiteText(s.site.id, s.site.currentVersionId)));
      calls = spy.mock.calls.length; // read before mockRestore, which also clears the call log
    } finally { spy.mockRestore(); }
    expect(calls).toBe(6);
    expect(peak).toBe(2);
    expect(__extractionsRunningForTests()).toBe(0);
  });

  it("two commits in quick succession: the older extraction cannot overwrite the newer row", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Race", "<p>alpha content</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    const storage = getStorage();
    const realList = storage.list.bind(storage);
    let slowOnce = true;
    const spy = vi.spyOn(storage, "list").mockImplementation(async (s, v) => {
      const out = await realList(s, v);
      if (slowOnce) { slowOnce = false; await new Promise((r) => setTimeout(r, 300)); } // the first extraction lands last
      return out;
    });
    try {
      await editSite(site.slug, { content: page("Race", "<p>beta content</p>") }, testAudit());
      await editSite(site.slug, { content: page("Race", "<p>gamma content</p>") }, testAudit());
      await flushTextIndexForTests();
    } finally { spy.mockRestore(); }
    expect((await getSiteText(site.id))?.versionId).toBe((await getSiteBySlug(site.slug))!.currentVersionId);
    expect((await searchSites({ userId: owner }, "gamma", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect(await searchSites({ userId: owner }, "beta", 10)).toEqual([]);
  });

  it("a read of an un-indexed version that races a commit still returns that version's text", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Race", "<p>first words</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    const v1 = site.currentVersionId;
    // Forget the index row, then read v1 while a commit to v2 lands inside the extraction.
    await setCurrentVersion(site.id, v1); // no-op pointer write; the row is dropped below through the store
    const { DatabaseSync } = await import("node:sqlite");
    if (process.env.ARTIFACT_DB_DRIVER !== "postgres") {
      const db = new DatabaseSync(join(process.env.ARTIFACT_DATA_DIR!, "sites.sqlite"));
      db.prepare("DELETE FROM site_texts WHERE site_id=?").run(site.id); db.close();
    } else {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
      try { await pool.query("DELETE FROM site_texts WHERE site_id=$1", [site.id]); } finally { await pool.end(); }
    }
    expect(await getSiteText(site.id)).toBeNull();
    const storage = getStorage();
    const realList = storage.list.bind(storage);
    const spy = vi.spyOn(storage, "list").mockImplementation(async (s, v) => {
      const out = await realList(s, v);
      if (v === v1) await editSite(site.slug, { content: page("Race", "<p>second words</p>") }, testAudit());
      return out;
    });
    let text: string;
    try { text = await siteTextOf(site.id, v1); } finally { spy.mockRestore(); }
    await flushTextIndexForTests();
    expect(text).toContain("first words"); // what was asked for, although v1 is no longer current
    const row = await getSiteText(site.id);
    expect(row?.versionId).toBe((await getSiteBySlug(site.slug))!.currentVersionId); // the index holds v2 only
    expect(row?.body).toContain("second words");
  });

  it("a rename that lands during an extraction is what the row ends up with", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Doc", "<p>slow body</p>"), title: "Old name" }, { ownerId: owner });
    await flushTextIndexForTests();
    const storage = getStorage();
    const realList = storage.list.bind(storage);
    const spy = vi.spyOn(storage, "list").mockImplementation(async (s, v) => {
      const out = await realList(s, v);
      await renameSite(site.slug, "New name"); // lands while this extraction is still reading
      return out;
    });
    try {
      await editSite(site.slug, { content: page("Doc", "<p>slow body edited</p>") }, testAudit());
      await flushTextIndexForTests();
    } finally { spy.mockRestore(); }
    expect((await getSiteText(site.id))?.title).toBe("New name");
    expect((await searchSites({ userId: owner }, "new name edited", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect(await searchSites({ userId: owner }, "old", 10)).toEqual([]);
  });

  it("backfill stops on a site it can only skip, and reports it as remaining rather than indexed", async () => {
    const owner = await user();
    const a = await createSite({ mode: "paste", html: page("A", "<p>a</p>") }, { ownerId: owner });
    const b = await createSite({ mode: "paste", html: page("B", "<p>b</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    // Point A's current version at B's version row: the version exists but belongs to another site,
    // so every extraction of A is a skip — and the worklist keeps listing A.
    await setCurrentVersion(a.site.id, b.site.currentVersionId);
    const r = await backfillSiteTexts({ limit: 5, budgetMs: 5_000 });
    expect(r).toMatchObject({ indexed: 0, skipped: 1, failed: 0, remaining: 1 });
  });

  it("a single CJK character finds the page that contains it inside a longer run", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("民生", "<p>中国人民的生活</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    expect((await searchSites({ userId: owner }, "国", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect((await searchSites({ userId: owner }, "国 生活", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect(await searchSites({ userId: owner }, "美", 10)).toEqual([]);
  });

  it("a directory-shaped page (tens of thousands of distinct names) is indexed, not refused by the store", async () => {
    const owner = await user();
    // 75k distinct three-character names: ~150k distinct bigrams, over the 1 MB tsvector limit uncut.
    const chars = Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x4e00 + i * 37));
    const names: string[] = [];
    for (let i = 0; names.length < 75_000; i++) names.push(chars[i % 60] + chars[Math.floor(i / 60) % 60] + chars[Math.floor(i / 3600) % 60]);
    const { site } = await createSite({ mode: "paste", html: page("Directory", `<table>${names.map((n) => `<tr><td>${n}</td></tr>`).join("")}</table>`) }, { ownerId: owner });
    await flushTextIndexForTests();
    const row = await getSiteText(site.id);
    expect(row?.versionId).toBe(site.currentVersionId);
    expect(row!.body.length).toBeGreaterThan(200_000); // the body is whole; only the index is cut
    expect((await searchSites({ userId: owner }, names[0], 10)).map((r) => r.slug)).toEqual([site.slug]); // an early name is found
    expect((await searchSites({ userId: owner }, "directory", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 0, skipped: 0, failed: 0, remaining: 0 }); // nothing left behind it
  }, 20_000);

  it("a 300k-character Chinese document with a 30k-word vocabulary is searchable to its last sentence", async () => {
    const owner = await user();
    const prose = longProse(299_000);
    expect(new Set(tokenize(prose)).size).toBeGreaterThan(30_000);
    const html = page("长文", `<p>${prose}</p><p>结尾标记词组</p>`);
    const { site } = await createSite({ mode: "paste", html }, { ownerId: owner });
    await flushTextIndexForTests();
    expect((await searchSites({ userId: owner }, "结尾标记", 10)).map((r) => r.slug)).toEqual([site.slug]);
  }, 20_000);

  it("documents: a pdf upload is searchable by its text", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "file", filename: "review.pdf", bytes: minimalPdf("Quarterly quota review") }, { ownerId: owner });
    await flushTextIndexForTests();
    expect((await searchSites({ userId: owner }, "quarterly review", 10)).map((r) => r.slug)).toEqual([site.slug]);
  });

  it.each(["read", "backfill"])("%s repairs an empty PDF index from an older extractor", async (via) => {
    const owner = await user();
    const { site } = await createSite({ mode: "file", filename: "review.pdf", bytes: minimalPdf("Recovered quarterly text") }, { ownerId: owner });
    await flushTextIndexForTests();
    await upsertSiteText({ siteId: site.id, versionId: site.currentVersionId, title: site.title,
      body: "", titleTokens: "review", bodyTokens: "", extractedAt: Date.now(), extractorVersion: 0 });
    if (via === "read") expect(await siteTextOf(site.id, site.currentVersionId)).toContain("Recovered quarterly text");
    else expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 1, remaining: 0 });
    expect((await searchSites({ userId: owner }, "recovered quarterly", 10)).map((r) => r.slug)).toEqual([site.slug]);
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 0, remaining: 0 });
  });

  it("backfill indexes sites the index never saw, freshest first, and a failed extraction is recorded rather than retried forever", async () => {
    const owner = await user();
    const siteId = createId("site"); const versionId = createId("ver");
    await writeVersionFiles(siteId, versionId, folderFiles({ "index.html": page("Old", "<p>from before the index existed</p>") }));
    await insertSiteWithVersion({ id: siteId, slug: "oldsite12345", title: "Old", kind: "single", editToken: createEditToken(), claimToken: createEditToken(), anonOwnerId: null, ownerId: owner, visibility: "private" },
      { id: versionId, siteId, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" });
    expect(await searchSites({ userId: owner }, "before", 10)).toEqual([]);
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 1, failed: 0, remaining: 0 });
    expect((await searchSites({ userId: owner }, "before", 10)).map((r) => r.slug)).toEqual(["oldsite12345"]);
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 0, remaining: 0 }); // nothing stale left

    // A version whose files are unreadable still gets a row (empty body): the worklist moves on.
    const brokenId = createId("site"); const brokenVer = createId("ver");
    await insertSiteWithVersion({ id: brokenId, slug: "brokensite01", title: "Broken", kind: "single", editToken: createEditToken(), claimToken: createEditToken(), anonOwnerId: null, ownerId: owner, visibility: "private" },
      { id: brokenVer, siteId: brokenId, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" });
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 1, failed: 0, remaining: 0 });
    expect((await getSiteText(brokenId))?.body).toBe("");
    expect(await backfillSiteTexts({ limit: 5 })).toMatchObject({ indexed: 0, remaining: 0 });
    // Still found by title — the one thing every site has.
    expect((await searchSites({ userId: owner }, "broken", 10)).map((r) => r.slug)).toEqual(["brokensite01"]);
  });
});

describe("SQLite index hygiene", () => {
  it("a hard delete of the site row takes the FTS5 row with it (trigger, not the cascade)", async () => {
    if (process.env.ARTIFACT_DB_DRIVER === "postgres") return; // a tsvector column has nothing to orphan
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Gone", "<p>orphan check</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    await closeDbForTests();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(process.env.ARTIFACT_DATA_DIR!, "sites.sqlite"));
    db.exec("PRAGMA foreign_keys = ON");
    expect((db.prepare("SELECT COUNT(*) AS n FROM site_texts_fts WHERE site_id=?").get(site.id) as { n: number }).n).toBe(1);
    db.prepare("DELETE FROM sites WHERE id=?").run(site.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM site_texts WHERE site_id=?").get(site.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM site_texts_fts WHERE site_id=?").get(site.id) as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("who finds what", () => {
  it("owner, anonymous creator, collaborator and the public each see their scope; deleted and taken-down sites drop out", async () => {
    const owner = await user("owner"); const other = await user("other"); const editor = await user("editor");
    const mine = await createSite({ mode: "paste", html: page("Mine", "<p>zebra notes</p>") }, { ownerId: owner });
    const anon = await createSite({ mode: "paste", html: page("Anon", "<p>zebra sketch</p>") }, { anonOwnerId: "anon_a" });
    const pub = await createSite({ mode: "paste", html: page("Public", "<p>zebra facts</p>") }, { ownerId: other });
    await updateSiteSharing(pub.site.id, "public", "owner");
    await addCollaborator(mine.site.id, editor);
    await flushTextIndexForTests();
    const slugs = async (viewer: Parameters<typeof searchSites>[0]) => (await searchSites(viewer, "zebra", 10)).map((r) => r.slug).sort();
    expect(await slugs(undefined)).toEqual([pub.site.slug]);
    expect(await slugs({ userId: owner })).toEqual([mine.site.slug, pub.site.slug].sort());
    expect(await slugs({ anonId: "anon_a" })).toEqual([anon.site.slug, pub.site.slug].sort());
    expect(await slugs({ userId: editor })).toEqual([mine.site.slug, pub.site.slug].sort());
    expect(await slugs({ userId: other })).toEqual([pub.site.slug]);

    await setSiteTakenDown(pub.site.id, Date.now(), "spam");
    expect(await slugs(undefined)).toEqual([]);
    expect(await slugs({ userId: other })).toEqual([pub.site.slug]); // the owner still sees their own
    expect((await searchSites({ userId: other }, "zebra", 10))[0].takenDownAt).toBeTypeOf("number"); // and is told why opening it will answer 410
    await deleteSite(mine.site.slug);
    expect(await slugs({ userId: owner })).toEqual([]);
  });
});

describe("GET /api/search", () => {
  it("validates q and limit, and scopes by the bearer", async () => {
    expect((await search("")).status).toBe(400);
    expect((await search("x".repeat(201))).status).toBe(400);
    expect((await search("ok", {}, "&limit=0")).status).toBe(400);
    expect((await search("ok", {}, "&limit=51")).status).toBe(400);
    expect((await search("ok", {}, "&limit=2.5")).status).toBe(400);

    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Private plan", "<p>the giraffe budget</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    expect(await results("giraffe")).toEqual([]);
    const hits = await results("giraffe", await bearerFor(owner));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ slug: site.slug, url: `/s/${site.slug}` });
    expect(hits[0].snippet).toContain("giraffe budget");
    expect(await results("giraffe", {}, )).toEqual([]);
  });

  it("limit caps the results", async () => {
    const owner = await user();
    for (let i = 0; i < 3; i++) await createSite({ mode: "paste", html: page(`Page ${i}`, "<p>llama</p>") }, { ownerId: owner });
    await flushTextIndexForTests();
    const res = await search("llama", await bearerFor(owner), "&limit=2");
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(2);
  });
});

describe("GET /api/sites/:slug/text", () => {
  const read = (slug: string, headers: Record<string, string> = {}, query = "") =>
    TEXT(new Request(`${B}/api/sites/${slug}/text${query}`, { headers }), { params: Promise.resolve({ slug }) });

  it("plain text of the current version, gated like the site; max_chars truncates and says so", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "paste", html: page("Report", `<p>${"important ".repeat(50)}</p>`) }, { ownerId: owner });
    expect((await read(site.slug)).status).toBe(404); // private: a stranger learns nothing
    const auth = await bearerFor(owner);
    const res = await read(site.slug, auth);
    expect(res.status, await res.clone().text()).toBe(200);
    const full = (await res.json()) as { text: string; chars: number; truncated: boolean; versionId: string; file: null };
    expect(full.text.startsWith("Report\n\nimportant important")).toBe(true);
    expect(full.truncated).toBe(false);
    expect(full.file).toBeNull();
    expect((full as unknown as { url: string }).url).toBe(`/s/${site.slug}`);
    expect(full.versionId).toBe((await getSiteBySlug(site.slug))!.currentVersionId);
    const cut = (await (await read(site.slug, auth, "?max_chars=20")).json()) as { text: string; chars: number; truncated: boolean };
    expect(cut.text).toHaveLength(20);
    // A cut that lands inside a surrogate pair steps back rather than emitting half a character.
    const emoji = await createSite({ mode: "paste", html: page("E", "<p>😀😀😀</p>") }, { ownerId: owner });
    const half = (await (await read(emoji.site.slug, auth, "?max_chars=4")).json()) as { text: string };
    expect(half.text).toBe("E\n\n"); // "E" + blank line = 3 units; the 4th would split the first emoji
    expect(cut.truncated).toBe(true);
    expect(cut.chars).toBe(full.chars);
    expect((await read(site.slug, auth, "?max_chars=0")).status).toBe(400);
    expect((await read("nosuchslug00", auth)).status).toBe(404);
  });

  it("serves the text before the index has caught up (extracts on the spot)", async () => {
    const owner = await user();
    const siteId = createId("site"); const versionId = createId("ver");
    await writeVersionFiles(siteId, versionId, folderFiles({ "index.html": page("Fresh", "<p>not yet indexed</p>") }));
    await insertSiteWithVersion({ id: siteId, slug: "freshsite001", title: "Fresh", kind: "single", editToken: createEditToken(), claimToken: createEditToken(), anonOwnerId: null, ownerId: owner, visibility: "public" },
      { id: versionId, siteId, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" });
    expect(await getSiteText(siteId)).toBeNull();
    const body = (await (await read("freshsite001")).json()) as { text: string };
    expect(body.text).toContain("not yet indexed");
    expect((await getSiteText(siteId))?.versionId).toBe(versionId); // and it is stored on the way out
  });

  it("?file returns one file verbatim — text types only, 404 when absent", async () => {
    const owner = await user();
    const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": page("App", "<p>ui</p>"), "app.js": "console.log('hi')", "logo.png": "\x89PNG" }) }, { ownerId: owner });
    await updateSiteSharing(site.id, "public", "owner");
    const js = (await (await read(site.slug, {}, "?file=app.js")).json()) as { text: string; file: string };
    expect(js).toMatchObject({ file: "app.js", text: "console.log('hi')" });
    expect((await read(site.slug, {}, "?file=logo.png")).status).toBe(415);
    // Over the 2 MB cap: refused from the range read's total, never read whole.
    const storage = getStorage();
    const big = await createSite({ mode: "folder", files: folderFiles({ "index.html": page("Big", "<p>x</p>"), "data.csv": "a,b\n".repeat(600_000) }) }, { ownerId: owner });
    await updateSiteSharing(big.site.id, "public", "owner");
    const readSpy = vi.spyOn(storage, "read");
    try {
      expect((await read(big.site.slug, {}, "?file=data.csv")).status).toBe(413);
      expect(readSpy).not.toHaveBeenCalled();
    } finally { readSpy.mockRestore(); }
    expect((await read(site.slug, {}, "?file=missing.txt")).status).toBe(404);
    expect((await read(site.slug, {}, "?file=../index.html")).status).toBe(404);
  });
});
