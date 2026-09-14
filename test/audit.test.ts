// The audit spine: every content edit records who/when/what/how, in the version's own transaction,
// and the row is never rewritten — not even when the site is later claimed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { committed } from "./helpers";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptAnonymousSites, attributeUnattributedVersions, closeDbForTests, insertAudit, listAudit,
  setSiteOwnerIfUnowned, upsertUser,
} from "@/lib/db";
import { resolveActor } from "@/lib/authz";
import { createSite, editSite, forkSite, rollbackTo } from "@/lib/sites";
import { recordSiteAudit } from "@/lib/audit";
import { folderFiles, testAudit } from "./helpers";
import type { Viewer } from "@/lib/authz";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "ah-audit-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => { await closeDbForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.ARTIFACT_DATA_DIR; });

async function makeSite() {
  const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<title>t</title>v1" }) });
  return site;
}
const viewer = (v: Partial<Viewer>): Viewer => ({ session: null, anonId: null, isAdmin: false, editToken: "", ...v });

describe("resolveActor — strength of evidence", () => {
  it("names an admin, a user, then a browser, and falls back to legacy-token", () => {
    expect(resolveActor(viewer({ isAdmin: true }))).toMatchObject({ kind: "admin" });
    expect(resolveActor(viewer({ session: { userId: "usr_1" } as never }))).toMatchObject({ kind: "user", userId: "usr_1" });
    expect(resolveActor(viewer({ anonId: "anon_x" }))).toMatchObject({ kind: "anon", anonId: "anon_x" });
    expect(resolveActor(viewer({ editToken: "tok" }))).toMatchObject({ kind: "legacy-token" });
  });
  // A logged-in user keeps their browser id too, so a later join across the anon handle still works.
  it("records the browser id alongside a user", () => {
    expect(resolveActor(viewer({ session: { userId: "u" } as never, anonId: "a" }))).toMatchObject({ userId: "u", anonId: "a" });
  });
});

describe("audit rows for edits", () => {
  it("writes one row per edit, carrying actor, method, ip and version", async () => {
    const site = await makeSite();
    const r = committed(await editSite(site.slug, { path: "index.html", content: "v2" },
      testAudit({ actor: { kind: "user", userId: "usr_42", anonId: "anon_9" }, method: "visual", ip: "10.0.0.3", userAgent: "UA/1" })));
    const rows = await listAudit(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      siteId: site.id, versionId: r!.version.id, action: "edit",
      editorKind: "user", actorUserId: "usr_42", actorAnonId: "anon_9", method: "visual", ip: "10.0.0.3",
    });
  });

  it("records an anonymous editor by their browser handle, with no user id", async () => {
    const site = await makeSite();
    await editSite(site.slug, { path: "index.html", content: "v2" },
      testAudit({ actor: { kind: "anon", userId: null, anonId: "anon_browser" } }));
    const [row] = await listAudit(site.id);
    expect(row).toMatchObject({ editorKind: "anon", actorUserId: null, actorAnonId: "anon_browser" });
  });

  // The failure this prevents: a version committed while its audit row was lost, leaving an
  // un-attributable edit. The row shares the version transaction, so the count tracks the edits.
  it("keeps the audit count in step with the versions produced", async () => {
    const site = await makeSite();
    await editSite(site.slug, { path: "index.html", content: "a" }, testAudit());
    await editSite(site.slug, { path: "index.html", content: "b" }, testAudit());
    expect(await listAudit(site.id)).toHaveLength(2);
  });

  // The whole reason audit_log exists instead of versions.created_by: claiming a site backfills
  // created_by, which would rewrite every anonymous edit to look like the claimant's. The audit
  // trail must be untouched by that — "it was anonymous at the time" stays true.
  it("is not rewritten when the site is later claimed", async () => {
    const site = await makeSite();
    await editSite(site.slug, { path: "index.html", content: "v2" },
      testAudit({ actor: { kind: "anon", userId: null, anonId: "anon_creator" } }));
    const before = await listAudit(site.id);

    const user = await upsertUser({ authProvider: "t", providerSubject: "claimant" });
    await setSiteOwnerIfUnowned(site.id, user.id);
    await attributeUnattributedVersions(site.id, user.id); // backfills versions.created_by
    await adoptAnonymousSites("anon_creator", user.id);

    expect(await listAudit(site.id)).toEqual(before); // byte-for-byte unchanged
  });
});

