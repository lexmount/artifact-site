// Integration test against a REAL Postgres. Skipped unless ARTIFACT_DATABASE_URL is set, so it
// never runs in CI. Run manually:
//   ARTIFACT_DATABASE_URL=postgres://user:pw@host:5432/db?sslmode=disable \
//   npx vitest run test/db-postgres.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "@/lib/db-postgres";
import { createEditToken, SlugConflictError } from "@/lib/db";

const live = Boolean(process.env.ARTIFACT_DATABASE_URL);
const S = "site_pgit";
const V1 = "ver_pgit_1";
const V2 = "ver_pgit_2";

async function hardDelete(): Promise<void> {
  if (!live) return;
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  await pool.query("DELETE FROM sites WHERE id = $1", [S]).catch(() => {});
  await pool.end();
}

describe.skipIf(!live)("PostgresStore — live round-trip", () => {
  const store = live ? new PostgresStore() : (null as unknown as PostgresStore);

  beforeAll(async () => {
    await store.init();
    await hardDelete();
  });
  afterAll(async () => {
    await hardDelete();
    await store.close();
  });

  it("atomically appends upload chunks across concurrent requests", async () => {
    const versionId = "ver_mcp_cas_test";
    await store.insertUploadSession({ versionId, siteId: "site_mcp_cas_test", targetSlug: "ver_mcp_parent_test", title: null, ownerKey: "u:test", files: [], createdAt: Date.now() });
    try {
      expect((await store.listUploadSessionsForTarget("u:test", "ver_mcp_parent_test")).map(s => s.versionId)).toEqual([versionId]);
      expect(await store.listUploadSessionsForTarget("u:other", "ver_mcp_parent_test")).toEqual([]);
      expect(await store.listUploadSessionsForTarget("u:test", "other-parent")).toEqual([]);
      const results = await Promise.all([
        store.compareUploadSessionFiles(versionId, [], [{ relpath: "a", bytes: 1 }]),
        store.compareUploadSessionFiles(versionId, [], [{ relpath: "b", bytes: 1 }]),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const files = (await store.getUploadSession(versionId))!.files;
      expect(files).toHaveLength(1);
      const reordered = files.map(({ relpath, bytes }) => ({ bytes, relpath }));
      expect(await store.compareUploadSessionFiles(versionId, reordered, [])).toBe(true);
    } finally { await store.deleteUploadSession(versionId); }
  });

  it("insert/get/version/list/count/rename/token/soft-delete round-trip", async () => {
    await store.insertSite({ id: S, slug: "pgit-slug", title: "PG It", kind: "folder", editToken: "tok0", visibility: "public" });
    expect((await store.getSiteBySlug("pgit-slug"))?.id).toBe(S);
    expect((await store.getSite(S))?.title).toBe("PG It");
    expect(typeof (await store.getSite(S))?.createdAt).toBe("number"); // BIGINT parsed to Number

    await store.insertVersion({ id: V1, siteId: S, entry: "index.html", fileCount: 2, byteSize: 100, source: "upload" });
    await store.setCurrentVersion(S, V1);
    await new Promise((r) => setTimeout(r, 5));
    await store.insertVersion({ id: V2, siteId: S, entry: "index.html", fileCount: 3, byteSize: 200, source: "edit" });
    await store.setCurrentVersion(S, V2);

    const versions = await store.listVersions(S);
    expect(versions.map((v) => v.id)).toEqual([V2, V1]); // newest first
    expect(versions[0].fileCount).toBe(3);
    expect(versions[0].byteSize).toBe(200);
    expect(await store.countVersions(S)).toBe(2);

    const summaries = await store.listSiteSummaries();
    const mine = summaries.find((s) => s.slug === "pgit-slug");
    expect(mine?.versionCount).toBe(2);
    expect(mine?.entry).toBe("index.html");

    await store.updateSiteTitle(S, "PG Renamed");
    expect((await store.getSite(S))?.title).toBe("PG Renamed");

    await store.setEditToken(S, "");
    const fixed = await store.backfillEditTokens();
    expect(fixed).toBeGreaterThanOrEqual(1);
    expect((await store.getSite(S))?.editToken).not.toBe("");

    await store.softDeleteSite(S);
    expect((await store.getSite(S))?.deletedAt).not.toBeNull();
    expect((await store.listSiteSummaries()).some((s) => s.slug === "pgit-slug")).toBe(false); // deleted → excluded
  });

  it("atomic composites: insertSiteWithVersion (+ slug conflict) and addVersionAsCurrent", async () => {
    const S2 = "site_pgit2";
    await new Promise<void>((res) => { void hardDelete2(S2).then(() => res()); });
    try {
      await store.insertSiteWithVersion(
        { id: S2, slug: "pgit2-slug", title: "Atomic", kind: "single", editToken: "t", visibility: "public" },
        { id: `${S2}_v1`, siteId: S2, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" },
      );
      expect((await store.getSiteBySlug("pgit2-slug"))?.currentVersionId).toBe(`${S2}_v1`);

      // duplicate slug → SlugConflictError
      await expect(store.insertSiteWithVersion(
        { id: "site_pgit2b", slug: "pgit2-slug", title: "Dup", kind: "single", editToken: "t", visibility: "public" },
        { id: "site_pgit2b_v", siteId: "site_pgit2b", entry: "index.html", fileCount: 1, byteSize: 1, source: "upload" },
      )).rejects.toBeInstanceOf(SlugConflictError);

      // addVersionAsCurrent advances a live site, refuses a soft-deleted one
      expect(await store.addVersionAsCurrent(S2, { id: `${S2}_v2`, siteId: S2, entry: "index.html", fileCount: 1, byteSize: 20, source: "edit" })).toBe(true);
      expect((await store.getSite(S2))?.currentVersionId).toBe(`${S2}_v2`);
      await store.softDeleteSite(S2);
      expect(await store.addVersionAsCurrent(S2, { id: `${S2}_v3`, siteId: S2, entry: "index.html", fileCount: 1, byteSize: 1, source: "edit" })).toBe(false);
      expect(await store.getVersion(`${S2}_v3`)).toBeNull();
    } finally {
      await hardDelete2(S2);
    }
  });

  // The visibility predicate is the one piece of listSiteSummaries written twice in two dialects
  // (COALESCE + two OR arms + NULL-degrades-to-stranger). test/visibility.test.ts pins the
  // behaviour on SQLite; this is the same contract asserted against the driver that actually runs
  // in production, where a `$1`/`?` or NULL-semantics slip would otherwise never surface.
  it("listSiteSummaries hides unlisted rows from a stranger and keeps them for their owner", async () => {
    const S3 = "site_pgit3";
    const user = await store.upsertUser({ authProvider: "t", providerSubject: `pgit-${Date.now()}` });
    try {
      await store.insertSiteWithVersion(
        { id: S3, slug: "pgit3-slug", title: "Hidden", kind: "single", editToken: "t", anonOwnerId: "anon_pgit", visibility: "public" },
        { id: `${S3}_v1`, siteId: S3, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" },
      );
      const listed = async (viewer?: { userId?: string | null; anonId?: string | null }) =>
        (await store.listSiteSummaries(viewer)).some((s) => s.slug === "pgit3-slug");

      expect(await listed()).toBe(true); // public by default → in the directory

      await store.updateSiteSharing(S3, "unlisted", "owner");
      expect(await listed()).toBe(false); // stranger: gone
      expect(await listed({})).toBe(false); // blank viewer is a stranger, not a wildcard
      expect(await listed({ anonId: "anon_pgit" })).toBe(true); // creating browser: still mine
      expect(await listed({ anonId: "anon_other" })).toBe(false);
      expect(await listed({ userId: user.id })).toBe(false); // not the owner

      // Claiming moves the exception from the browser to the account.
      expect(await store.setSiteOwnerIfUnowned(S3, user.id)).toBe(true);
      expect(await listed({ anonId: "anon_pgit" })).toBe(false);
      expect(await listed({ userId: user.id })).toBe(true);
      // …and the owner view never filtered in the first place.
      expect((await store.listSitesByOwner(user.id)).some((s) => s.slug === "pgit3-slug")).toBe(true);

      // A collaborator gets the same exception: this list doubles as "which sites still exist" for
      // the home page's prune passes, so leaving them out silently drops their recent-shelf entry.
      const mate = await store.upsertUser({ authProvider: "t", providerSubject: `pgit-mate-${Date.now()}` });
      expect(await listed({ userId: mate.id })).toBe(false); // not yet granted
      await store.addCollaborator(S3, mate.id, user.id);
      expect(await listed({ userId: mate.id })).toBe(true);

      await store.updateSiteSharing(S3, "public", "owner");
      expect(await listed()).toBe(true); // flipping back re-lists it
    } finally {
      await hardDelete2(S3);
    }
  });

  // The SQLite suite proves the same-millisecond ordering contract on its own side; the Postgres
  // half of it (audit_log.seq) can only be proven here, against a real server. audit_log has no FK
  // to sites, so the rows stand alone and are cleaned up by hand.
  it("orders same-millisecond audit rows by insert — the SQLite backend's answer", async () => {
    const SA = "site_pgit_audit";
    // Not in lexicographic order: an implementation tiebreaking on the (random) id column would
    // return a visibly different sequence rather than accidentally agreeing.
    const ids = ["aud_pgit_c", "aud_pgit_a", "aud_pgit_h", "aud_pgit_d", "aud_pgit_b"];
    const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
    try {
      await pool.query("DELETE FROM audit_log WHERE site_id = $1", [SA]);
      for (const id of ids) {
        await pool.query(
          `INSERT INTO audit_log (id, site_id, version_id, action, editor_kind, actor_user_id,
             actor_anon_id, method, ip, user_agent, created_at)
           VALUES ($1, $2, NULL, 'share', 'anon', NULL, NULL, NULL, NULL, NULL, $3)`,
          [id, SA, 1_700_000_000_000], // one identical created_at for every row
        );
      }

      const rows = await store.listAudit(SA);
      expect(new Set(rows.map((r) => r.createdAt)).size).toBe(1); // they really are tied
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse()); // newest insert first
      expect(rows.map((r) => r.id)).not.toEqual([...ids].sort().reverse()); // …and not id order
      expect((await store.listAudit(SA)).map((r) => r.id)).toEqual(rows.map((r) => r.id)); // stable
    } finally {
      await pool.query("DELETE FROM audit_log WHERE site_id = $1", [SA]).catch(() => {});
      await pool.end();
    }
  });

  // The share layer is written twice in two dialects, and test/share-store.test.ts only ever runs
  // the SQLite half. Several statements here have no SQLite counterpart that could fail on them:
  // ON CONFLICT against a PARTIAL unique index is refused unless the index predicate is repeated
  // ("no unique or exclusion constraint matching the ON CONFLICT specification"), a bare parameter
  // in `$n IS NOT NULL` cannot be typed by the driver without the ::text cast, and Postgres sorts
  // NULLs at the opposite end from SQLite. All three are runtime errors on a real server only.
  it("share links: round-trip, live filter, grants, admits, views", async () => {
    const SS = "site_pgit_share";
    const T = 1_700_000_000_000;
    const stamp = Date.now();
    await hardDeleteShare(SS);
    const owner = await store.upsertUser({ authProvider: "t", providerSubject: `pgit-sh-own-${stamp}`, displayName: "站长" });
    const invited = await store.upsertUser({ authProvider: "t", providerSubject: `pgit-sh-inv-${stamp}`, displayName: "受邀的人" });
    const stranger = await store.upsertUser({ authProvider: "t", providerSubject: `pgit-sh-str-${stamp}` });
    try {
      await store.insertSiteWithVersion(
        { id: SS, slug: "pgit-share-slug", title: "Shared", kind: "single", editToken: "t", ownerId: owner.id, visibility: "public" },
        { id: `${SS}_v1`, siteId: SS, entry: "index.html", fileCount: 1, byteSize: 10, source: "upload" },
      );

      // createShare → Share, with BIGINT columns already Numbers and neither hash in the projection.
      const passcoded = await store.createShare({
        id: "shr_pgit_1", siteId: SS, tokenHash: "pgit-token-1", policy: "passcode",
        passcodeHash: "pgit-pass-1", label: "给客户的", createdBy: owner.id, createdAnonId: null, expiresAt: T,
      });
      expect(passcoded).toMatchObject({
        id: "shr_pgit_1", siteId: SS, policy: "passcode", hasPasscode: true,
        label: "给客户的", createdBy: owner.id, expiresAt: T, revokedAt: null,
      });
      expect(Object.keys(passcoded)).not.toContain("tokenHash");
      expect(Object.keys(passcoded)).not.toContain("passcodeHash");
      expect(typeof passcoded.createdAt).toBe("number");
      expect((await store.getShareByTokenHash("pgit-token-1"))?.passcodeHash).toBe("pgit-pass-1");
      expect((await store.getShare("shr_pgit_1"))?.tokenHash).toBe("pgit-token-1");
      expect(await store.getShareByTokenHash("pgit-token-nope")).toBeNull();

      // listLiveShares: revoked out, expiring-exactly-now out, NULL expiry in.
      const forever = await store.createShare({
        id: "shr_pgit_2", siteId: SS, tokenHash: "pgit-token-2", policy: "people",
        passcodeHash: null, label: null, createdBy: owner.id, createdAnonId: null, expiresAt: null,
      });
      const revoked = await store.createShare({
        id: "shr_pgit_3", siteId: SS, tokenHash: "pgit-token-3", policy: "login",
        passcodeHash: null, label: null, createdBy: null, createdAnonId: "anon_pgit", expiresAt: null,
      });
      await store.revokeShare(revoked.id, T - 1000);
      await store.revokeShare(revoked.id, T + 1000); // the first revocation's timestamp stands
      expect((await store.getShare(revoked.id))?.revokedAt).toBe(T - 1000);

      const live = (await store.listLiveShares(SS, T)).map((s) => s.id);
      expect(live).toEqual([forever.id]);
      expect((await store.listLiveShares(SS, T - 1)).map((s) => s.id).sort()).toEqual([forever.id, passcoded.id].sort());
      expect((await store.listShares(SS)).length).toBe(3); // the owner list keeps the dead ones
      expect((await store.listShares(SS)).map((s) => s.id)) // same order twice: ties broken, not left to the planner
        .toEqual((await store.listShares(SS)).map((s) => s.id));

      // updateSharePolicy assigns all three columns — null clears.
      await store.updateSharePolicy(passcoded.id, "login", null, null);
      expect(await store.getShare(passcoded.id)).toMatchObject({ policy: "login", passcodeHash: null, hasPasscode: false, expiresAt: null });

      // The AI Q&A (allowAi) flag: born false, round-trips true, and its setter touches nothing else.
      expect((await store.getShare(passcoded.id))?.allowAi).toBe(false);
      await store.setShareAllowAi(passcoded.id, true);
      expect(await store.getShare(passcoded.id)).toMatchObject({ allowAi: true, policy: "login" });

      // Grants: one ON CONFLICT per partial index, then the LEFT JOIN that keeps e-mail rows.
      await store.addShareGrant(forever.id, { userId: invited.id }, owner.id);
      await store.addShareGrant(forever.id, { userId: invited.id }, owner.id); // idempotent
      await store.addShareGrant(forever.id, { email: "Boss@Example.COM" }, owner.id);
      await store.addShareGrant(forever.id, { email: "boss@example.com" }, owner.id); // same lower(email)
      const grants = await store.listShareGrants(forever.id);
      expect(grants).toHaveLength(2);
      expect(grants.find((g) => g.userId === invited.id)?.displayName).toBe("受邀的人");
      expect(grants.find((g) => g.email != null)).toMatchObject({ userId: null, email: "Boss@Example.COM", displayName: null });
      await expect(store.addShareGrant(forever.id, {}, null)).rejects.toThrow(/exactly one/);

      // shareAdmits — the arm that must never fire without a verified address.
      expect(await store.shareAdmits(forever.id, invited.id, null)).toBe(true);
      expect(await store.shareAdmits(forever.id, stranger.id, "BOSS@EXAMPLE.COM")).toBe(true);
      expect(await store.shareAdmits(forever.id, stranger.id, null)).toBe(false);
      expect(await store.shareAdmits(forever.id, stranger.id, "")).toBe(false);
      expect(await store.shareAdmits(forever.id, stranger.id, "nobody@example.com")).toBe(false);
      await store.removeShareGrant(forever.id, { email: "BOSS@EXAMPLE.COM" }); // folds case
      expect(await store.shareAdmits(forever.id, stranger.id, "boss@example.com")).toBe(false);

      // Views: the identity ladder, then retention.
      const view = { shareId: forever.id, siteId: SS, userAgent: "UA" };
      await store.recordShareView({ ...view, userId: invited.id, anonId: null, ip: "10.0.0.1", viewedAt: T });
      await store.recordShareView({ ...view, userId: null, anonId: "anon-pgit", ip: "10.0.0.2", viewedAt: T + 1 });
      await store.recordShareView({ ...view, userId: null, anonId: null, ip: "10.0.0.3", viewedAt: T + 2 });
      expect(await store.hasRecentShareView(forever.id, invited.id, null, null, T)).toBe(true);
      expect(await store.hasRecentShareView(forever.id, invited.id, null, null, T + 1)).toBe(false);
      expect(await store.hasRecentShareView(forever.id, null, "anon-pgit", null, T)).toBe(true);
      expect(await store.hasRecentShareView(forever.id, null, null, "10.0.0.3", T)).toBe(true);
      expect(await store.hasRecentShareView(forever.id, null, null, "10.0.0.9", T)).toBe(false);
      // A present account shadows the browser and the IP, even when only they have rows.
      expect(await store.hasRecentShareView(forever.id, "usr_pgit_new", "anon-pgit", "10.0.0.3", T)).toBe(false);
      expect(await store.hasRecentShareView(forever.id, null, null, null, T)).toBe(false);

      expect((await store.listShareViews(SS, 10)).map((v) => v.viewedAt)).toEqual([T + 2, T + 1, T]);
      expect((await store.listShareViews(SS, 10))[0]).toMatchObject({ shareId: forever.id, siteId: SS, userId: null, anonId: null, ip: "10.0.0.3" });
      expect(await store.listShareViews(SS, 1)).toHaveLength(1);
      expect(await store.pruneShareViews(T + 1)).toBe(1); // strictly older than the line
      expect(await store.pruneShareViews(T + 3)).toBe(2);
      expect(await store.listShareViews(SS, 10)).toEqual([]);
    } finally {
      await hardDeleteShare(SS);
    }
  });

  it("site views: union list, identity ladder, stats with exclusions, retention", async () => {
    const SV = "site_pgit_views";
    const T = 1_700_000_000_000;
    const DAY = 86_400_000;
    await hardDeleteSiteViews(SV);
    try {
      await store.insertSite({ id: SV, slug: "pgit-views-slug", title: "PG Views", kind: "single", editToken: "tokv", visibility: "public" });
      const share = await store.createShare({
        id: "shr_pgit_views", siteId: SV, tokenHash: "th-pgit-views", policy: "public",
        passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null,
      });

      // One reader through the share link, one direct, one direct with no identity at all.
      await store.recordShareView({ shareId: share.id, siteId: SV, userId: null, anonId: "anon-pgv", ip: "10.1.0.1", userAgent: "UA", viewedAt: T });
      await store.recordSiteView({ siteId: SV, userId: null, anonId: "anon-pgv", ip: "10.1.0.1", userAgent: "UA", viewedAt: T + 1 });
      await store.recordSiteView({ siteId: SV, userId: null, anonId: null, ip: null, userAgent: null, viewedAt: T + 2 });

      // Union list: both doors, newest first, direct rows carry shareId null.
      const opens = await store.listSiteOpens(SV, 10);
      expect(opens.map((o) => o.viewedAt)).toEqual([T + 2, T + 1, T]);
      expect(opens.map((o) => o.shareId)).toEqual([null, null, share.id]);
      expect(await store.listSiteOpens(SV, 1)).toHaveLength(1);

      // Ladder (site-keyed twin of hasRecentShareView).
      expect(await store.hasRecentSiteView(SV, null, "anon-pgv", null, T)).toBe(true);
      expect(await store.hasRecentSiteView(SV, null, "anon-other", null, T)).toBe(false);
      expect(await store.hasRecentSiteView(SV, null, null, "10.1.0.1", T)).toBe(true);
      expect(await store.hasRecentSiteView(SV, null, null, null, T)).toBe(false);

      // Stats: window clips counts but not lastViewedAt; unique viewers key user→anon→ip and the
      // identity-less row counts as an open only.
      const stats = await store.getSiteViewStats(SV, T - 1, { userIds: [], anonIds: [] });
      expect(stats).toEqual({ opens: 3, uniqueViewers: 1, lastViewedAt: T + 2 });
      const clipped = await store.getSiteViewStats(SV, T + 3, { userIds: [], anonIds: [] });
      expect(clipped).toEqual({ opens: 0, uniqueViewers: 0, lastViewedAt: T + 2 });

      // Exclusion: a signed-in owner's opens vanish from all three numbers; empty list = nobody.
      await store.recordSiteView({ siteId: SV, userId: "usr_pgit_owner", anonId: null, ip: null, userAgent: null, viewedAt: T + 5 * DAY });
      const excluded = await store.getSiteViewStats(SV, T - 1, { userIds: ["usr_pgit_owner"], anonIds: [] });
      expect(excluded).toEqual({ opens: 3, uniqueViewers: 1, lastViewedAt: T + 2 });

      // Retention: strictly older than the line, and share_views is not this prune's business.
      expect(await store.pruneSiteViews(T + 2)).toBe(1); // the T+1 direct row
      expect((await store.listShareViews(SV, 10))).toHaveLength(1);
    } finally {
      await hardDeleteSiteViews(SV);
    }
  });

  it("folders: per-user shelf, cascade on delete, live-site join, assignment upsert (#35)", async () => {
    const owner = await store.upsertUser({ authProvider: "t", providerSubject: "pgit-folders", email: "pgit-folders@x.test", emailVerified: true });
    const other = await store.upsertUser({ authProvider: "t", providerSubject: "pgit-folders-2", email: "pgit-folders-2@x.test", emailVerified: true });
    const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
    try {
      await pool.query("DELETE FROM folders WHERE user_id = ANY($1)", [[owner.id, other.id]]);
      expect(await store.insertFolder({ id: "fld_pgit_a", userId: owner.id, name: "A", createdAt: 1 }, 50)).toBe(true);
      expect(await store.insertFolder({ id: "fld_pgit_b", userId: owner.id, name: "B", createdAt: 2 }, 50)).toBe(true);
      expect(await store.insertFolder({ id: "fld_pgit_c", userId: owner.id, name: "C", createdAt: 3 }, 2)).toBe(false); // cap in the statement
      expect((await store.listFolders(owner.id)).map((f) => [f.name, f.sort])).toEqual([["A", 0], ["B", 1]]);
      expect(await store.listFolders(other.id)).toEqual([]);

      // A live site of its own: the shared S is soft-deleted by the first test, and the join hides those.
      const F = "site_pgit_folders";
      await pool.query("DELETE FROM sites WHERE id = $1", [F]);
      await store.insertSite({ id: F, slug: "pgit-folders-slug", title: "Filed", kind: "single", editToken: "tokf", visibility: "public" });
      expect(await store.setFolderAssignment(owner.id, F, "fld_pgit_a", 1)).toBe(true);
      expect(await store.setFolderAssignment(owner.id, F, "fld_pgit_b", 2)).toBe(true); // upsert moves it
      expect(await store.setFolderAssignment(other.id, F, "fld_pgit_a", 3)).toBe(false); // not their folder
      const live = await store.listFolderAssignments(owner.id);
      expect(live.map((a) => [a.siteId, a.slug, a.folderId])).toEqual([[F, "pgit-folders-slug", "fld_pgit_b"]]);
      await store.softDeleteSite(F);
      expect(await store.listFolderAssignments(owner.id)).toEqual([]); // a deleted site leaves the shelf
      await pool.query("UPDATE sites SET deleted_at = NULL WHERE id = $1", [F]);
      expect(await store.listFolderAssignments(owner.id)).toHaveLength(1);
      expect(await store.renameFolder("fld_pgit_b", other.id, "hijack", 4)).toBe(false);
      expect(await store.renameFolder("fld_pgit_b", owner.id, "B2", 4)).toBe(true);
      expect(await store.deleteFolder("fld_pgit_b", owner.id)).toBe(true);
      expect(await store.listFolderAssignments(owner.id)).toEqual([]); // members un-filed with the folder
      expect((await store.listFolders(owner.id)).map((f) => f.name)).toEqual(["A"]);
      expect(await store.setFolderAssignment(owner.id, F, null, 5)).toBe(true);
    } finally {
      await pool.query("DELETE FROM folders WHERE user_id = ANY($1)", [[owner.id, other.id]]).catch(() => {});
      await pool.query("DELETE FROM sites WHERE id = $1", ["site_pgit_folders"]).catch(() => {});
      await pool.end();
    }
  });

  it("mints unguessable ids/slugs/tokens (pure helpers unaffected by backend)", () => {
    expect(createEditToken()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("site events ride NOTIFY/LISTEN across connections (the multi-replica transport)", async () => {
    // site-events picks its transport off config.dbDriver — point it at THIS server for the test.
    process.env.ARTIFACT_DB_DRIVER = "postgres";
    const { notifySiteVersion, subscribeSiteVersion, closeSiteEventsForTests } = await import("@/lib/site-events");
    try {
      const got = new Promise<{ siteId: string; versionId: string }>((resolve) => {
        subscribeSiteVersion("site_pgit_events", resolve);
      });
      // Give the lazy LISTEN connection a beat to establish before publishing.
      await new Promise((r) => setTimeout(r, 300));
      notifySiteVersion("site_pgit_events", "ver_pgit_evt");
      const event = await Promise.race([
        got,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("NOTIFY did not arrive within 3s")), 3000)),
      ]);
      expect(event).toEqual({ siteId: "site_pgit_events", versionId: "ver_pgit_evt" });
    } finally {
      await closeSiteEventsForTests();
      delete process.env.ARTIFACT_DB_DRIVER;
    }
  });
});

/** site_shares/share_grants/share_views all cascade from sites, so one DELETE clears the lot. */
async function hardDeleteShare(id: string): Promise<void> {
  if (!live) return;
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  await pool.query("DELETE FROM sites WHERE id = $1", [id]).catch(() => {});
  await pool.end();
}

/** site_views carries no FK (mirroring share_views.site_id), so the cascade above misses it. */
async function hardDeleteSiteViews(id: string): Promise<void> {
  if (!live) return;
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  await pool.query("DELETE FROM site_views WHERE site_id = $1", [id]).catch(() => {});
  await pool.query("DELETE FROM sites WHERE id = $1", [id]).catch(() => {});
  await pool.end();
}

async function hardDelete2(id: string): Promise<void> {
  if (!live) return;
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  await pool.query("DELETE FROM sites WHERE id = $1 OR id = 'site_pgit2b'", [id]).catch(() => {});
  await pool.end();
}
