import { config } from "@/lib/config";
import { flushTextIndexForTests } from "@/lib/site-text";
// The administration API: who gets in, what each act does to the rest of the system, and that
// every act leaves a row behind. SQLite backend; https requests because __Host- cookies need it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rbacQuery, closeDbForTests, getSiteBySlug, insertPublishToken, listAdminLog, listSitesByOwner, updateSiteSharing, upsertUser } from "@/lib/db";
import { readAccess } from "@/lib/share";
import { flushAfterResponseForTests } from "@/lib/after-response";
import SitePage from "@/app/s/[slug]/page";
import { createSite, deleteSite, getSiteView, listSites } from "@/lib/sites";
import { mintSession, resolveSession } from "@/lib/session";
import { hashTokenSecret } from "@/lib/publish-token";
import { getStorage } from "@/lib/storage";
import { purgeDeletedSites } from "@/lib/admin";
import { GET as OVERVIEW } from "@/app/api/admin/overview/route";
import { GET as USERS } from "@/app/api/admin/users/route";
import { PATCH as PATCH_USER } from "@/app/api/admin/users/[id]/route";
import { GET as SITES } from "@/app/api/admin/sites/route";
import { PATCH as PATCH_SITE, DELETE as DELETE_SITE } from "@/app/api/admin/sites/[slug]/route";
import { GET as LOG } from "@/app/api/admin/log/route";
import { POST as MAINTENANCE } from "@/app/api/admin/maintenance/route";
import { GET as ME } from "@/app/api/auth/me/route";
import { GET as SITE_GET, PATCH as SITE_PATCH } from "@/app/api/sites/[slug]/route";
import { GET as VERSIONS } from "@/app/api/sites/[slug]/versions/route";
import { GET as ACTIVITY } from "@/app/api/sites/[slug]/admin-activity/route";
import { GET as PREVIEW } from "@/app/api/preview/[slug]/[[...path]]/route";

const ORIGIN = "https://x";
const dirs: string[] = [];

// The site page reads its request from next/headers, which only exists inside a Next request
// scope; the page tests hand it a bag built from whatever cookie the test wants to present.
let headerCookie = "";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "x", "x-forwarded-proto": "https", cookie: headerCookie }),
}));

// Opted into Postgres (ARTIFACT_DB_DRIVER=postgres + ARTIFACT_DATABASE_URL, as the integration
// job does)? The rows then outlive a test, so the tables this file counts are emptied first.
async function resetPostgres(): Promise<void> {
  if (process.env.ARTIFACT_DB_DRIVER !== "postgres") return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  try {
    await pool.query("TRUNCATE users, sites, admin_log, publish_tokens, sessions CASCADE");
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error; // a fresh database: nothing to empty yet
  } finally {
    await pool.end();
  }
}

