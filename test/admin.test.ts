import { config } from "@/lib/config";
import { flushTextIndexForTests } from "@/lib/site-text";
// The administration API: who gets in, what each act does to the rest of the system, and that
// every act leaves a row behind. SQLite backend; https requests because __Host- cookies need it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rbacQuery, closeDbForTests, getSiteBySlug, insertPublishToken, listAdminLog, listSitesByOwner, updateSiteVisibility, upsertUser } from "@/lib/db";
import { readAccess } from "@/lib/share";
import { flushAfterResponseForTests } from "@/lib/after-response";
import SitePage from "@/app/s/[slug]/page";
import { createSite, deleteSite, getSiteView, listSites } from "@/lib/sites";
import { mintSession, resolveSession } from "@/lib/session";
import { hashTokenSecret } from "@/lib/publish-token";
import { getStorage } from "@/lib/storage";
import { purgeDeletedSites, recordAdminAction } from "@/lib/admin";
import { GET as OVERVIEW } from "@/app/api/admin/overview/route";
import { GET as USERS } from "@/app/api/admin/users/route";
import { PATCH as PATCH_USER } from "@/app/api/admin/users/[id]/route";
import { GET as RETIRED_SITES } from "@/app/api/admin/sites/route";
import { PATCH as PATCH_SITE, DELETE as DELETE_SITE } from "@/app/api/admin/sites/[slug]/route";
import { GET as LOG } from "@/app/api/admin/log/route";
import { POST as MAINTENANCE } from "@/app/api/admin/maintenance/route";
import { GET as ME } from "@/app/api/auth/me/route";
import { GET as SITE_GET, PATCH as SITE_PATCH } from "@/app/api/sites/[slug]/route";
import { GET as VERSIONS } from "@/app/api/sites/[slug]/versions/route";
import { GET as ACTIVITY } from "@/app/api/sites/[slug]/admin-activity/route";
import { GET as PREVIEW } from "@/app/api/preview/[slug]/[[...path]]/route";
import { GET as RESOURCES } from "@/app/api/authorization/resources/route";
import { GET as TENANT } from "@/app/api/tenants/[tenantId]/route";
import { putTenantAdmin, putUserSiteRole } from "@/lib/role-bindings";

