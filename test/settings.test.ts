// Console settings: precedence (console > environment > default), validation, the cache, the
// API and its log row — and the one behaviour they exist for: anonymous creators kept to reading
// until they sign in. SQLite here; the CI integration job runs this file on Postgres too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSite, listAdminLog, setSiteOwnerIfUnowned, upsertUser } from "@/lib/db";
import { describePermissions } from "@/lib/authz";
import { mintSession } from "@/lib/session";
import { createSite } from "@/lib/sites";
import { describeSettings, policy, refreshSettings, updateSettings } from "@/lib/settings";
import { describeRuntime } from "@/lib/runtime";
import { GET as SETTINGS_GET, PUT as SETTINGS_PUT } from "@/app/api/admin/settings/route";
import { GET as SITE_GET, PATCH as SITE_PATCH, DELETE as SITE_DELETE } from "@/app/api/sites/[slug]/route";
import { POST as EDIT } from "@/app/api/sites/[slug]/edit/route";
import { POST as SHARES } from "@/app/api/sites/[slug]/shares/route";
import { GET as PREVIEW } from "@/app/api/preview/[slug]/[[...path]]/route";
import { POST as CREATE } from "@/app/api/sites/route";

const dirs: string[] = [];
const ENV = ["ARTIFACT_QUOTA_SITES_PER_USER", "ARTIFACT_ANON_SITE_TTL_DAYS", "ARTIFACT_ANONYMOUS_SITES", "ARTIFACT_DEFAULT_VISIBILITY", "ARTIFACT_CREATE_POLICY", "PUBLISH_API_TOKEN", "ARTIFACT_ADMIN_EMAILS", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"];

async function resetPostgres(): Promise<void> {
  if (process.env.ARTIFACT_DB_DRIVER !== "postgres") return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ARTIFACT_DATABASE_URL, max: 1 });
  try { await pool.query("TRUNCATE users, sites, admin_log, publish_tokens, sessions, settings CASCADE"); }
  catch (error) { if ((error as { code?: string }).code !== "42P01") throw error; }
  finally { await pool.end(); }
}
beforeEach(async () => { await resetPostgres(); const d = mkdtempSync(join(tmpdir(), "set-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; process.env.PUBLISH_API_TOKEN = "api-token"; });
afterEach(async () => { await closeDbForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const k of ["ARTIFACT_DATA_DIR", ...ENV]) delete process.env[k]; });

const ORIGIN = "https://x";
const secure = { "x-forwarded-proto": "https" };
const asToken = { authorization: "Bearer api-token" };
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: { ...secure, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

describe("precedence and validation", () => {
  it("environment (or default) applies until the console sets a value; clearing goes back to the environment", async () => {
    expect(policy.quota.sitesPerUser).toBe(0);
    process.env.ARTIFACT_QUOTA_SITES_PER_USER = "7";
    expect(policy.quota.sitesPerUser).toBe(7);                         // environment, read live
    await updateSettings({ quotaSitesPerUser: 3 }, "usr_admin");
    expect(policy.quota.sitesPerUser).toBe(3);                         // console wins
    process.env.ARTIFACT_QUOTA_SITES_PER_USER = "9";
    expect(policy.quota.sitesPerUser).toBe(3);                         // still the console
    await updateSettings({ quotaSitesPerUser: null }, "usr_admin");
    expect(policy.quota.sitesPerUser).toBe(9);                         // back to the environment
    const view = (await describeSettings()).find((s) => s.key === "quotaSitesPerUser")!;
    expect(view).toMatchObject({ source: "environment", value: 9, envValue: 9, env: "ARTIFACT_QUOTA_SITES_PER_USER" });
  });

  it("a bad batch changes nothing; enums and integers are checked", async () => {
    await expect(updateSettings({ createPolicy: "everyone" }, null)).rejects.toThrow(/expected one of/);
    await expect(updateSettings({ anonSiteTtlDays: -1 }, null)).rejects.toThrow(/whole number/);
    await expect(updateSettings({ anonSiteTtlDays: 30, createPolicy: "bogus" }, null)).rejects.toThrow();
    expect((await describeSettings()).every((s) => s.source === "environment")).toBe(true); // the valid half was not written either
    await updateSettings({ anonSiteTtlDays: "30" }, null);            // numeric strings from a form are fine
    expect(policy.anonSiteTtlMs).toBe(30 * 86_400_000);
    await expect(updateSettings({ nope: 1 } as never, null)).rejects.toThrow(/Unknown setting/);
  });

  it("the runtime summary reports the effective policy, and warns when read-only has no enforcement to lean on", async () => {
    await updateSettings({ anonymousSites: "read-only", createPolicy: "open" }, null);
    const report = describeRuntime();
    expect(report.lines.find((l) => l.startsWith("create policy:"))).toContain("anonymous creators: read-only");
    expect(report.warnings.some((w) => w.includes("read-only") && w.includes("ARTIFACT_ENFORCE_OWNERSHIP"))).toBe(true);
  });
});

describe("the console API", () => {
  it("administrators only; PUT validates, applies, and logs the keys it changed", async () => {
    expect((await SETTINGS_GET(req("/api/admin/settings"))).status).toBe(401);
    const list = (await (await SETTINGS_GET(req("/api/admin/settings", { headers: asToken }))).json()) as { settings: { key: string; source: string }[] };
    expect(list.settings.map((s) => s.key)).toEqual(["createPolicy", "anonymousSites", "defaultVisibility", "anonSiteTtlDays", "quotaSitesPerUser", "quotaBytesPerUser", "quotaSitesPerAnon", "quotaBytesPerAnon", "oauthClientHosts", "oauthDcr", "oauthAppSchemes"]);
    const bad = await SETTINGS_PUT(req("/api/admin/settings", { method: "PUT", headers: asToken, body: { values: { defaultVisibility: "hidden" } } }));
    expect(bad.status).toBe(400);
    const ok = await SETTINGS_PUT(req("/api/admin/settings", { method: "PUT", headers: asToken, body: { values: { defaultVisibility: "unlisted", quotaSitesPerAnon: "5" } } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { changed: string[]; settings: { key: string; source: string; value: unknown }[] };
    expect(body.changed.sort()).toEqual(["defaultVisibility", "quotaSitesPerAnon"]);
    expect(body.settings.find((s) => s.key === "defaultVisibility")).toMatchObject({ source: "console", value: "unlisted" });
    expect(policy.defaultVisibility).toBe("unlisted");
    const log = await listAdminLog({ targetId: "settings" });
    expect(log[0]).toMatchObject({ action: "settings.update", actorKind: "token" });
    expect(log[0].reason).toContain("defaultVisibility=unlisted");
    // Saving the form as it stands: no write, no log row. Clearing a key that was never set: the same.
    const again = await SETTINGS_PUT(req("/api/admin/settings", { method: "PUT", headers: asToken, body: { values: { defaultVisibility: "unlisted", quotaSitesPerAnon: 5, createPolicy: null } } }));
    expect(((await again.json()) as { changed: string[] }).changed).toEqual([]);
    expect((await listAdminLog({ targetId: "settings" })).length).toBe(1);
    // A new site now takes the console's default.
    const { site } = await createSite({ mode: "paste", html: "<title>v</title><body>x</body>" }, { anonOwnerId: "anon_v" });
    expect(site.visibility).toBe("unlisted");
  });
});

describe("anonymous creators kept to reading", () => {
  beforeEach(() => {
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
    process.env.ARTIFACT_DEFAULT_VISIBILITY = "private";
    process.env.ARTIFACT_CREATE_POLICY = "open"; // PUBLISH_API_TOKEN alone would fail closed to "token"
  });
  const creator = { cookie: "__Host-ah_anon=anon_ro", origin: ORIGIN };

  it("read-only: the creating browser can open its private site but not edit, share, rename or delete; the permissions say sign in; full mode restores ownership; a claim hands everything to the account", async () => {
    await updateSettings({ anonymousSites: "read-only" }, null);
    const created = await CREATE(req("/api/sites", { method: "POST", headers: creator, body: { mode: "paste", html: "<title>ro</title><body>mine</body>" } }));
    expect(created.status).toBe(200);
    const { slug } = (await created.json()) as { slug: string };

    const own = await SITE_GET(req(`/api/sites/${slug}`, { headers: creator }), params({ slug }));
    expect(own.status).toBe(200);                                                             // private, yet readable by its creator
    expect((await PREVIEW(req(`/api/preview/${slug}`, { headers: creator }), params({ slug }))).status).toBe(200);
    expect((await SITE_GET(req(`/api/sites/${slug}`), params({ slug }))).status).toBe(404);   // and by nobody else
    const siteRow = ((await own.json()) as { site: { id: string } }).site;
    const perms = await describePermissions(req(`/s/${slug}`, { headers: creator }), (await getSite(siteRow.id))!);
    expect(perms).toMatchObject({ canEditContent: false, canManageSharing: false, canDelete: false, needsLogin: true });
    expect(perms.reason).toMatch(/Sign in to edit and share/);

    expect((await EDIT(req(`/api/sites/${slug}/edit`, { method: "POST", headers: creator, body: { content: "<title>x</title>" } }), params({ slug }))).status).toBe(403);
    expect((await SHARES(req(`/api/sites/${slug}/shares`, { method: "POST", headers: creator, body: { policy: "public" } }), params({ slug }))).status).toBe(403);
    expect((await SITE_PATCH(req(`/api/sites/${slug}`, { method: "PATCH", headers: creator, body: { title: "renamed" } }), params({ slug }))).status).toBe(403);
    expect((await SITE_DELETE(req(`/api/sites/${slug}`, { method: "DELETE", headers: creator }), params({ slug }))).status).toBe(403);

    // The operator flips the switch back: the same browser owns the site again, no rebuild, no new cookie.
    await updateSettings({ anonymousSites: "full" }, null);
    expect((await SITE_PATCH(req(`/api/sites/${slug}`, { method: "PATCH", headers: creator, body: { title: "renamed" } }), params({ slug }))).status).toBe(200);

    // Read-only again, then the creator signs in: the site is the account's, with everything.
    await updateSettings({ anonymousSites: "read-only" }, null);
    const user = await upsertUser({ authProvider: "t", providerSubject: "ro", email: "ro@example.net", emailVerified: true });
    const { cookie } = await mintSession(req("/"), user.id);
    expect(await setSiteOwnerIfUnowned(siteRow.id, user.id)).toBe(true);
    const asOwner = { cookie: cookie.split(";")[0], origin: ORIGIN };
    expect((await EDIT(req(`/api/sites/${slug}/edit`, { method: "POST", headers: asOwner, body: { content: "<title>x</title>" } }), params({ slug }))).status).toBe(200);
    expect((await SHARES(req(`/api/sites/${slug}/shares`, { method: "POST", headers: asOwner, body: { policy: "public" } }), params({ slug }))).status).toBe(201);
  });

  it("the environment variable alone does the same, and the console value must survive a cache refresh", async () => {
    process.env.ARTIFACT_ANONYMOUS_SITES = "read-only";
    expect(policy.anonymousSites).toBe("read-only");
    await updateSettings({ anonymousSites: "full" }, null);
    await refreshSettings();
    expect(policy.anonymousSites).toBe("full");
  });
});