beforeEach(async () => {
  await resetPostgres();
  const dir = mkdtempSync(join(tmpdir(), "admin-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_ADMIN_EMAILS = "Admin@Example.net, second@example.net";
  process.env.PUBLISH_API_TOKEN = "api-token";
  // Ownership enforcement (needs an IdP configured) so "owner" means the account, not a legacy token.
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
});

afterEach(async () => {
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["ARTIFACT_DATA_DIR", "ARTIFACT_ADMIN_EMAILS", "PUBLISH_API_TOKEN", "ARTIFACT_ENFORCE_OWNERSHIP",
    "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET", "ARTIFACT_DELETED_RETENTION_DAYS"]) delete process.env[key];
});

type H = Record<string, string>;
const secure: H = { "x-forwarded-proto": "https" };
const req = (path: string, init: { method?: string; headers?: H; body?: unknown } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { ...secure, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

/** A signed-in account: returns the cookie header value and the user. */
async function person(email: string, subject = email, verified = true) {
  const user = await upsertUser({ authProvider: "t", providerSubject: subject, email, emailVerified: verified, displayName: email.split("@")[0] });
  const { cookie } = await mintSession(req("/"), user.id);
  return { user, cookie: cookie.split(";")[0] };
}
const asCookie = (cookie: string, origin = true): H => ({ cookie, ...(origin ? { origin: ORIGIN } : {}) });
const asToken: H = { authorization: "Bearer api-token" };

describe("who is an administrator", () => {
  it("nobody by default; the API token; a signed-in account whose VERIFIED e-mail is listed (case-insensitively)", async () => {
    expect((await OVERVIEW(req("/api/admin/overview"))).status).toBe(401);
    expect((await OVERVIEW(req("/api/admin/overview", { headers: asToken }))).status).toBe(200);
    const admin = await person("admin@example.net");
    expect((await OVERVIEW(req("/api/admin/overview", { headers: asCookie(admin.cookie) }))).status).toBe(200);
    const member = await person("member@example.net");
    expect((await OVERVIEW(req("/api/admin/overview", { headers: asCookie(member.cookie) }))).status).toBe(401);
    const unverified = await person("second@example.net", "second-unverified", false);
    expect((await OVERVIEW(req("/api/admin/overview", { headers: asCookie(unverified.cookie) }))).status).toBe(401);
  });

  it("a publish token of an administrator's account is NOT an administrator", async () => {
    const admin = await person("admin@example.net");
    await insertPublishToken({ id: hashTokenSecret("ahp_agent-secret"), userId: admin.user.id, name: "agent", createdAt: Date.now() });
    expect((await OVERVIEW(req("/api/admin/overview", { headers: { authorization: "Bearer ahp_agent-secret" } }))).status).toBe(401);
  });

  it("/api/auth/me reports isAdmin, and the write routes demand an Origin from cookie administrators only", async () => {
    const admin = await person("admin@example.net");
    const member = await person("member@example.net");
    expect(((await (await ME(req("/api/auth/me", { headers: { cookie: admin.cookie } }))).json()) as { isAdmin: boolean }).isAdmin).toBe(true);
    expect(((await (await ME(req("/api/auth/me", { headers: { cookie: member.cookie } }))).json()) as { isAdmin: boolean }).isAdmin).toBe(false);
    const body = { disabled: true, reason: "spam" };
    expect((await PATCH_USER(req(`/api/admin/users/${member.user.id}`, { method: "PATCH", headers: asCookie(admin.cookie, false), body }), params({ id: member.user.id }))).status).toBe(401);
    expect((await PATCH_USER(req(`/api/admin/users/${member.user.id}`, { method: "PATCH", headers: asCookie(admin.cookie), body }), params({ id: member.user.id }))).status).toBe(200);
  });
});

describe("disabling an account", () => {
  it("revokes every session and publish token, refuses self and other administrators, requires a reason, and is logged", async () => {
    const admin = await person("admin@example.net");
    const second = await person("second@example.net");
    const member = await person("member@example.net");
    await insertPublishToken({ id: hashTokenSecret("ahp_member-token"), userId: member.user.id, name: "agent", createdAt: Date.now() });
    expect(await resolveSession(req("/", { headers: { cookie: member.cookie } }))).not.toBeNull();
    expect(await resolveSession(req("/", { headers: { authorization: "Bearer ahp_member-token" } }))).not.toBeNull();

    const patch = (id: string, body: unknown) => PATCH_USER(req(`/api/admin/users/${id}`, { method: "PATCH", headers: asCookie(admin.cookie), body }), params({ id }));
    expect((await patch(member.user.id, { disabled: true })).status).toBe(400);          // reason required
    expect((await patch(admin.user.id, { disabled: true, reason: "x" })).status).toBe(400); // not yourself
    expect((await patch(second.user.id, { disabled: true, reason: "x" })).status).toBe(400); // not another administrator
    const res = await patch(member.user.id, { disabled: true, reason: "posting spam" });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { disabledAt: number | null; disabledReason: string | null; providerSubject?: string } };
    expect(user.disabledAt).not.toBeNull();
    expect(user.disabledReason).toBe("posting spam");
    expect(user.providerSubject).toBeUndefined();

    expect(await resolveSession(req("/", { headers: { cookie: member.cookie } }))).toBeNull();
    expect(await resolveSession(req("/", { headers: { authorization: "Bearer ahp_member-token" } }))).toBeNull();
    expect((await patch(member.user.id, { disabled: true, reason: "again" })).status).toBe(400); // already disabled

    const log = await listAdminLog({ targetId: member.user.id });
    expect(log.map((e) => e.action)).toEqual(["user.disable"]);
    expect(log[0].actorUserId).toBe(admin.user.id);
    expect(log[0].reason).toBe("posting spam");

    expect((await patch(member.user.id, { disabled: false })).status).toBe(200);
    expect((await listAdminLog({ targetId: member.user.id })).map((e) => e.action)).toEqual(["user.enable", "user.disable"]);
  });

  it("a disabled account is no longer an administrator even if listed", async () => {
    const second = await person("second@example.net");
    const res = await PATCH_USER(req(`/api/admin/users/${second.user.id}`, { method: "PATCH", headers: asToken, body: { disabled: true, reason: "x" } }), params({ id: second.user.id }));
    expect(res.status).toBe(400); // listed administrators cannot be disabled — the address must leave the list first
  });
});

describe("taking a site down", () => {
  async function owned() {
    const member = await person("member@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>T</title><body>hi</body>" }, { ownerId: member.user.id });
    return { member, site };
  }

  it("visitors get 410 on the site and its preview; the owner still reads but cannot write; the directory hides it; restore undoes all of it", async () => {
    const { member, site } = await owned();
    const stranger = await person("stranger@example.net");
    const down = await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: true, reason: "phishing" } }), params({ slug: site.slug }));
    expect(down.status).toBe(200);
    const shown = (await down.json()) as { site: { takenDownAt: number; takenDownReason: string; editToken?: string; claimToken?: string; anonOwnerId?: string } };
    expect(shown.site.takenDownAt).toBeGreaterThan(0);
    expect(shown.site.editToken ?? shown.site.claimToken ?? shown.site.anonOwnerId).toBeUndefined();

    expect((await SITE_GET(req(`/api/sites/${site.slug}`), params({ slug: site.slug }))).status).toBe(410);
    expect((await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: stranger.cookie } }), params({ slug: site.slug }))).status).toBe(410);
    expect((await PREVIEW(req(`/api/preview/${site.slug}`), params({ slug: site.slug }))).status).toBe(410);
    const ownerRead = await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: member.cookie } }), params({ slug: site.slug }));
    expect(ownerRead.status).toBe(200);
    expect(((await ownerRead.json()) as { site: { takenDownAt: number; takenDownReason?: string } }).site.takenDownReason).toBeUndefined(); // reason never in the public projection
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: member.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: asToken }), params({ slug: site.slug }))).status).toBe(200);

    const rename = await SITE_PATCH(req(`/api/sites/${site.slug}`, { method: "PATCH", headers: asCookie(member.cookie), body: { title: "new" } }), params({ slug: site.slug }));
    expect(rename.status).toBe(403);

    expect((await listSites()).some((s) => s.slug === site.slug)).toBe(false);
    const mine = await listSitesByOwner(member.user.id);
    expect(mine.find((s) => s.slug === site.slug)?.takenDownAt).toBeGreaterThan(0);

    const up = await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: false } }), params({ slug: site.slug }));
    expect(up.status).toBe(200);
    expect((await SITE_GET(req(`/api/sites/${site.slug}`), params({ slug: site.slug }))).status).toBe(403);
    expect((await listSites()).some((s) => s.slug === site.slug)).toBe(true);
    expect((await listAdminLog({ targetId: site.id })).map((e) => e.action)).toEqual(["site.restore", "site.take_down"]);
  });

  it("a reason is required to take down, and the state is not applied twice", async () => {
    const { site } = await owned();
    const noReason = await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: true } }), params({ slug: site.slug }));
    expect(noReason.status).toBe(400);
    expect((await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: true, reason: "x" } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: true, reason: "x" } }), params({ slug: site.slug }))).status).toBe(400);
  });
});