const SITES: (request: Request) => Promise<Response> = RETIRED_SITES;
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
    await pool.query("TRUNCATE users, sites, admin_log, rbac_audit, publish_tokens, sessions CASCADE");
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
    expect((await listAdminLog({ scope: "all", targetId: site.id })).map((e) => e.action)).toEqual(["site.restore", "site.take_down"]);
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
    await updateSiteVisibility(site.id, "private");
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
    await updateSiteVisibility(site.id, "private");
    const open = async (cookie: string) => {
      headerCookie = cookie;
      await SitePage({ params: Promise.resolve({ slug: site.slug }), searchParams: Promise.resolve({}) });
      await flushAfterResponseForTests();
    };
    await open(owner.cookie);
    await SITE_GET(req(`/api/sites/${site.slug}`, { headers: asToken }), params({ slug: site.slug }));
    expect(await listAdminLog({ scope: "all", targetId: site.id })).toEqual([]);

    // The administrator: the page, then the API and the preview (page + assets in real life) — one row.
    await open(admin.cookie);
    expect((await SITE_GET(req(`/api/sites/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(403);
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await VERSIONS(req(`/api/sites/${site.slug}/versions`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    const log = await listAdminLog({ scope: "all", targetId: site.id });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "site.view", actorUserId: admin.user.id, reason: "private" });
  });

  it("the preview alone — no page — is recorded too, so an API-only reading cannot slip past", async () => {
    const admin = await person("admin@example.net");
    const owner = await person("owner@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>secret</body>" }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, "private");
    expect((await PREVIEW(req(`/api/preview/${site.slug}`, { headers: { cookie: admin.cookie } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await listAdminLog({ scope: "all", targetId: site.id })).map((e) => e.action)).toEqual(["site.view"]);
  });
});

describe("the owner's view of the administration log", () => {
  it("lists take-down, restore and every administrator reading of the site — dates and reasons, never who; owner only", async () => {
    const admin = await person("admin@example.net");
    const owner = await person("owner@example.net");
    const stranger = await person("stranger@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>P</title><body>x</body>" }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, "private");
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
    expect((await listAdminLog({ scope: "all", targetId: site.id })).length).toBe(4);
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

    expect((await getSiteBySlug(site.slug))?.deletedAt).toBeGreaterThan(0);

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
    expect((await listAdminLog({ scope: "all", targetId: site.id }))[0]).toMatchObject({ action: "site.delete", actorKind: "token", reason: "abuse" });
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

  it("retires global site enumeration for every credential and legacy filter", async () => {
    const owner = await person("alice@example.net");
    const admin = await person("admin@example.net");
    await createSite({ mode: "paste", html: "<title>Private report</title>" }, { ownerId: owner.user.id });
    await createSite({ mode: "paste", html: "<title>Anonymous report</title>" }, { anonOwnerId: "anon_1" });
    for (const headers of [{}, asCookie(owner.cookie), asCookie(admin.cookie), asToken]) {
      for (const query of ["", "?q=report", `?owner=${owner.user.id}`, "?anonymous=1", "?state=deleted", "?state=taken_down", "?limit=200&offset=1"]) {
        const response = await SITES(req(`/api/admin/sites${query}`, { headers }));
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ error: "Administrative site listing is no longer available" });
      }
    }
  });

  it("does not turn platform or tenant management into a site resource catalog", async () => {
    const owner = await person("alice@example.net");
    const admin = await person("admin@example.net");
    const manager = await person("manager@example.net");
    const hidden = await createSite({ mode: "paste", html: "<title>Private report</title>" }, { ownerId: owner.user.id });
    await updateSiteVisibility(hidden.site.id, "private");
    const own = await createSite({ mode: "paste", html: "<title>My report</title>" }, { ownerId: admin.user.id });
    const shared = await createSite({ mode: "paste", html: "<title>Delegated report</title>" }, { ownerId: owner.user.id });
    await putUserSiteRole(rbacQuery, shared.site.id, admin.user.id, "admin", owner.user.id);
    await putTenantAdmin(rbacQuery, hidden.site.tenantId, manager.user.id, true, owner.user.id);
    for (const [headers, ids] of [
      [asCookie(admin.cookie), [own.site.id, shared.site.id]],
      [asCookie(manager.cookie), []],
      [asToken, []],
    ] as [H, string[]][]) {
      const response = await RESOURCES(req("/api/authorization/resources?type=site", { headers }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resources.map((r: { id: string }) => r.id).sort()).toEqual(ids.sort());
      expect(body.nextCursor).toBeNull();
      // Neither a title search nor a later page may reveal unrelated private resources.
      for (const query of ["?type=site&q=Private", "?type=site&cursor=50"]) {
        expect(await (await RESOURCES(req(`/api/authorization/resources${query}`, { headers }))).json())
          .toEqual({ resources: [], nextCursor: null });
      }
      const tenants = await RESOURCES(req("/api/authorization/resources?type=tenant", { headers }));
      expect((await tenants.json()).resources.map((r: { id: string }) => r.id)).toContain(hidden.site.tenantId);
    }
    const ownResources = await RESOURCES(req("/api/authorization/resources", { headers: asCookie(owner.cookie) }));
    expect((await ownResources.json()).resources.map((r: { id: string }) => r.id).sort()).toEqual([hidden.site.id, shared.site.id].sort());
  });

  it("returns tenant audit records without embedding a tenant-wide file list", async () => {
    const owner = await person("owner@example.net");
    const admin = await person("admin@example.net");
    const manager = await person("manager@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Private tenant file</title>" }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, "private");
    await putTenantAdmin(rbacQuery, site.tenantId, manager.user.id, true, owner.user.id);
    const { setSharingPreference } = await import("@/lib/sharing-preferences");
    await setSharingPreference(req("/api/me/sharing", { method: "POST", headers: asCookie(owner.cookie) }), site.tenantId, { audience: "private", comments: false });
    await rbacQuery("INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES('tenant-audit',$1,$2,'tenant.update',$1,'Rename workspace',1)", [site.tenantId, manager.user.id]);
    for (const action of ["site.read", "site.management", "comment.management", "authorization.grant", "sharing.main"]) {
      await rbacQuery("INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,2)", [action, site.tenantId, owner.user.id, action, site.id, `${site.slug}: ${site.title}`]);
    }
    for (const headers of [asCookie(admin.cookie), asCookie(manager.cookie), asToken]) {
      const response = await TENANT(req(`/api/tenants/${site.tenantId}`, { headers }), params({ tenantId: site.tenantId }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(["audit"]);
      expect(body.audit).toContainEqual(expect.objectContaining({ action: "tenant.update", reason: "Rename workspace" }));
      expect(body.audit).toContainEqual(expect.objectContaining({ action: "sharing.defaults", target_id: owner.user.id, actor_id: owner.user.id }));
      expect(JSON.stringify(body)).not.toContain(site.id);
      expect(JSON.stringify(body)).not.toContain(site.slug);
      expect(JSON.stringify(body)).not.toContain(site.title);
    }
    expect((await TENANT(req(`/api/tenants/${site.tenantId}`), params({ tenantId: site.tenantId }))).status).toBe(403);
  });

  it("scopes global admin audit to the caller's own site actions and supports exact targets", async () => {
    const admin = await person("admin@example.net"), other = await person("second@example.net");
    const mine = await createSite({ mode: "paste", html: "<title>Known recovery</title>" });
    const hidden = await createSite({ mode: "paste", html: "<title>Unrelated file</title>" });
    await recordAdminAction(null, { kind: "user", userId: admin.user.id, email: admin.user.email! }, "site.delete", { kind: "site", id: mine.site.id }, "My report");
    await recordAdminAction(null, { kind: "user", userId: other.user.id, email: other.user.email! }, "site.view", { kind: "site", id: hidden.site.id }, hidden.site.slug);
    for (const headers of [asCookie(admin.cookie), asToken]) {
      const expected = headers === asToken ? [] : [mine.site.id];
      for (const path of ["/api/admin/log", "/api/admin/log?target=&limit=500"]) {
        const response = await LOG(req(path, { headers }));
        const data = await response.json();
        expect(data.entries.map((e: { targetId: string }) => e.targetId)).toEqual(expected);
        expect(JSON.stringify(data)).not.toContain(hidden.site.id);
        expect(JSON.stringify(data)).not.toContain(hidden.site.slug);
      }
      const overview = await (await OVERVIEW(req("/api/admin/overview", { headers }))).json();
      expect(overview.recent.map((e: { targetId: string }) => e.targetId)).toEqual(expected);
      const exact = await (await LOG(req(`/api/admin/log?target=${hidden.site.id}`, { headers: { ...headers, "x-management-reason": "Investigate history" } }))).json();
      expect(exact.entries.map((e: { targetId: string }) => e.targetId)).toEqual([hidden.site.id]);
    }
  });

  it("selects only an exact known site for management with a recorded reason", async () => {
    const owner = await person("owner@example.net"), admin = await person("admin@example.net"), manager = await person("manager@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Known private report</title>" }, { ownerId: owner.user.id });
    await updateSiteVisibility(site.id, "private");
    await putTenantAdmin(rbacQuery, site.tenantId, manager.user.id, true, owner.user.id);
    for (const headers of [asCookie(admin.cookie), asCookie(manager.cookie), asToken]) {
      for (const reference of [site.slug, site.id, `${ORIGIN}/s/${site.slug}`]) {
        const response = await RESOURCES(req(`/api/authorization/resources?type=site&exact=${encodeURIComponent(reference)}`, { headers: { ...headers, "x-management-reason": "Investigate reported access" } }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ resources: [{ id: site.id, name: site.title, slug: site.slug, tenant_id: site.tenantId }], nextCursor: null });
      }
      for (const reference of [site.slug.slice(0, 5), site.title]) {
        expect((await RESOURCES(req(`/api/authorization/resources?type=site&exact=${encodeURIComponent(reference)}`, { headers: { ...headers, "x-management-reason": "Investigate reported access" } }))).status).not.toBe(200);
      }
    }
    expect((await RESOURCES(req(`/api/authorization/resources?exact=${site.slug}`, { headers: asCookie(admin.cookie) }))).status).toBe(400);
    const outsider = await person("outsider@example.net");
    expect((await RESOURCES(req(`/api/authorization/resources?exact=${site.id}`, { headers: { ...asCookie(outsider.cookie), "x-management-reason": "Attempt" } }))).status).toBe(404);
    await insertPublishToken({ id: hashTokenSecret("ahp_known-exact"), userId: admin.user.id, name: "agent", createdAt: Date.now() });
    expect((await RESOURCES(req(`/api/authorization/resources?exact=${site.id}`, { headers: { authorization: "Bearer ahp_known-exact", "x-management-reason": "Attempt" } }))).status).toBe(404);
    expect(await rbacQuery("SELECT id FROM rbac_audit WHERE target_id=$1 AND action='site.management'", [site.id])).not.toHaveLength(0);
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
    expect(o.recent).toEqual([]);

    const run = await MAINTENANCE(req("/api/admin/maintenance", { method: "POST", headers: asToken, body: { task: "purge-deleted" } }));
    expect(run.status).toBe(200);
    expect((await run.json()) as object).toEqual({ task: "purge-deleted", result: { purged: 0, errors: 0 } });
    const log = (await (await LOG(req("/api/admin/log", { headers: asToken }))).json()) as { entries: { action: string }[] };
    // Rows written in the same millisecond have no defined order between them: assert membership, not position.
    expect(log.entries.map((e) => e.action)).toContain("maintenance.purge_deleted");
  });
});

describe("known-site administration", () => {
  it("looks up an exact private or deleted site without credentials or source, and audits the reason", async () => {
    delete process.env.PUBLISH_API_TOKEN;
    const admin = await person("admin@example.net"), member = await person("member@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Recovered</title><body>secret source</body>" });
    await updateSiteVisibility(site.id, "private");
    const { POST } = await import("@/app/api/admin/site-lookup/route");
    const lookup = (reference: string, headers = asCookie(admin.cookie), reason = "Recover lost session") => POST(req("/api/admin/site-lookup", { method: "POST", headers, body: { reference, reason } }));
    for (const reference of [site.slug, site.id, `${ORIGIN}/s/${site.slug}?version=old`]) {
      const response = await lookup(reference);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.site).toMatchObject({ id: site.id, slug: site.slug, ownerId: null, deletedAt: null });
      for (const secret of ["editToken", "anonOwnerId", "secret source"]) expect(JSON.stringify(body)).not.toContain(secret);
    }
    expect((await lookup(site.slug, asCookie(member.cookie))).status).toBe(401);
    expect((await lookup(site.slug, asCookie(admin.cookie, false))).status).toBe(401);
    expect((await lookup(site.slug, asCookie(admin.cookie), "")).status).toBe(400);
    for (const bad of ["", "Recovered", site.slug.slice(0, 4), "%", `https://other.example/s/${site.slug}`, `${ORIGIN}/v/${site.slug}`]) {
      expect((await lookup(bad)).status).not.toBe(200);
    }
    await deleteSite(site.slug);
    const deleted = await lookup(site.id);
    expect((await deleted.json()).site.deletedAt).toBeGreaterThan(0);
    expect((await PATCH_SITE(req(`/api/admin/sites/${site.slug}`, { method: "PATCH", headers: asCookie(admin.cookie), body: { deleted: false, reason: "Undo deletion" } }), params({ slug: site.slug }))).status).toBe(200);
    expect(await getSiteView(site.slug)).not.toBeNull();
    const audit = await rbacQuery("SELECT reason FROM rbac_audit WHERE target_id=$1 AND action='site.management'", [site.id]);
    expect(audit).toHaveLength(4);
    expect(audit.every(row => row.reason === "Recover lost session")).toBe(true);
  });

  it("accepts only the configured mount when resolving a full site address", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Mounted site</title>" });
    const { knownSite } = await import("@/lib/known-site");
    const previous = process.env.ARTIFACT_PUBLIC_URL;
    process.env.ARTIFACT_PUBLIC_URL = `${ORIGIN}/artifact`;
    try {
      expect((await knownSite(req("/"), `${ORIGIN}/artifact/s/${site.slug}`)).id).toBe(site.id);
      await expect(knownSite(req("/"), `${ORIGIN}/s/${site.slug}`)).rejects.toThrow("this server");
      await expect(knownSite(req("/"), `${ORIGIN}/artifact/s/${site.slug}%2Fextra`)).rejects.toThrow("exact");
    } finally {
      if (previous === undefined) delete process.env.ARTIFACT_PUBLIC_URL;
      else process.env.ARTIFACT_PUBLIC_URL = previous;
    }
  });
});

