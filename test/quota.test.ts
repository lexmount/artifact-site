// Per-owner caps and the anonymous-site clock. Caps are checked at every path that adds a site
// or a version — one test per path, so a new write route cannot slip past them unnoticed — and
// against stored usage, so deleted sites stop counting as sites but their versions still count
// as bytes until purged. SQLite here; the CI integration job runs this file on Postgres too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSiteBySlug, ownerUsage, restoreDeletedSite, setSiteOwnerIfUnowned, upsertUser, listAdminLog } from "@/lib/db";
import { createSite, deleteSite, editSite, forkSite, getSiteView, replaceSiteContent, rollbackTo } from "@/lib/sites";
import { anonymousExpiresAt, assertQuotaRoom } from "@/lib/quota";
import { expireAnonymousSitesJob, purgeDeletedSites } from "@/lib/admin";
import { QuotaExceededError } from "@/lib/errors";
import { POST as CREATE } from "@/app/api/sites/route";
import { GET as SITE_GET } from "@/app/api/sites/[slug]/route";
import { POST as OPEN_UPLOAD } from "@/app/api/uploads/route";
import { PUT as PUT_FILE } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { POST as COMMIT } from "@/app/api/uploads/[versionId]/commit/route";
import { POST as MAINTENANCE } from "@/app/api/admin/maintenance/route";
import { getUploadSession, resetUploadSessionsForTests } from "@/lib/upload-session";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { folderFiles, testAudit } from "./helpers";

const dirs: string[] = [];
const ENV = ["ARTIFACT_QUOTA_SITES_PER_USER", "ARTIFACT_QUOTA_BYTES_PER_USER", "ARTIFACT_QUOTA_SITES_PER_ANON", "ARTIFACT_QUOTA_BYTES_PER_ANON", "ARTIFACT_ANON_SITE_TTL_DAYS", "PUBLISH_API_TOKEN"];

async function resetPostgres(): Promise<void> {
  if (process.env.ARTIFACT_DB_DRIVER !== "postgres") return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  try { await pool.query("TRUNCATE users, sites, admin_log, publish_tokens, sessions, upload_sessions CASCADE"); }
  catch (error) { if ((error as { code?: string }).code !== "42P01") throw error; }
  finally { await pool.end(); }
}