describe("an administrator may read any site — on the record", () => {
  it("an e-mail administrator opens a private site and its preview; a member still gets 404; writes stay refused", async () => {
    const admin = await person("admin@example.net");
    const member = await person("member@example.net");
    const owner = await person("owner@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>secret</body>" }, { ownerId: owner.user.id });
    await updateSiteSharing(site.id, "private", "owner");
    expect((await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: member.cookie } }), params({ slug: site.slug }))).status).toBe(404);
    expect((await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(403);
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect(await readAccess(req(`/s/${site.slug}`, { headers: { cookie: admin.cookie } }), (await getSiteBySlug(site.slug))!)).toBe("admin");
    expect(await readAccess(req(`/s/${site.slug}`, { headers: { cookie: owner.cookie } }), (await getSiteBySlug(site.slug))!)).toBe("capability");
    // Reading is not standing: renaming as the administrator is still the site's own gate saying no.
    const rename = await SITE_PATCH(req(`/api/sites/${site.slug}`, { method: "PATCH", headers: asCookie(admin.cookie), body: { title: "x" } }), params({ slug: site.slug }));
    expect(rename.status).toBe(403);
  });

  it("every door records the administrator's reading — page, item API, preview, versions — as ONE row per hour; owners and the API token record nothing", async () => {
    process.env.PUBLISH_API_TOKEN = "api-token";
    const admin = await person("admin@example.net");
    const owner = await person("owner@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>secret</body>" }, { ownerId: owner.user.id });
    await updateSiteSharing(site.id, "private", "owner");
    const open = async (cookie: string) => {
      headerCookie = cookie;
      await SitePage({ params: Promise.resolve({ slug: site.slug }), searchParams: Promise.resolve({}) });
      await flushAfterResponseForTests();
    };
    await open(owner.cookie);
    await SITE_GET(req(`/api/sites/${site.slug}`, { headers: asToken }), params({ slug: site.slug }));
    expect(await listAdminLog({ targetId: site.id })).toEqual([]);

    // The administrator: the page, then the API and the preview (page + assets in real life) — one row.
    await open(admin.cookie);
    expect((await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(403);
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await VERSIONS(req(`/api/sites/${site.slug}/versions`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    const log = await listAdminLog({ targetId: site.id });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "site.view", actorUserId: admin.user.id, reason: "private" });
  });

  it("the preview alone — no page — is recorded too, so an API-only reading cannot slip past", async () => {
    const admin = await person("admin@example.net");
    const owner = await person("owner@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>secret</body>" }, { ownerId: owner.user.id });
    await updateSiteSharing(site.id, "private", "owner");
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await listAdminLog({ targetId: site.id })).map((e) => e.action)).toEqual(["site.view"]);
  });
});