describe("assigning unowned sites", () => {
  it("lets an email administrator recover a private site without an operator token", async () => {
    delete process.env.PUBLISH_API_TOKEN;
    const admin = await person("admin@example.net"), target = await person("recipient@example.net");
    const { site } = await createSite({ mode: "paste", html: "<html>lost browser</html>" });
    await updateSiteVisibility(site.id, "private");
    const { POST } = await import("@/app/api/admin/sites/[slug]/owner/route");
    const call = (headers: H, email = target.user.email!) => POST(req(`/api/admin/sites/${site.slug}/owner`, { method: "POST", headers, body: { email, reason: "Verified account recovery" } }), params({ slug: site.slug }));
    expect((await call(asCookie(target.cookie))).status).toBe(401);
    expect((await call(asCookie(admin.cookie, false))).status).toBe(401);
    expect((await call({ ...asCookie(admin.cookie), origin: "https://foreign.example" })).status).toBe(401);
    expect((await call(asCookie(admin.cookie), "missing@example.net")).status).toBe(404);
    const results = await Promise.all([call(asCookie(admin.cookie)), call(asCookie(admin.cookie))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await getSiteBySlug(site.slug))?.ownerId).toBe(target.user.id);
    const logs = await listAdminLog({ scope: "all", targetId: site.id, limit: 10 });
    expect(logs.filter((l) => l.action === "site.assign_owner")).toHaveLength(1);
    expect(logs[0].actorUserId).toBe(admin.user.id);
  });

  it("allows operator tokens without Origin but rejects personal tokens of email admins", async () => {
    const admin = await person("admin@example.net"), target = await person("target@example.net");
    const { site } = await createSite({ mode: "paste", html: "<html>operator</html>" });
    const { POST } = await import("@/app/api/admin/sites/[slug]/owner/route");
    await insertPublishToken({ id: hashTokenSecret("ahp_admin_assignment"), userId: admin.user.id, name: "agent", createdAt: Date.now() });
    const call = (headers: H) => POST(req(`/api/admin/sites/${site.slug}/owner`, { method: "POST", headers, body: { email: target.user.email, reason: "Verified account recovery" } }), params({ slug: site.slug }));
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

describe("known-site review regressions", () => {
  it("does not distinguish inaccessible, deleted and unknown sites during exact authorization lookup", async () => {
    const owner = await person("owner@example.net"), outsider = await person("outsider@example.net");
    const live = (await createSite({ mode: "paste", html: "<title>Private</title>" }, { ownerId: owner.user.id })).site;
    const deleted = (await createSite({ mode: "paste", html: "<title>Deleted</title>" }, { ownerId: owner.user.id })).site;
    await deleteSite(deleted.slug);
    for (const reference of [live.id, live.slug, deleted.id, deleted.slug, "site_unknown", "unknown-slug"]) {
      const response = await RESOURCES(req(`/api/authorization/resources?exact=${reference}`, { headers: { ...asCookie(outsider.cookie), "x-management-reason": "Probe" } }));
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: "Resource not found" } });
    }
  });

  it("keeps disabled-workspace discovery separate from the existing direct permission gate", async () => {
    const owner = await person("owner@example.net"), admin = await person("admin@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Disabled workspace</title>" }, { ownerId: owner.user.id });
    const { authorizeResource } = await import("@/lib/authorization");
    await rbacQuery("UPDATE tenants SET disabled_at=1 WHERE id=$1", [site.tenantId]);
    try {
      for (const headers of [asToken, asCookie(admin.cookie), asCookie(owner.cookie)]) {
        const request = req(`/api/authorization/resources?exact=${site.id}`, { headers: { ...headers, "x-management-reason": "Known report" } });
        const response = await RESOURCES(request);
        expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: "Resource not found" } });
        await expect(authorizeResource(request, { type: "site", id: site.id }, await resolveSession(request))).rejects.toMatchObject({ statusCode: 403 });
      }
    } finally { await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id=$1", [site.tenantId]); }
  });

  it("resolves site subpages and version share links without treating collections as a single site", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Reported site</title>" });
    const { knownSite } = await import("@/lib/known-site");
    const { createId, createShare } = await import("@/lib/db");
    const { hashToken } = await import("@/lib/share");
    const token = "reported-version-link";
    await createShare({ id: createId("share"), siteId: site.id, tokenHash: hashToken(token), policy: "public", versionId: site.currentVersionId, passcodeHash: null, label: null, createdBy: null, createdAnonId: null, expiresAt: null });
    for (const reference of [`${ORIGIN}/s/${site.slug}/comments?thread=one`, `/s/${site.slug}/edit`, `${ORIGIN}/v/${token}`]) {
      expect((await knownSite(req("/"), reference)).id).toBe(site.id);
    }
    const outsider = await person("outsider@example.net"), admin = await person("admin@example.net");
    for (const [cookie, status] of [[outsider.cookie, 404], [admin.cookie, 200]] as const) {
      const response = await RESOURCES(req(`/api/authorization/resources?exact=${encodeURIComponent(`${ORIGIN}/v/${token}`)}`, { headers: { ...asCookie(cookie), "x-management-reason": "Reported share" } }));
      expect(response.status).toBe(status);
    }
    await expect(knownSite(req("/"), `${ORIGIN}/c/collection`)).rejects.toThrow("Collection links");
    await expect(knownSite(req("/"), `${ORIGIN}/s/${site.slug}%2Fcomments`)).rejects.toThrow();
    await expect(knownSite(req("/"), `https://foreign.example/v/${token}`)).rejects.toThrow();
  });

  it("requires a human-written assignment reason and records it atomically with ownership", async () => {
    const target = await person("recipient@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Unowned</title>" });
    const { POST } = await import("@/app/api/admin/sites/[slug]/owner/route");
    const call = (reason?: string) => POST(req(`/api/admin/sites/${site.slug}/owner`, { method: "POST", headers: asToken, body: { email: target.user.email, reason } }), params({ slug: site.slug }));
    for (const reason of [undefined, " ", "bad\0reason"]) expect((await call(reason)).status).toBe(400);
    expect((await getSiteBySlug(site.slug))?.ownerId).toBeNull();
    expect((await call("  Verified recovery request #123  ")).status).toBe(200);
    expect((await listAdminLog({ scope: "all", targetId: site.id }))[0]).toMatchObject({ action: "site.assign_owner", reason: `Verified recovery request #123\nAssigned owner: ${target.user.id}` });
  });


});