beforeEach(async () => {
  await resetPostgres();
  const dir = mkdtempSync(join(tmpdir(), "quota-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  __resetRateLimitForTests();
});
afterEach(async () => {
  await resetUploadSessionsForTests();
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["ARTIFACT_DATA_DIR", ...ENV]) delete process.env[key];
});

const html = (n: number) => `<title>q</title><body>${"x".repeat(n)}</body>`;
const user = async (subject = "u1") => (await upsertUser({ authProvider: "t", providerSubject: subject, email: `${subject}@example.net`, emailVerified: true })).id;
const quota = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(QuotaExceededError);

describe("unlimited by default", () => {
  it("no cap set: any number of sites, any size, and no expiry date", async () => {
    const owner = await user();
    for (let i = 0; i < 5; i++) await createSite({ mode: "paste", html: html(10_000) }, { ownerId: owner });
    expect((await ownerUsage({ userId: owner })).sites).toBe(5);
    const anon = await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_x" });
    expect(anonymousExpiresAt(anon.site)).toBeNull();
    await expect(assertQuotaRoom({ userId: owner }, { sites: 1, bytes: 1e12 })).resolves.toBeUndefined();
  });
});

describe("site cap", () => {
  it("create, chunked create and fork stop at the cap; deleting a site frees a slot", async () => {
    process.env.ARTIFACT_QUOTA_SITES_PER_USER = "2";
    const owner = await user();
    const a = await createSite({ mode: "paste", html: html(10) }, { ownerId: owner });
    await createSite({ mode: "paste", html: html(10) }, { ownerId: owner });
    await quota(createSite({ mode: "paste", html: html(10) }, { ownerId: owner }));
    await quota(forkSite(a.site.slug, { ownerId: owner }));
    // A rejected create writes nothing: usage is unchanged.
    expect((await ownerUsage({ userId: owner })).sites).toBe(2);
    await deleteSite(a.site.slug);
    await expect(createSite({ mode: "paste", html: html(10) }, { ownerId: owner })).resolves.toBeTruthy();
    // The error carries the numbers a client can act on.
    try { await createSite({ mode: "paste", html: html(10) }, { ownerId: owner }); throw new Error("expected refusal"); }
    catch (e) { expect((e as QuotaExceededError).details).toEqual({ kind: "sites", limit: 2, used: 2, requested: 1 }); }
  });

  it("an anonymous browser has its own cap; a site claimed by an account leaves the browser's count", async () => {
    process.env.ARTIFACT_QUOTA_SITES_PER_ANON = "1";
    const first = await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_a" });
    await quota(createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_a" }));
    await expect(createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_b" })).resolves.toBeTruthy(); // another browser
    expect(await setSiteOwnerIfUnowned(first.site.id, await user())).toBe(true);
    await expect(createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_a" })).resolves.toBeTruthy();
  });

  it("pre-identity rows (no owner of either kind) are nobody's and never capped", async () => {
    process.env.ARTIFACT_QUOTA_SITES_PER_USER = "1";
    process.env.ARTIFACT_QUOTA_SITES_PER_ANON = "1";
    for (let i = 0; i < 3; i++) await createSite({ mode: "paste", html: html(10) }, {});
  });
});

describe("storage cap — every path that adds a version", () => {
  it("counts all versions of live and deleted-but-unpurged sites; purge frees the bytes", async () => {
    const owner = await user();
    const a = await createSite({ mode: "paste", html: html(1000) }, { ownerId: owner });
    await editSite(a.site.slug, { content: html(1000) }, testAudit());
    const before = (await ownerUsage({ userId: owner })).bytes;
    expect(before).toBeGreaterThan(2000); // two versions
    await deleteSite(a.site.slug);
    expect((await ownerUsage({ userId: owner })).bytes).toBe(before); // restorable → still stored
    expect((await ownerUsage({ userId: owner })).sites).toBe(0);
    await purgeDeletedSites({ retentionMs: 0 });
    expect((await ownerUsage({ userId: owner })).bytes).toBe(0);
  });

  it("new version (replace), edit of a single file, edit of a folder file, rollback and fork are each refused over the cap", async () => {
    process.env.ARTIFACT_QUOTA_BYTES_PER_USER = "3000";
    const owner = await user();
    const single = await createSite({ mode: "paste", html: html(1000) }, { ownerId: owner }); // ~1KB used
    // A version that fits still lands; the next one over the cap does not.
    await expect(editSite(single.site.slug, { content: html(1000) }, testAudit())).resolves.toBeTruthy(); // ~2KB used
    await quota(editSite(single.site.slug, { content: html(1500) }, testAudit()));
    await quota(replaceSiteContent(single.site.slug, { mode: "paste", html: html(1500) }, testAudit()));
    const versions = (await getSiteView(single.site.slug))!;
    await quota(rollbackTo(single.site.slug, versions.version.id, testAudit())); // a rollback is a copy → bytes
    await quota(forkSite(single.site.slug, { ownerId: owner }, testAudit()));
    // Nothing was written by the refusals: the site is still on its second version.
    const site = (await getSiteBySlug(single.site.slug))!;
    expect(site.currentVersionId).toBe(versions.version.id);

    // Folder edit: the tree is copied then measured; a refusal rolls the copy back.
    process.env.ARTIFACT_QUOTA_BYTES_PER_USER = "100000";
    const other = await user("u2");
    const folder = await createSite({ mode: "folder", files: folderFiles({ "index.html": html(40_000), "a.txt": "x" }) }, { ownerId: other });
    process.env.ARTIFACT_QUOTA_BYTES_PER_USER = "60000";
    await quota(editSite(folder.site.slug, { path: "a.txt", content: "y".repeat(10) }, testAudit())); // copy (~40KB) + 40KB used > 60KB
    expect((await ownerUsage({ userId: other })).bytes).toBeLessThan(45_000); // the rolled-back copy is not counted
  });

  it("the chunked path refuses at commit and reclaims the bytes; the one-shot route answers 403 quota_exceeded", async () => {
    process.env.ARTIFACT_QUOTA_BYTES_PER_ANON = "5000";
    const BASE = "http://localhost";
    const cookie = "ah_anon=anon_q";
    await createSite({ mode: "paste", html: html(3000) }, { anonOwnerId: "anon_q" });
    const opened = await OPEN_UPLOAD(new Request(`${BASE}/api/uploads`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "big" }) }));
    expect(opened.status).toBe(201);
    const { versionId } = (await opened.json()) as { versionId: string };
    const bytes = new TextEncoder().encode(html(4000));
    expect((await PUT_FILE(new Request(`${BASE}/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), cookie }, body: bytes }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) })).status).toBe(200);
    const done = await COMMIT(new Request(`${BASE}/api/uploads/${versionId}/commit`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" }), { params: Promise.resolve({ versionId }) });
    expect(done.status).toBe(403);
    expect(((await done.json()) as { code: string }).code).toBe("quota_exceeded");
    expect(await getUploadSession(versionId)).toBeNull(); // reclaimed with its bytes

    const res = await CREATE(new Request(`${BASE}/api/sites`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ mode: "paste", html: html(4000) }) }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; details: { kind: string; limit: number } };
    expect(body.code).toBe("quota_exceeded");
    expect(body.details).toMatchObject({ kind: "bytes", limit: 5000 });
    expect(body.error).toMatch(/Storage limit/);
  });
});

describe("anonymous-site expiry", () => {
  it("only unclaimed anonymous sites past the clock go; owned, claimed, fresh and pre-identity sites stay; the removal is a normal delete", async () => {
    process.env.ARTIFACT_ANON_SITE_TTL_DAYS = "1";
    const day = 86_400_000;
    const owner = await user();
    // `old` is created first; everything else a few ms later, so a clock placed between the two
    // timestamps separates "past the TTL" from "not yet" without touching the rows.
    const old = await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_old" });
    await new Promise((r) => setTimeout(r, 10));
    const claimed = await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_claimed" });
    await setSiteOwnerIfUnowned(claimed.site.id, owner);
    const owned = await createSite({ mode: "paste", html: html(10) }, { ownerId: owner });
    const legacy = await createSite({ mode: "paste", html: html(10) }, {});
    const fresh = await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_fresh" });
    // The creator sees the date, the API too; owned sites have no clock.
    expect(anonymousExpiresAt(old.site)).toBe(old.site.updatedAt + day);
    expect(anonymousExpiresAt(owned.site)).toBeNull();
    const api = (await (await SITE_GET(new Request(`http://localhost/api/sites/${fresh.site.slug}`), { params: Promise.resolve({ slug: fresh.site.slug }) })).json()) as { site: { expiresAt: number | null } };
    expect(api.site.expiresAt).toBe(fresh.site.updatedAt + day);

    const ttl = day;
    const now = fresh.site.updatedAt + ttl; // cutoff = fresh.updatedAt exactly: `old` is older, `fresh` is not
    const result = await expireAnonymousSitesJob({ now, ttlMs: ttl });
    expect(result.expired).toBe(1);
    expect((await getSiteBySlug(old.site.slug))!.deletedAt).not.toBeNull();
    for (const s of [claimed, owned, legacy, fresh]) expect((await getSiteBySlug(s.site.slug))!.deletedAt).toBeNull();
    // Logged as the system, with the count.
    const log = await listAdminLog({ targetId: "expire-anonymous" });
    expect(log[0]).toMatchObject({ action: "maintenance.expire_anonymous", actorKind: "system" });
    expect(log[0].reason).toMatch(/^1 site/);
    // An expired site is an ordinary delete: restorable, then purged like any other — and a
    // restore resets the clock (updated_at moves to the restore), so the next tick does not take
    // it straight back, however long the administrator waited.
    expect((await getSiteBySlug(old.site.slug))!.purgedAt).toBeNull();
    expect(await restoreDeletedSite(old.site.id)).toBe(true);
    const restored = (await getSiteBySlug(old.site.slug))!;
    expect(restored.deletedAt).toBeNull();
    expect(anonymousExpiresAt(restored)).toBe(restored.updatedAt + day);
    // A run just short of the restored site's new deadline leaves it alone (`fresh`, whose clock
    // started at creation, is older by now and may go — that is not what this asserts).
    await expireAnonymousSitesJob({ now: restored.updatedAt + ttl - 1, ttlMs: ttl });
    expect((await getSiteBySlug(old.site.slug))!.deletedAt).toBeNull();
    // Off = no-op, whatever the age.
    delete process.env.ARTIFACT_ANON_SITE_TTL_DAYS;
    expect(await expireAnonymousSitesJob({ now: now + 100 * day })).toEqual({ expired: 0 });
  });

  it("the maintenance route runs it on demand, attributed to the administrator", async () => {
    process.env.ARTIFACT_ANON_SITE_TTL_DAYS = "1";
    process.env.PUBLISH_API_TOKEN = "api-token";
    await createSite({ mode: "paste", html: html(10) }, { anonOwnerId: "anon_r" });
    // Nothing is old enough yet.
    const res = await MAINTENANCE(new Request("http://localhost/api/admin/maintenance", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-token" }, body: JSON.stringify({ task: "expire-anonymous" }) }));
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ task: "expire-anonymous", result: { expired: 0 } });
  });
});