describe("the owner's view of the administration log", () => {
  it("lists take-down, restore and every administrator reading of the site — dates and reasons, never who; owner only", async () => {
    const admin = await person("admin@example.net");
    const owner = await person("owner@example.net");
    const stranger = await person("stranger@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>x</body>" }, { ownerId: owner.user.id });
    await updateSiteSharing(site.id, "private", "owner");
    const activity = (cookie: string) => ACTIVITY(req(`/api/sites/${site.slug}/admin-activity`, { headers: { cookie } }), params({ slug: site.slug }));
    expect(((await (await activity(owner.cookie)).json()) as { entries: unknown[] }).entries).toEqual([]);

    await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug })); // an administrator reads it
    await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asCookie(admin.cookie), body: { takenDown: true, reason: "reported" } }), params({ slug: site.slug }));
    await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asCookie(admin.cookie), body: { takenDown: false } }), params({ slug: site.slug }));

    const res = await activity(owner.cookie);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { action: string; at: number; reason: string | null; actorUserId?: string; actorKind?: string }[] };
    expect(entries.map((e) => e.action).sort()).toEqual(["site.restore", "site.take_down", "site.view"]);
    expect(entries.find((e) => e.action === "site.take_down")?.reason).toBe("reported");
    for (const e of entries) { expect(e.actorUserId).toBeUndefined(); expect(e.actorKind).toBeUndefined(); expect(e.at).toBeGreaterThan(0); }

    expect((await activity(stranger.cookie)).status).toBe(403);
    expect((await ACTIVITY(req(`/api/sites/${site.slug}/admin-activity`), params({ slug: site.slug }))).status).toBe(403);
    // The response says whether older rows were cut off (they were not).
    expect(((await (await activity(owner.cookie)).json()) as { truncated: boolean; limit: number })).toMatchObject({ truncated: false, limit: 200 });
    // After an administrator deletes the site, the owner can still read the log — that is where the delete and its reason are.
    await DELETE_SITE(req(`/api/admin/sites/${site.slug}`, { method: "DELETE", headers: asCookie(admin.cookie), body: { reason: "abuse" } }), params({ slug: site.slug }));
    const afterDelete = await activity(owner.cookie);
    expect(afterDelete.status).toBe(200);
    expect(((await afterDelete.json()) as { entries: { action: string; reason: string | null }[] }).entries[0]).toMatchObject({ action: "site.delete", reason: "abuse" });
    // Reading the owner's own log is not an administrator act: only the delete was added by the calls above.
    expect((await listAdminLog({ targetId: site.id })).length).toBe(4);
  });
});