describe("administration follow-up review", () => {
  it("requires and records a reason before returning full site audit history", async () => {
    const admin = await person("admin@example.net"), other = await person("second@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Reported history</title>" });
    await recordAdminAction(null, { kind: "user", userId: other.user.id, email: other.user.email! }, "site.view", { kind: "site", id: site.id }, "Another administrator");
    const { managementReasonHeaders } = await import("@/lib/management-reason");
    for (const headers of [asCookie(admin.cookie), asToken]) {
      const path = `/api/admin/log?target=${site.id}`;
      expect((await LOG(req(path, { headers }))).status).toBe(400);
      expect((await LOG(req(path, { headers: { ...headers, ...managementReasonHeaders("bad\0reason") } }))).status).toBe(400);
      const response = await LOG(req(path, { headers: { ...headers, ...managementReasonHeaders("  Inspect\nreported history  ") } }));
      expect(response.status).toBe(200);
      expect((await response.json()).entries).toHaveLength(1);
    }
    const events = await rbacQuery("SELECT actor_id,reason FROM rbac_audit WHERE action='site.audit.read' AND target_id=$1", [site.id]);
    expect(events).toHaveLength(2);
    expect(events.map(row => row.actor_id)).toContain(admin.user.id);
    expect(events.map(row => row.actor_id)).toContain(null);
    expect(events.every(row => row.reason === "Inspect reported history")).toBe(true);
    expect((await LOG(req(`/api/admin/log?target=${admin.user.id}`, { headers: asToken }))).status).toBe(200);
  });

  it("distinguishes ordinary exact lookup from elevated management in the audit", async () => {
    const owner = await person("owner@example.net"), siteAdmin = await person("grantee@example.net"), manager = await person("admin@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Authority source</title>" }, { ownerId: owner.user.id });
    await putUserSiteRole(rbacQuery, site.id, siteAdmin.user.id, "admin", owner.user.id);
    for (const headers of [asCookie(owner.cookie), asCookie(siteAdmin.cookie), asCookie(manager.cookie), asToken]) {
      expect((await RESOURCES(req(`/api/authorization/resources?exact=${site.id}`, { headers: { ...headers, "x-management-reason": "Inspect access" } }))).status).toBe(200);
    }
    const events = await rbacQuery("SELECT actor_id,action FROM rbac_audit WHERE target_id=$1 AND action IN ('site.lookup','site.management')", [site.id]);
    expect(events).toHaveLength(4);
    expect(events).toEqual(expect.arrayContaining([
      { actor_id: owner.user.id, action: "site.lookup" }, { actor_id: siteAdmin.user.id, action: "site.lookup" },
      { actor_id: manager.user.id, action: "site.management" }, { actor_id: null, action: "site.management" },
    ]));
  });

  it("accepts deep site paths and app-relative addresses on a mounted deployment", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Mounted report</title>" });
    const { knownSite } = await import("@/lib/known-site");
    const previous = process.env.ARTIFACT_PUBLIC_URL;
    process.env.ARTIFACT_PUBLIC_URL = `${ORIGIN}/artifact`;
    try {
      for (const address of [`${ORIGIN}/artifact/s/${site.slug}/index.html`, `${ORIGIN}/artifact/s/${site.slug}/docs/page.html?x=1`, `/s/${site.slug}/docs/page.html`, `s/${site.slug}/index.html`, `/artifact/s/${site.slug}/comments`]) expect((await knownSite(req("/"), address)).id).toBe(site.id);
      for (const address of [`${ORIGIN}/s/${site.slug}`, `//foreign.example/artifact/s/${site.slug}`, `/s/${site.slug}/docs/%00`, `/s/${site.slug}/docs/%2e%2e%2fsecret`]) await expect(knownSite(req("/"), address)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ARTIFACT_PUBLIC_URL;
      else process.env.ARTIFACT_PUBLIC_URL = previous;
    }
  });

  it("normalizes body and header reasons identically before auditing", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Reason normalization</title>" });
    const recipient = await person("recipient@example.net");
    const { POST: lookup } = await import("@/app/api/admin/site-lookup/route");
    const { POST: assign } = await import("@/app/api/admin/sites/[slug]/owner/route");
    const reason = "  Verified\r\nsupport\nrequest  ";
    expect((await lookup(req('/api/admin/site-lookup', { method: 'POST', headers: asToken, body: { reference: site.id, reason } }))).status).toBe(200);
    expect((await rbacQuery("SELECT reason FROM rbac_audit WHERE target_id=$1", [site.id]))[0].reason).toBe("Verified support request");
    expect((await assign(req(`/api/admin/sites/${site.slug}/owner`, { method: 'POST', headers: asToken, body: { email: recipient.user.email, reason } }), params({ slug: site.slug }))).status).toBe(200);
    expect((await listAdminLog({ scope: "all", targetId: site.id }))[0].reason).toBe(`Verified support request\nAssigned owner: ${recipient.user.id}`);
  });

  it("applies administrator and browser-origin gates to every ID mutation route", async () => {
    const { PATCH, DELETE } = await import("@/app/api/admin/sites/by-id/[siteId]/route");
    const { POST } = await import("@/app/api/admin/sites/by-id/[siteId]/owner/route");
    const { site } = await createSite({ mode: "paste", html: "<title>Protected target</title>" });
    const admin = await person("admin@example.net"), member = await person("member@example.net");
    const path = `/api/admin/sites/by-id/${site.id}`, context = params({ siteId: site.id });
    for (const headers of [{}, asCookie(member.cookie), { ...asCookie(admin.cookie), origin: 'https://foreign.example' }, { ...asCookie(admin.cookie), origin: '' }]) {
      expect((await PATCH(req(path, { method: 'PATCH', headers, body: { takenDown: true, reason: 'Report' } }), context)).status).toBe(401);
      expect((await DELETE(req(path, { method: 'DELETE', headers, body: { reason: 'Report' } }), context)).status).toBe(401);
      expect((await POST(req(`${path}/owner`, { method: 'POST', headers, body: { email: member.user.email, reason: 'Recovery' } }), context)).status).toBe(401);
    }
    expect(await getSiteBySlug(site.slug)).toMatchObject({ ownerId: null, deletedAt: null, takenDownAt: null });
    expect((await listAdminLog({ scope: "all", targetId: site.id }))).toEqual([]);
  });

  it("addresses all known-site mutations by immutable ID and returns 404 for missing targets", async () => {
    const { PATCH, DELETE } = await import("@/app/api/admin/sites/by-id/[siteId]/route");
    const { POST } = await import("@/app/api/admin/sites/by-id/[siteId]/owner/route");
    const { getSite } = await import("@/lib/db");
    const recipient = await person("recipient@example.net");
    const original = (await createSite({ mode: "paste", html: "<title>Original</title>" })).site;
    const replacement = (await createSite({ mode: "paste", html: "<title>Replacement</title>" })).site;
    await rbacQuery("UPDATE sites SET slug=$1 WHERE id=$2", [`moved-${original.slug}`, original.id]);
    await rbacQuery("UPDATE sites SET slug=$1 WHERE id=$2", [original.slug, replacement.id]);
    const path = `/api/admin/sites/by-id/${original.id}`, context = params({ siteId: original.id });
    expect((await POST(req(`${path}/owner`, { method: 'POST', headers: asToken, body: { email: recipient.user.email, reason: 'Verified recovery' } }), context)).status).toBe(200);
    for (const takenDown of [true, false]) expect((await PATCH(req(path, { method: 'PATCH', headers: asToken, body: { takenDown, reason: 'Known target' } }), context)).status).toBe(200);
    expect((await DELETE(req(path, { method: 'DELETE', headers: asToken, body: { reason: 'Reported deletion' } }), context)).status).toBe(200);
    expect((await PATCH(req(path, { method: 'PATCH', headers: asToken, body: { deleted: false, reason: 'Undo deletion' } }), context)).status).toBe(200);
    expect(await getSite(original.id)).toMatchObject({ ownerId: recipient.user.id, deletedAt: null, takenDownAt: null });
    expect(await getSite(replacement.id)).toMatchObject({ ownerId: null, deletedAt: null, takenDownAt: null });
    for (const call of [
      () => PATCH(req(path, { method: 'PATCH', headers: asToken, body: { takenDown: true, reason: 'Missing' } }), params({ siteId: 'site_missing' })),
      () => DELETE(req(path, { method: 'DELETE', headers: asToken, body: { reason: 'Missing' } }), params({ siteId: 'site_missing' })),
      () => POST(req(path, { method: 'POST', headers: asToken, body: { email: recipient.user.email, reason: 'Missing' } }), params({ siteId: 'site_missing' })),
      () => PATCH_SITE(req(path, { method: 'PATCH', headers: asToken, body: { takenDown: true, reason: 'Missing' } }), params({ slug: 'missing-slug' })),
    ]) expect((await call()).status).toBe(404);
  });
});