describe("audit coverage for the other actions", () => {
  it("records create, fork and rollback as version-producing rows", async () => {
    const { site, version } = await createSite(
      { mode: "folder", files: folderFiles({ "index.html": "<title>t</title>a" }) },
      {},
      testAudit(),
    );
    expect((await listAudit(site.id)).map((r) => r.action)).toEqual(["create"]);

    const forked = await forkSite(site.slug, {}, testAudit());
    expect((await listAudit(forked!.site.id)).map((r) => r.action)).toEqual(["fork"]); // the fork's own birth row

    await editSite(site.slug, { path: "index.html", content: "b" }, testAudit());
    await rollbackTo(site.slug, version.id, testAudit());
    // create, edit, rollback — newest first
    expect((await listAudit(site.id)).map((r) => r.action)).toEqual(["rollback", "edit", "create"]);
  });

  it("records rename / delete / share as best-effort rows with a null version", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>t</title>x" });
    await recordSiteAudit(site.id, "rename", testAudit());
    await recordSiteAudit(site.id, "share", testAudit());
    const rows = await listAudit(site.id);
    expect(rows.map((r) => r.action).sort()).toEqual(["rename", "share"]);
    expect(rows.every((r) => r.versionId === null)).toBe(true);
  });
});

// created_at is a millisecond stamp off the app clock, and a plain create+edit+rollback burst was
// measured putting 2 of its 3 rows in the SAME millisecond. `ORDER BY created_at DESC` alone then
// has nothing left to order those rows by, so the engine returns them in whatever order it likes:
// possibly different between two runs of the same query, and possibly different from what the other
// backend returns for identical data. Both backends therefore tiebreak on their monotonic insert
// counter — Postgres audit_log.seq, SQLite's implicit rowid.
describe("audit ordering — deterministic inside one millisecond", () => {
  // Deliberately NOT in lexicographic order, so an implementation that tiebreaks on `id` (which is
  // `aud_<randomUUID>`: stable to sort by, but an arbitrary order that reflects nothing) produces a
  // visibly different answer instead of accidentally passing.
  const ids = ["aud_c", "aud_a", "aud_h", "aud_d", "aud_b", "aud_g", "aud_e", "aud_f"];
  const newestFirst = [...ids].reverse();

  /** Insert every id with the clock frozen, so all rows land on one created_at. */
  async function seedOneMillisecond(siteId: string): Promise<void> {
    // Date.now only — not vi.useFakeTimers(), whose stopped timers would hang the async fs work.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      for (const id of ids) {
        await insertAudit({
          id, siteId, versionId: null, action: "share", editorKind: "anon",
          actorUserId: null, actorAnonId: null, method: null, ip: null, userAgent: null,
        });
      }
    } finally {
      clock.mockRestore();
    }
  }

  it("returns equal timestamps newest-insert-first, not in id order", async () => {
    const site = await makeSite();
    await seedOneMillisecond(site.id);
    const rows = await listAudit(site.id);

    // The premise of the whole test: these really are tied on created_at.
    expect(new Set(rows.map((r) => r.createdAt)).size).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(newestFirst);
    // …and that answer is not one a lexicographic tiebreak could have produced.
    expect(newestFirst).not.toEqual([...ids].sort().reverse());
  });

  it("gives the identical order on every repeat of the same query", async () => {
    const site = await makeSite();
    await seedOneMillisecond(site.id);
    const first = (await listAudit(site.id)).map((r) => r.id);
    for (let i = 0; i < 5; i++) {
      expect((await listAudit(site.id)).map((r) => r.id)).toEqual(first);
    }
  });
});

describe("audit ordering — parity between the two backends", () => {
  // A real Postgres cannot be opened here (same constraint test/schema-parity.test.ts works under),
  // so its query is compared as source text. The drift this catches is the likely one: a tiebreak
  // added to one backend and forgotten on the other, which no SQLite-only suite would ever notice.
  function auditOrderBy(file: string): string {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const match = source.match(/SELECT \* FROM audit_log WHERE site_id=(?:\$1|\?) ORDER BY (.+?) LIMIT/);
    if (!match) throw new Error(`${file}: 没找到 audit_log 的列表查询`);
    return match[1];
  }

  it("sorts on created_at first, so idx_audit_site (site_id, created_at DESC) still drives the scan", () => {
    for (const file of ["src/lib/db-postgres.ts", "src/lib/db-sqlite.ts"]) {
      expect(auditOrderBy(file).split(",").map((k) => k.trim())[0]).toBe("created_at DESC");
    }
  });

  it("tiebreaks on each backend's monotonic insert counter — never on the random id", () => {
    // seq (BIGSERIAL) and rowid are the same thing in two dialects: a counter that increments per
    // insert. Ordering by them yields insert order on BOTH sides, which is what makes the two
    // backends agree row for row. `id` would be stable but arbitrary, and would agree with nothing.
    expect(auditOrderBy("src/lib/db-postgres.ts")).toBe("created_at DESC, seq DESC");
    expect(auditOrderBy("src/lib/db-sqlite.ts")).toBe("created_at DESC, rowid DESC");
  });
});