describe("deleting and restoring", () => {
  it("a delete keeps the files; an administrator restores it within the window; after the purge it is gone for good", async () => {
    const member = await person("member@example.net");
    const { site, version } = await createSite({ mode: "paste", html: "<title>D</title><body>x</body>" }, { ownerId: member.user.id });
    await flushTextIndexForTests();
    expect(await rbacQuery("SELECT site_id FROM site_texts WHERE site_id=$1", [site.id])).toHaveLength(1);
    expect(await deleteSite(site.slug)).toBe(true);
    expect(await getSiteView(site.slug)).toBeNull();
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("file");

    const deleted = await SITES(req("/api/admin/sites?state=deleted", { headers: asToken }));
    expect(((await deleted.json()) as { sites: { slug: string }[] }).sites.map((s) => s.slug)).toContain(site.slug);
    const live = await SITES(req("/api/admin/sites", { headers: asToken }));
    expect(((await live.json()) as { sites: { slug: string }[] }).sites.map((s) => s.slug)).not.toContain(site.slug);

    const restored = await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { deleted: false } }), params({ slug: site.slug }));
    expect(restored.status).toBe(200);
    expect(await getSiteView(site.slug)).not.toBeNull();
    expect((await PREVIEW(req(`/api/preview/${site.slug}`), params({ slug: site.slug }))).status).toBe(200);

    // Delete again, purge with a zero window: files go, the row is a tombstone, restore is refused.
    expect(await deleteSite(site.slug)).toBe(true);
    expect(await purgeDeletedSites({ retentionMs: 0 })).toEqual({ purged: 1, errors: 0 });
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("missing");
    expect((await getSiteBySlug(site.slug))?.purgedAt).toBeGreaterThan(0);
    expect(await rbacQuery("SELECT site_id FROM site_texts WHERE site_id=$1", [site.id])).toHaveLength(0);
    if (config.dbDriver === "sqlite") expect(await rbacQuery("SELECT site_id FROM site_texts_fts WHERE site_id=$1", [site.id])).toHaveLength(0);
    const again = await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asToken, body: { deleted: false } }), params({ slug: site.slug }));
    expect(again.status).toBe(400);
    // A second purge finds nothing.
    expect(await purgeDeletedSites({ retentionMs: 0 })).toEqual({ purged: 0, errors: 0 });
  });

  it("the purge respects the retention window", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "<title>W</title><body>x</body>" });
    await deleteSite(site.slug);
    expect(await purgeDeletedSites({ retentionMs: 60_000 })).toEqual({ purged: 0, errors: 0 });
    expect(await getStorage().stat(site.id, version.id, version.entry)).toBe("file");
  });

  it("an administrator can delete without the owner, with a reason, and it is logged", async () => {
    const member = await person("member@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>A</title><body>x</body>" }, { ownerId: member.user.id });
    expect((await DELETE_SITE(req(`/api/admin/sites/${site.slug}`, { method: "DELETE", headers: asToken, body: {} }), params({ slug: site.slug }))).status).toBe(400);
    expect((await DELETE_SITE(req(`/api/admin/sites/${site.slug}`, { method: "DELETE", headers: asToken, body: { reason: "abuse" } }), params({ slug: site.slug }))).status).toBe(200);
    expect(await getSiteView(site.slug)).toBeNull();
    expect((await listAdminLog({ targetId: site.id }))[0]).toMatchObject({ action: "site.delete", actorKind: "token", reason: "abuse" });
  });
});