describe("administration audit boundaries", () => {
  it("does not reveal whether a site exists before validating an audit reason", async () => {
    const admin = await person("admin@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Known audit target</title>" });
    const { managementReasonHeaders } = await import("@/lib/management-reason");
    for (const credentials of [asToken, asCookie(admin.cookie)]) {
      for (const reason of [undefined, '', 'bad\0reason', 'x'.repeat(501)]) {
        const responses = [];
        for (const target of [site.id, 'site_missing', 'unknown-target']) {
          const response = await LOG(req(`/api/admin/log?target=${target}`, { headers: { ...credentials, ...(reason === undefined ? {} : managementReasonHeaders(reason)) } }));
          responses.push({ status: response.status, body: await response.json() });
        }
        expect(responses).toEqual(Array(3).fill({ status: 400, body: { error: "A management reason is required for site audit history" } }));
      }
      for (const target of [admin.user.id, 'usr_missing']) {
        const response = await LOG(req(`/api/admin/log?target=${target}`, { headers: credentials }));
        expect(response.status).toBe(200);
        expect((await response.json()).entries).toEqual([]);
      }
    }
    expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.audit.read'")).toEqual([]);
  });

  it("keeps omitted and undefined audit scopes private and requires an explicit full-history scope", async () => {
    const admin = await person("admin@example.net"), other = await person("second@example.net");
    const { site } = await createSite({ mode: "paste", html: "<title>Scoped history</title>" });
    for (const person of [admin, other]) await recordAdminAction(null, { kind: "user", userId: person.user.id, email: person.user.email! }, "site.view", { kind: "site", id: site.id });
    await recordAdminAction(null, { kind: "token", userId: null }, "site.view", { kind: "site", id: site.id });
    await recordAdminAction(null, { kind: "token", userId: null }, "user.enable", { kind: "user", id: admin.user.id });
    for (const options of [{}, { viewerUserId: undefined }, { viewerUserId: null }, { scope: undefined, viewerUserId: undefined }, { scope: 'visible' as const }]) {
      const rows = await listAdminLog(options);
      expect(rows.map(row => row.action)).toEqual(['user.enable']);
      expect(await listAdminLog({ ...options, targetId: site.id })).toEqual([]);
    }
    const mine = await listAdminLog({ scope: 'visible', viewerUserId: admin.user.id });
    expect(mine).toHaveLength(2);
    expect(mine.filter(row => row.targetKind === 'site').map(row => row.actorUserId)).toEqual([admin.user.id]);
    expect(await listAdminLog({ scope: 'all', targetId: site.id })).toHaveLength(3);
  });

  it.each(['id', 'slug'] as const)("validates every %s mutation reason before changing a site", async address => {
    const { PATCH, DELETE } = await import("@/app/api/admin/sites/by-id/[siteId]/route");
    const legacy = await import("@/app/api/admin/sites/[slug]/route");
    const { site } = await createSite({ mode: "paste", html: "<title>Reason validation</title>" });
    const path = `/api/admin/sites/${address === 'id' ? `by-id/${site.id}` : site.slug}`;
    const call = (method: 'PATCH' | 'DELETE', body: object) => {
      const request = req(path, { method, headers: asToken, body });
      return address === 'id' ? (method === 'PATCH' ? PATCH : DELETE)(request, params({ siteId: site.id }))
        : legacy[method](request, params({ slug: site.slug }));
    };
    for (const [method, body] of [['PATCH', { takenDown: true }], ['PATCH', { takenDown: false }], ['DELETE', {}], ['PATCH', { deleted: false }]] as const) {
      const before = await getSiteBySlug(site.slug);
      const log = await listAdminLog({ scope: 'all', targetId: site.id });
      for (const reason of ['spam\0', 'x'.repeat(501)]) {
        expect((await call(method, { ...body, reason })).status).toBe(400);
        expect(await getSiteBySlug(site.slug)).toEqual(before);
        expect(await listAdminLog({ scope: 'all', targetId: site.id })).toEqual(log);
      }
      expect((await call(method, { ...body, reason: '  Verified\r\nsupport\nrequest  ' })).status).toBe(200);
    }
    expect((await listAdminLog({ scope: 'all', targetId: site.id })).map(row => row.reason)).toEqual(Array(4).fill('Verified support request'));
    expect((await call('PATCH', { takenDown: true })).status).toBe(400);
    expect((await call('DELETE', { reason: ' ' })).status).toBe(400);
    expect((await call('PATCH', { takenDown: true, reason: 'Report' })).status).toBe(200);
    expect((await call('PATCH', { takenDown: false, reason: '' })).status).toBe(200);
    expect((await call('DELETE', { reason: 'Report' })).status).toBe(200);
    expect((await call('PATCH', { deleted: false })).status).toBe(200);
  });
});
