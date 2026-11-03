import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDbForTests, createId, getSite, rbacQuery, upsertUser } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { siteSharingChange, getSiteSharing, scopeChange } from "@/lib/sharing-defaults";
import { managedMainPasscode } from "@/lib/main-passcode";
import { putTenantAdmin } from "@/lib/role-bindings";
import { POST } from "@/app/api/me/sharing/batch/route";
const origin = "https://batch.test";
beforeEach(() => { vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "private"); });
afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });
async function fixture() {
  const user = await upsertUser({ authProvider: "batch", providerSubject: createId("user") });
  const { cookie } = await mintSession(new Request(origin), user.id);
  const request = new Request(origin, { method: "POST", headers: { cookie, origin } });
  const sites: Awaited<ReturnType<typeof createSite>>["site"][] = [];
  for (let i = 0; i < 3; i++) sites.push((await createSite({ mode: "paste", html: `<h1>Batch ${i}</h1>` }, { ownerId: user.id })).site);
  const call = (body: unknown, extra: Record<string, string> = {}) => POST(new Request(origin + "/api/me/sharing/batch", { method: "POST", headers: { cookie, origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) }));
  const apply = async (changes: object, slugs = sites.slice(0, 2).map(s => s.slug)) => {
    const preview = await call({ slugs, changes });
    expect(preview.status).toBe(200);
    const data = await preview.json();
    const result = await call({ slugs, changes, confirmation: data.confirmation, expectedSnapshot: data.snapshot });
    expect(result.status).toBe(200);
    return result.json();
  };
  return { user, cookie, request, sites, call, apply };
}
async function managementFixture(role: "tenant" | "platform") {
  const f = await fixture();
  const manager = await upsertUser({ authProvider: "batch", providerSubject: createId("manager"), email: `${createId("manager")}@example.test`, emailVerified: true });
  if (role === "tenant") await putTenantAdmin(rbacQuery, f.sites[0].tenantId, manager.id, true, f.user.id);
  else vi.stubEnv("ARTIFACT_ADMIN_EMAILS", manager.email!);
  const { cookie } = await mintSession(new Request(origin), manager.id);
  const reason = "Apply the owner's requested sharing correction";
  const call = (body: unknown) => f.call(body, { cookie, "x-management-reason": reason });
  const audit = () => rbacQuery("SELECT tenant_id,actor_id,target_id,reason FROM rbac_audit WHERE action='site.management' AND actor_id=$1 ORDER BY target_id", [manager.id]);
  return { ...f, manager, reason, call, audit, managerCookie: cookie };
}
it.each([
  ["tenant", 1], ["tenant", 2], ["platform", 1], ["platform", 2],
] as const)("audits %s management only for confirmed changes to %i sites", async (role, count) => {
  const f = await managementFixture(role), sites = f.sites.slice(0, count);
  const body = { slugs: sites.map(site => site.slug), changes: { comments: false } };
  expect((await f.call({ ...body, confirmation: "invalid" })).status).toBe(409);
  expect((await f.call({ ...body, expectedSnapshot: "stale" })).status).toBe(409);
  const preview = await f.call(body);
  expect(preview.status).toBe(200);
  expect(await f.audit()).toEqual([]);
  for (const site of sites) expect((await getSiteSharing(site)).policy.comments).toBe(true);
  const { snapshot, confirmation } = await preview.json();
  expect((await POST(new Request(origin + "/api/me/sharing/batch", { method: "POST", headers: { cookie: f.managerCookie, origin, "content-type": "application/json" }, body: JSON.stringify({ ...body, confirmation }) }))).status).toBe(403);
  expect(await f.audit()).toEqual([]);
  const saved = await f.call({ ...body, confirmation, expectedSnapshot: snapshot });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ applied: true, updated: count });
  const events = await f.audit();
  expect(events).toEqual(sites.map(site => ({ tenant_id: site.tenantId, actor_id: f.manager.id, target_id: site.id, reason: f.reason })).sort((a, b) => a.target_id.localeCompare(b.target_id)));
  for (const site of sites) expect((await getSiteSharing(site)).policy.comments).toBe(false);
  const retry = await (await f.call(body)).json();
  const unchanged = await f.call({ ...body, confirmation: retry.confirmation });
  expect(unchanged.status).toBe(200);
  expect(await unchanged.json()).toMatchObject({ updated: 0, unchanged: count });
  expect(await f.audit()).toEqual(events);
});
it("does not audit an owner's batch as a management override", async () => {
  const f = await fixture();
  await putTenantAdmin(rbacQuery, f.sites[0].tenantId, f.user.id, true, f.user.id);
  const body = { slugs: [f.sites[0].slug], changes: { comments: false } };
  const headers = { "x-management-reason": "Update my own site" };
  const preview = await (await f.call(body, headers)).json();
  const saved = await f.call({ ...body, confirmation: preview.confirmation }, headers);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ updated: 1 });
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.management' AND target_id=$1", [f.sites[0].id])).toEqual([]);
});
it("rolls back management reasons and policy audits when a later batch write fails", async () => {
  const f = await managementFixture("tenant");
  const body = { slugs: f.sites.slice(0, 2).map(site => site.slug), changes: { comments: false } };
  const preview = await (await f.call(body)).json();
  const mutations = await import("@/lib/sharing-mutations"), original = mutations.putState;
  const observedAudits: number[] = [];
  const spy = vi.spyOn(mutations, "putState").mockImplementation(async (...args) => {
    observedAudits.push((await args[0]("SELECT id FROM rbac_audit WHERE action='site.management' AND actor_id=$1", [f.manager.id])).length);
    if (observedAudits.length === 2) throw new Error("Injected storage failure");
    return original(...args);
  });
  try {
    expect((await f.call({ ...body, confirmation: preview.confirmation })).status).toBe(500);
    expect(observedAudits).toEqual([1, 2]);
    expect(await f.audit()).toEqual([]);
    expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='sharing.main' AND target_id IN ($1,$2)", f.sites.slice(0, 2).map(site => site.id))).toEqual([]);
    for (const site of f.sites) expect((await getSiteSharing(site)).policy.comments).toBe(true);
  } finally { spy.mockRestore(); }
});
it("previews without writes and applies only selected explicit fields atomically", async () => {
  const f = await fixture(), [a, b, untouched] = f.sites;
  await siteSharingChange(f.request, a.id, { action: "custom", policy: { audience: "public", comments: true } });
  await siteSharingChange(f.request, b.id, { action: "custom", policy: { audience: "passcode", comments: false } });
  const code = await managedMainPasscode(b.id), original = await getSiteSharing(untouched);
  const preview = await f.call({ slugs: [a.slug, b.slug], changes: { comments: false } });
  expect(preview.status).toBe(200);
  expect((await getSiteSharing(a)).policy.comments).toBe(true);
  expect(await f.apply({ comments: false })).toMatchObject({ applied: true, updated: 1, unchanged: 1, pending: 0 });
  expect(await getSiteSharing(a)).toMatchObject({ policy: { audience: "public", comments: false } });
  expect(await getSiteSharing(b)).toMatchObject({ policy: { audience: "passcode", comments: false } });
  expect(await managedMainPasscode(b.id)).toBe(code);
  expect(await getSiteSharing(untouched)).toEqual(original);
  expect(await f.apply({ comments: false })).toMatchObject({ updated: 0, unchanged: 2 });
  expect(await f.apply({ audience: "anyone" })).toMatchObject({ updated: 1, unchanged: 1 });
  expect((await getSiteSharing(a)).policy.audience).toBe("public");
  expect((await getSiteSharing(b)).policy.audience).toBe("anyone");
  expect((await getSite(b.id))?.visibility).toBe("unlisted");
});
it("does not detach unchanged followers, and only detaches sites whose settings change", async () => {
  const f = await fixture();
  const input = { enabled: true, policy: { audience: "login" as const, comments: true } };
  const preview = await scopeChange(f.request, null, input);
  await scopeChange(f.request, null, { ...input, confirmation: preview.confirmation });
  expect(await f.apply({ comments: true })).toMatchObject({ updated: 0, unchanged: 2 });
  expect((await getSiteSharing(f.sites[0])).source).toBe("all");
  expect(await f.apply({ comments: false })).toMatchObject({ updated: 2 });
  expect((await getSiteSharing(f.sites[0])).source).toBe("manual");
  expect((await getSiteSharing(f.sites[2])).source).toBe("all");
});
it("rejects stale opening snapshots and stale confirmations before any site changes", async () => {
  const f = await fixture(), slugs = f.sites.slice(0, 2).map(s => s.slug), changes = { audience: "anyone" };
  const preview = await (await f.call({ slugs, changes })).json();
  await siteSharingChange(f.request, f.sites[1].id, { action: "custom", policy: { audience: "login", comments: false } });
  expect((await f.call({ slugs, changes, expectedSnapshot: preview.snapshot })).status).toBe(409);
  expect((await f.call({ slugs, changes, confirmation: preview.confirmation })).status).toBe(409);
  expect((await getSiteSharing(f.sites[0])).policy.audience).toBe("private");
});
it("checks every target and CSRF before exposing a preview or applying writes", async () => {
  const f = await fixture(), other = await fixture(), changes = { audience: "anyone" };
  const mixed = [f.sites[0].slug, other.sites[0].slug];
  expect([403, 404]).toContain((await f.call({ slugs: mixed, changes })).status);
  expect((await f.call({ slugs: [f.sites[0].slug], changes }, { origin: "https://evil.test" })).status).toBe(403);
  const slugs = f.sites.slice(0, 2).map(s => s.slug);
  const preview = await (await f.call({ slugs, changes })).json();
  await rbacQuery("UPDATE sites SET owner_id=$1 WHERE id=$2", [other.user.id, f.sites[1].id]);
  expect([403, 404]).toContain((await f.call({ slugs, changes, confirmation: preview.confirmation })).status);
  expect((await getSiteSharing(f.sites[0])).policy.audience).toBe("private");
});
it("rejects expired credentials, duplicate targets, passcodes and discovery expansion", async () => {
  const f = await fixture(), slugs = [f.sites[0].slug];
  for (const changes of [{ audience: "public" }, { audience: "passcode" }, { comments: "yes" }, { unknown: true }]) expect((await f.call({ slugs, changes })).status).toBe(400);
  expect((await f.call({ slugs: [...slugs, ...slugs], changes: {} })).status).toBe(400);
  const preview = await (await f.call({ slugs, changes: { comments: false } })).json();
  await rbacQuery("UPDATE sessions SET revoked_at=$1 WHERE user_id=$2", [Date.now(), f.user.id]);
  expect((await f.call({ slugs, changes: { comments: false }, confirmation: preview.confirmation })).status).toBe(401);
});
it("keeps discussion visibility and independent grants when making main links private", async () => {
  const f = await fixture(), a = f.sites[0];
  await siteSharingChange(f.request, a.id, { action: "custom", policy: { audience: "anyone", comments: true } });
  await rbacQuery("UPDATE site_comment_settings SET main_policy='members',reader_access=0 WHERE site_id=$1", [a.id]);
  const reader = await upsertUser({ authProvider: "batch", providerSubject: createId("reader") });
  const { putUserSiteRole } = await import("@/lib/role-bindings");
  await putUserSiteRole(rbacQuery, a.id, reader.id, "viewer", f.user.id);
  const { POST: createShare } = await import("@/app/api/sites/[slug]/shares/route");
  const response = await createShare(new Request(origin, { method: "POST", headers: { origin, cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify({ policy: "public" }) }), { params: Promise.resolve({ slug: a.slug }) });
  expect(response.status).toBe(201);
  const link = await response.json();
  await f.apply({ audience: "private" });
  expect(await rbacQuery("SELECT role_id FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2", [a.id, reader.id])).toMatchObject([{ role_id: "viewer" }]);
  const { resolveShareAccess } = await import("@/lib/share");
  expect((await resolveShareAccess(new Request(origin), link.token)).ok).toBe(true);
  expect(await rbacQuery("SELECT main_policy,reader_access FROM site_comment_settings WHERE site_id=$1", [a.id])).toMatchObject([{ main_policy: "members", reader_access: 0 }]);
});
it.each([false, true])("preserves the audit history without treating an already applied retry as a new change (listing: %s)", async listInDiscover => {
  const f = await fixture();
  const first = await f.apply({ audience: "anyone", comments: false, listInDiscover });
  expect(first.updated + first.pending).toBe(2);
  const audit = await rbacQuery("SELECT id FROM rbac_audit WHERE action='sharing.main'");
  const second = await f.apply({ audience: "anyone", comments: false, listInDiscover });
  expect(second.updated).toBe(0);
  expect(second.unchanged + second.pending).toBe(2);
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='sharing.main'")).toHaveLength(audit.length);
});
it("rejects revoked member grants between preview and commit without changing earlier targets", async () => {
  const f = await fixture(), owner = await fixture();
  const { putUserSiteRole } = await import("@/lib/role-bindings");
  await putUserSiteRole(rbacQuery, owner.sites[0].id, f.user.id, "admin", null);
  const slugs = [f.sites[0].slug, owner.sites[0].slug], changes = { comments: false };
  const preview = await f.call({ slugs, changes });
  expect(preview.status).toBe(200);
  const { confirmation } = await preview.json();
  await rbacQuery("DELETE FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2", [owner.sites[0].id, f.user.id]);
  expect((await f.call({ slugs, changes, confirmation })).status).toBe(403);
  expect((await getSiteSharing(f.sites[0])).policy.comments).toBe(true);
});
it.each(["deleted_at", "taken_down_at"])("rejects a target with %s after preview", async field => {
  const f = await fixture(), slugs = f.sites.slice(0, 2).map(s => s.slug), changes = { comments: false };
  const preview = await (await f.call({ slugs, changes })).json();
  await rbacQuery(`UPDATE sites SET ${field}=$1 WHERE id=$2`, [Date.now(), f.sites[1].id]);
  expect([403, 404]).toContain((await f.call({ slugs, changes, confirmation: preview.confirmation })).status);
  expect((await getSiteSharing(f.sites[0])).policy.comments).toBe(true);
});
it("rejects revoked explicit bearer credentials even with a valid session cookie", async () => {
  const f = await fixture();
  const { hashTokenSecret } = await import("@/lib/publish-token");
  const { insertPublishToken } = await import("@/lib/db");
  const secret = "ahp_batch-revoked";
  await insertPublishToken({ id: hashTokenSecret(secret), userId: f.user.id, name: "batch", createdAt: Date.now() });
  await rbacQuery("UPDATE publish_tokens SET revoked_at=$1 WHERE id=$2", [Date.now(), hashTokenSecret(secret)]);
  expect((await f.call({ slugs: [f.sites[0].slug], changes: {} }, { authorization: `Bearer ${secret}` })).status).toBe(401);
});
it("offers organization access only when every selected site and the user have an organization", async () => {
  const f = await fixture(), slugs = [f.sites[0].slug];
  expect(await (await f.call({ slugs, changes: {} })).json()).toMatchObject({ canSelectOrganization: false });
  expect((await f.call({ slugs, changes: { audience: "tenant" } })).status).toBe(400);
  const tenant = createId("org");
  await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Organization')", [tenant]);
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [tenant, f.user.id]);
  await rbacQuery("UPDATE users SET tenant_id=$1 WHERE id=$2", [tenant, f.user.id]);
  await rbacQuery("UPDATE sites SET tenant_id=$1 WHERE id=$2", [tenant, f.sites[0].id]);
  expect(await (await f.call({ slugs, changes: {} })).json()).toMatchObject({ canSelectOrganization: true });
  const mixedSlugs = [f.sites[0].slug, f.sites[1].slug];
  expect(await (await f.call({ slugs: mixedSlugs, changes: {} })).json()).toMatchObject({ canSelectOrganization: false });
  expect((await f.call({ slugs: mixedSlugs, changes: { audience: "tenant" } })).status).toBe(400);
  for (const site of f.sites.slice(0, 2)) expect((await getSiteSharing(site)).policy.audience).toBe("private");
  expect(await f.apply({ audience: "tenant" }, slugs)).toMatchObject({ updated: 1 });
});
it.each([{ comments: false }, { audience: "anyone", listInDiscover: true }, { audience: "anyone", listInDiscover: false }])("rolls back every policy and audit row if a later write fails: %j", async changes => {
  const f = await fixture(), slugs = f.sites.slice(0, 2).map(s => s.slug);
  if (changes.listInDiscover === false) {
    for (const site of f.sites.slice(0, 2)) await siteSharingChange(f.request, site.id, { action: "custom", policy: { audience: "public", comments: true } });
  }
  const before = await Promise.all(f.sites.map(site => getSiteSharing(site)));
  const mutations = await import("@/lib/sharing-mutations");
  const original = mutations.putState;
  let calls = 0;
  const spy = vi.spyOn(mutations, "putState").mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error("Injected storage failure");
    return original(...args);
  });
  const audit = await rbacQuery("SELECT id FROM rbac_audit WHERE action='sharing.main'");
  try {
    const preview = await (await f.call({ slugs, changes })).json();
    expect((await f.call({ slugs, changes, confirmation: preview.confirmation })).status).toBe(500);
    expect(await Promise.all(f.sites.map(site => getSiteSharing(site)))).toEqual(before);
    expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='sharing.main'")).toHaveLength(audit.length);
  } finally { spy.mockRestore(); }
});
it("preserves omitted Discover settings and applies explicit listing or unlisting to every selected site", async () => {
  const f = await fixture(), [listed, unlisted, untouched] = f.sites;
  await siteSharingChange(f.request, listed.id, { action: "custom", policy: { audience: "public", comments: true } });
  const original = await getSiteSharing(listed);
  expect(await f.apply({ audience: "anyone" })).toMatchObject({ updated: 1, unchanged: 1 });
  expect(await getSiteSharing(listed)).toEqual(original);
  expect((await getSiteSharing(unlisted)).policy.audience).toBe("anyone");
  expect(await f.apply({ audience: "anyone", listInDiscover: true })).toMatchObject({ updated: 1, unchanged: 1 });
  expect((await getSiteSharing(unlisted)).policy.audience).toBe("public");
  expect((await getSite(unlisted.id))?.visibility).toBe("public");
  expect(await f.apply({ audience: "anyone", listInDiscover: false })).toMatchObject({ updated: 2, unchanged: 0 });
  for (const site of [listed, unlisted]) {
    expect((await getSiteSharing(site)).policy).toEqual({ audience: "anyone", comments: true });
    expect((await getSite(site.id))?.visibility).toBe("unlisted");
  }
  expect(await f.apply({ audience: "anyone", listInDiscover: false })).toMatchObject({ updated: 0, unchanged: 2 });
  expect((await getSiteSharing(untouched)).policy.audience).toBe("private");
});
it("binds Discover opt-in to the preview confirmation without premature writes", async () => {
  const f = await fixture(), slugs = f.sites.slice(0, 2).map(site => site.slug);
  const changes = { audience: "anyone", listInDiscover: true };
  const plain = await (await f.call({ slugs, changes: { audience: "anyone" } })).json();
  expect((await f.call({ slugs, changes, confirmation: plain.confirmation })).status).toBe(409);
  const response = await f.call({ slugs, changes });
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.items.every((item: { after: { audience: string } }) => item.after.audience === "public")).toBe(true);
  expect((await f.call({ slugs, changes: { ...changes, listInDiscover: false }, confirmation: preview.confirmation })).status).toBe(409);
  for (const site of f.sites) expect((await getSiteSharing(site)).policy.audience).toBe("private");
});
it("requires anyone access for a Discover choice", async () => {
  const f = await fixture(), slugs = [f.sites[0].slug];
  for (const changes of [{ listInDiscover: true }, { audience: "private", listInDiscover: true }, { audience: "login", listInDiscover: false }, { audience: "anyone", listInDiscover: "yes" }]) {
    expect((await f.call({ slugs, changes })).status).toBe(400);
  }
});
it("requires write scope for authenticated OAuth clients", async () => {
  const f = await fixture();
  const { insertOauthTokens } = await import("@/lib/db");
  const { hashTokenSecret, OAUTH_ACCESS_TOKEN_PREFIX } = await import("@/lib/publish-token");
  const { SCOPE_READ } = await import("@/lib/oauth-shared");
  const secret = OAUTH_ACCESS_TOKEN_PREFIX + "batch-read-only", now = Date.now();
  await insertOauthTokens([{ id: hashTokenSecret(secret), kind: "access", grantId: createId("grant"), userId: f.user.id, clientId: "https://client.test", clientName: "Batch client", scope: SCOPE_READ, resource: origin + "/mcp", grantCreatedAt: now, createdAt: now, expiresAt: now + 60000, absoluteExpiresAt: now + 60000, lastUsedAt: null, revokedAt: null }]);
  expect((await f.call({ slugs: [f.sites[0].slug], changes: {} }, { authorization: `Bearer ${secret}` })).status).toBe(403);
});