describe("lists and the overview", () => {
  it("users carry their live site count and stored bytes across all versions; search, sort and the disabled filter work", async () => {
    const admin = await person("admin@example.net");
    const alice = await person("alice@example.net");
    const bob = await person("bob@example.net");
    await createSite({ mode: "paste", html: "<title>1</title><body>" + "a".repeat(5000) + "</body>" }, { ownerId: alice.user.id });
    const two = await createSite({ mode: "paste", html: "<title>2</title><body>b</body>" }, { ownerId: alice.user.id });
    await createSite({ mode: "paste", html: "<title>3</title><body>c</body>" }, { ownerId: bob.user.id });
    await deleteSite(two.site.slug); // still counts for bytes (restorable), no longer as a live site

    const all = (await (await USERS(req("/api/admin/users?sort=storage", { headers: asCookie(admin.cookie) }))).json()) as { users: { email: string; siteCount: number; byteTotal: number; providerSubject?: string }[]; total: number };
    expect(all.total).toBe(3);
    expect(all.users[0].email).toBe("alice@example.net");
    const a = all.users.find((u) => u.email === "alice@example.net")!;
    expect(a.siteCount).toBe(1);
    expect(a.byteTotal).toBeGreaterThan(5000);
    expect(a.providerSubject).toBeUndefined();

    const found = (await (await USERS(req("/api/admin/users?q=BOB", { headers: asToken }))).json()) as { users: { email: string }[]; total: number };
    expect(found.users.map((u) => u.email)).toEqual(["bob@example.net"]);
    expect(found.total).toBe(1);

    await PATCH_USER(req(`/api/admin/users/${bob.user.id}`, { method: "PATCH", headers: asToken, body: { disabled: true, reason: "x" } }), params({ id: bob.user.id }));
    const disabled = (await (await USERS(req("/api/admin/users?disabled=1", { headers: asToken }))).json()) as { users: { email: string }[] };
    expect(disabled.users.map((u) => u.email)).toEqual(["bob@example.net"]);
  });

  it("sites list: owner e-mail, anonymous filter, state filter, search by title/slug/owner", async () => {
    const alice = await person("alice@example.net");
    const mine = await createSite({ mode: "paste", html: "<title>Quarterly report</title><body>x</body>" }, { ownerId: alice.user.id });
    const anon = await createSite({ mode: "paste", html: "<title>Anon page</title><body>x</body>" }, { anonOwnerId: "anon_1" });
    const list = (await (await SITES(req("/api/admin/sites", { headers: asToken }))).json()) as { sites: { slug: string; ownerEmail: string | null; anonymous: boolean; byteTotal: number; versionCount: number; anonOwnerId?: string }[]; total: number };
    expect(list.total).toBe(2);
    const m = list.sites.find((s) => s.slug === mine.site.slug)!;
    expect(m.ownerEmail).toBe("alice@example.net");
    expect(m.anonymous).toBe(false);
    expect(m.versionCount).toBe(1);
    expect(m.byteTotal).toBeGreaterThan(0);
    expect(list.sites.find((s) => s.slug === anon.site.slug)!.anonOwnerId).toBeUndefined();

    const onlyAnon = (await (await SITES(req("/api/admin/sites?anonymous=1", { headers: asToken }))).json()) as { sites: { slug: string }[] };
    expect(onlyAnon.sites.map((s) => s.slug)).toEqual([anon.site.slug]);
    const byOwner = (await (await SITES(req("/api/admin/sites?q=alice@", { headers: asToken }))).json()) as { sites: { slug: string }[] };
    expect(byOwner.sites.map((s) => s.slug)).toEqual([mine.site.slug]);
    const byTitle = (await (await SITES(req("/api/admin/sites?q=quarterly", { headers: asToken }))).json()) as { sites: { slug: string }[] };
    expect(byTitle.sites.map((s) => s.slug)).toEqual([mine.site.slug]);
  });

  it("overview counts and the maintenance tasks are recorded", async () => {
    const alice = await person("alice@example.net");
    const a = await createSite({ mode: "paste", html: "<title>a</title><body>x</body>" }, { ownerId: alice.user.id });
    await createSite({ mode: "paste", html: "<title>b</title><body>x</body>" }, { anonOwnerId: "anon_2" });
    await PATCH_SITE(req(`/api/admin/sites/${a.site.slug}`, { method: "PATCH", headers: asToken, body: { takenDown: true, reason: "r" } }), params({ slug: a.site.slug }));
    const o = (await (await OVERVIEW(req("/api/admin/overview", { headers: asToken }))).json()) as { overview: Record<string, number>; runtime: { lines: string[] }; recent: { action: string }[] };
    expect(o.overview).toMatchObject({ users: 1, disabledUsers: 0, sites: 2, anonymousSites: 1, takenDownSites: 1, deletedSites: 0 });
    expect(o.overview.byteTotal).toBeGreaterThan(0);
    expect(o.runtime.lines.some((l) => l.startsWith("administrators:"))).toBe(true);
    expect(o.recent[0].action).toBe("site.take_down");

    const run = await MAINTENANCE(req("/api/admin/maintenance", { method: "POST", headers: asToken, body: { task: "purge-deleted" } }));
    expect(run.status).toBe(200);
    expect((await run.json()) as object).toEqual({ task: "purge-deleted", result: { purged: 0, errors: 0 } });
    const log = (await (await LOG(req("/api/admin/log", { headers: asToken }))).json()) as { entries: { action: string }[] };
    // Rows written in the same millisecond have no defined order between them: assert membership, not position.
    expect(log.entries.map((e) => e.action)).toContain("maintenance.purge_deleted");
  });
});

describe("assigning unowned sites", () => {
  it("lets an email administrator recover a private site without an operator token", async () => {
    delete process.env.PUBLISH_API_TOKEN;
    const admin = await person("admin@example.net"), target = await person("recipient@example.net");
    const { site } = await createSite({ mode: "paste", html: "<html>lost browser</html>" });
    await updateSiteSharing(site.id, "private", "owner");
    const { POST } = await import("@/app/api/admin/sites/[slug]/owner/route");
    const call = (headers: H, email = target.user.email!) => POST(req(`/api/admin/sites/${site.slug}/owner`, { method: "POST", headers, body: { email } }), params({ slug: site.slug }));
    expect((await call(asCookie(target.cookie))).status).toBe(401);
    expect((await call(asCookie(admin.cookie, false))).status).toBe(401);
    expect((await call({ ...asCookie(admin.cookie), origin: "https://foreign.example" })).status).toBe(401);
    expect((await call(asCookie(admin.cookie), "missing@example.net")).status).toBe(404);
    const results = await Promise.all([call(asCookie(admin.cookie)), call(asCookie(admin.cookie))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await getSiteBySlug(site.slug))?.ownerId).toBe(target.user.id);
    const logs = await listAdminLog({ targetId: site.id, limit: 10 });
    expect(logs.filter((l) => l.action === "site.assign_owner")).toHaveLength(1);
    expect(logs[0].actorUserId).toBe(admin.user.id);
  });

  it("allows operator tokens without Origin but rejects personal tokens of email admins", async () => {
    const admin = await person("admin@example.net"), target = await person("target@example.net");
    const { site } = await createSite({ mode: "paste", html: "<html>operator</html>" });
    const { POST } = await import("@/app/api/admin/sites/[slug]/owner/route");
    await insertPublishToken({ id: hashTokenSecret("ahp_admin_assignment"), userId: admin.user.id, name: "agent", createdAt: Date.now() });
    const call = (headers: H) => POST(req(`/api/admin/sites/${site.slug}/owner`, { method: "POST", headers, body: { email: target.user.email } }), params({ slug: site.slug }));
    expect((await call({ authorization: "Bearer ahp_admin_assignment" })).status).toBe(401);
    expect((await call(asToken)).status).toBe(200);
    expect((await call(asToken)).status).toBe(409);
    expect((await getSiteBySlug(site.slug))?.ownerId).toBe(target.user.id);
  });
});

it("rolls back administrator assignment if its admin-log insert fails", async () => {
  const { createId, claimSiteAudited, insertAdminLog } = await import("@/lib/db");
  const admin = await person("admin@example.net"), target = await person("recipient@example.net");
  const { site } = await createSite({ mode: "paste", html: "<html>atomic assignment</html>" });
  const log = { id: createId("adm"), actorKind: "user" as const, actorUserId: admin.user.id, action: "site.assign_owner" as const, targetKind: "site" as const, targetId: site.id, reason: "test", ip: null, createdAt: Date.now() };
  await insertAdminLog(log);
  await expect(claimSiteAudited(site.id, target.user.id, { id: createId("aud"), siteId: site.id, versionId: null, action: "claim", editorKind: "admin", actorUserId: admin.user.id, actorAnonId: null, method: "api", ip: null, userAgent: null }, log)).rejects.toThrow();
  expect((await getSiteBySlug(site.slug))?.ownerId).toBeNull();
});
