import { afterEach, expect, it, vi } from "vitest";
import { closeDbForTests, createId, getUser, rbacQuery, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { creationTenant, changeTenantMember, accountSiteRole } from "@/lib/rbac-access";
import { putTenantAdmin } from "@/lib/role-bindings";
import { createSite } from "@/lib/sites";
import { POST, GET } from "@/app/api/tenants/route";
import { PATCH as settings } from "@/app/api/tenants/[tenantId]/route";
import { PATCH as changeDefault } from "@/app/api/admin/users/[id]/tenant/route";
import { GET as availability } from "@/app/api/admin/tenants/availability/route";

const origin = "https://tenant.example";
function req(body?: unknown, cookie = "", admin = true) {
  vi.stubEnv("PUBLISH_API_TOKEN", "tenant-test-operator");
  return new Request(origin + "/api/tenants", { method: body ? "POST" : "GET", headers: { origin, cookie, ...(admin ? { authorization: "Bearer tenant-test-operator" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function user() {
  const u = await upsertUser({ authProvider: "test", providerSubject: createId("subject"), email: createId("email") + "@example.com", emailVerified: true });
  const { session, cookie } = await mintSession(new Request(origin), u.id);
  return { u, session, cookie: cookie.split(";")[0] };
}
async function tenant(adminId: string, slug = createId("space").toLowerCase().replaceAll("_", "-")) {
  const response = await POST(req({ slug, name: "Example team", adminUserId: adminId }));
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}
afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });

it("creates opaque IDs, normalizes globally unique slugs, and preserves default membership", async () => {
  const { u } = await user();
  const id = await tenant(u.id, "Product-Dev");
  expect(id).not.toBe("product-dev");
  expect(id).toMatch(/^tenant_/);
  expect(await rbacQuery("SELECT slug FROM tenants WHERE id=$1", [id])).toEqual([{ slug: "product-dev" }]);
  expect((await getUser(u.id))?.tenantId).toBe("init");
  expect((await POST(req({ slug: "product-dev", name: "Duplicate", adminUserId: u.id }))).status).toBe(409);
  expect((await POST(req({ slug: "anonymous", name: "Invalid", adminUserId: u.id }))).status).toBe(400);
  const list = await (await GET(req())).json();
  expect(list.tenants.find((t: { id: string }) => t.id === id).slug).toBe("product-dev");
  const check = new Request(origin + "/api/admin/tenants/availability?slug=PRODUCT-DEV", { headers: { authorization: "Bearer tenant-test-operator" } });
  expect((await (await availability(check)).json()).available).toBe(false);
  await expect(rbacQuery("INSERT INTO tenants(id,name,slug) VALUES('collision','Collision','PRODUCT-DEV')")).rejects.toThrow();
});

it("switches only the default and preserves old artifacts, roles and explicit publishing", async () => {
  const { u, session } = await user();
  await putTenantAdmin(rbacQuery, "init", u.id, true, null);
  const old = (await createSite({ mode: "paste", html: "<h1>Old</h1>" }, { ownerId: u.id })).site;
  const other = await user();
  const id = await tenant(other.u.id);
  const context = { params: Promise.resolve({ id: u.id }) };
  expect((await changeDefault(req({ tenantId: id }), context)).status).toBe(200);
  expect(await creationTenant(u.id)).toBe(id);
  expect(await creationTenant(u.id, "init")).toBe("init");
  expect(await accountSiteRole(old, session)).toBe("owner");
  expect(await rbacQuery("SELECT role FROM authorization_tenant_members WHERE tenant_id='init' AND user_id=$1", [u.id])).toEqual([{ role: "admin" }]);
  expect(await rbacQuery("SELECT role FROM authorization_tenant_members WHERE tenant_id=$1 AND user_id=$2", [id, u.id])).toEqual([{ role: "member" }]);
  await putTenantAdmin(rbacQuery, id, u.id, true, null);
  expect((await changeDefault(req({ tenantId: id }), context)).status).toBe(200);
  expect(await rbacQuery("SELECT role FROM authorization_tenant_members WHERE tenant_id=$1 AND user_id=$2", [id, u.id])).toEqual([{ role: "admin" }]);
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='user.default_tenant.change' AND target_id=$1", [u.id])).toHaveLength(1);
  const fresh = (await createSite({ mode: "paste", html: "<h1>New</h1>" }, { ownerId: u.id })).site;
  expect(fresh.tenantId).toBe(id);
  const explicit = (await createSite({ mode: "paste", html: "<h1>Explicit</h1>" }, { ownerId: u.id, tenantId: "init" })).site;
  expect(explicit.tenantId).toBe("init");
  expect(await rbacQuery("SELECT tenant_id FROM sites WHERE id=$1", [old.id])).toEqual([{ tenant_id: "init" }]);
  await expect(changeTenantMember(req(), id, u.id, null)).rejects.toThrow(/default publishing workspace/);
});

it("rejects ordinary users, cross-site requests, disabled targets and system tenant changes", async () => {
  const { u, cookie } = await user();
  const id = await tenant(u.id);
  const context = { params: Promise.resolve({ id: u.id }) };
  expect((await changeDefault(req({ tenantId: id }, cookie, false), context)).status).toBe(401);
  vi.stubEnv("ARTIFACT_ADMIN_EMAILS", u.email!);
  const cross = new Request(origin + "/api/test", { method: "PATCH", headers: { cookie, origin: "https://foreign.example" }, body: JSON.stringify({ tenantId: id }) });
  expect((await changeDefault(cross, context)).status).toBe(401);
  await rbacQuery("UPDATE tenants SET disabled_at=1 WHERE id=$1", [id]);
  expect((await changeDefault(req({ tenantId: id }), context)).status).toBe(400);
  expect((await getUser(u.id))?.tenantId).toBe("init");
  expect((await changeDefault(req({ tenantId: "anonymous" }), context)).status).toBe(400);
  expect((await settings(req({ disabled: true }), { params: Promise.resolve({ tenantId: "init" }) })).status).toBe(400);
  expect((await settings(req({ slug: "changed" }), { params: Promise.resolve({ tenantId: id }) })).status).toBe(400);
});

it("serializes duplicate creation and competing member removal with default changes", async () => {
  const { u } = await user();
  const slug = "concurrent-" + createId("t").slice(-8).toLowerCase();
  const responses = await Promise.all([POST(req({ slug, name: "One", adminUserId: u.id })), POST(req({ slug, name: "Two", adminUserId: u.id }))]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  const id = (await responses.find(r => r.status === 201)!.json()).id;
  const target = await user();
  await changeTenantMember(req(), id, target.u.id, "member");
  await Promise.allSettled([
    changeDefault(req({ tenantId: id }), { params: Promise.resolve({ id: target.u.id }) }),
    changeTenantMember(req(), id, target.u.id, null),
  ]);
  expect((await getUser(target.u.id))?.tenantId).toBe(id);
  expect(await rbacQuery("SELECT user_id FROM tenant_members WHERE tenant_id=$1 AND user_id=$2", [id, target.u.id])).toHaveLength(1);
});

it("rolls back membership and the default if the audit cannot commit", async () => {
  const { u } = await user();
  const other = await user();
  const id = await tenant(other.u.id);
  const { changeDefaultTenant } = await import("@/lib/tenant-management");
  const audit = await import("@/lib/rbac-access");
  const spy = vi.spyOn(audit, "recordRbacAudit").mockRejectedValueOnce(new Error("Audit unavailable"));
  try { await expect(changeDefaultTenant(req(), u.id, id)).rejects.toThrow("Audit unavailable"); }
  finally { spy.mockRestore(); }
  expect((await getUser(u.id))?.tenantId).toBe("init");
  expect(await rbacQuery("SELECT user_id FROM tenant_members WHERE tenant_id=$1 AND user_id=$2", [id, u.id])).toHaveLength(0);
});

it("backfills legacy slugs without changing references and can run idempotently", async () => {
  const { up } = await import("@/lib/migrations/0017-tenant-slugs");
  const legacy = createId("legacy");
  const { u } = await user();
  await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Legacy')", [legacy]);
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)", [legacy, u.id]);
  const dialect = process.env.ARTIFACT_DB_DRIVER === "postgres" ? "postgres" : "sqlite";
  await up(rbacQuery, dialect);
  await up(rbacQuery, dialect);
  expect(await rbacQuery("SELECT slug FROM tenants WHERE id=$1", [legacy])).toEqual([{ slug: legacy }]);
  expect(await rbacQuery("SELECT tenant_id FROM tenant_members WHERE tenant_id=$1 AND user_id=$2", [legacy, u.id])).toEqual([{ tenant_id: legacy }]);
});

it("cleans up a disabled account without restoring its sessions or publish tokens", async () => {
  const { disableUser } = await import("@/lib/admin");
  const { insertPublishToken } = await import("@/lib/db");
  const { resolveSession } = await import("@/lib/session");
  const { hashTokenSecret } = await import("@/lib/publish-token");
  const account = await user(), manager = await user();
  const destination = await tenant(manager.u.id);
  const secret = "ahp_" + createId("secret");
  const tokenId = hashTokenSecret(secret);
  await insertPublishToken({ id: tokenId, userId: account.u.id, name: "Offboarding", createdAt: Date.now() });
  await disableUser(req(), { kind: "token", userId: null }, account.u.id, "Offboarding");
  const before = await getUser(account.u.id);
  const sessions = await rbacQuery("SELECT id,revoked_at FROM sessions WHERE user_id=$1", [account.u.id]);
  const tokens = await rbacQuery("SELECT id,revoked_at FROM publish_tokens WHERE user_id=$1", [account.u.id]);
  expect(sessions.every(row => row.revoked_at != null)).toBe(true);
  expect(tokens.every(row => row.revoked_at != null)).toBe(true);
  expect((await changeDefault(req({ tenantId: destination }), { params: Promise.resolve({ id: account.u.id }) })).status).toBe(200);
  await expect(changeTenantMember(req(), "init", account.u.id, null)).resolves.toBeUndefined();
  const after = await getUser(account.u.id);
  expect(after).toMatchObject({ tenantId: destination, disabledAt: before!.disabledAt, disabledReason: "Offboarding" });
  expect(after!.disabledAt).not.toBeNull();
  expect(await rbacQuery("SELECT id,revoked_at FROM sessions WHERE user_id=$1", [account.u.id])).toEqual(sessions);
  expect(await rbacQuery("SELECT id,revoked_at FROM publish_tokens WHERE user_id=$1", [account.u.id])).toEqual(tokens);
  expect(await resolveSession(req(undefined, account.cookie, false))).toBeNull();
  expect(await rbacQuery("SELECT tenant_id FROM tenant_members WHERE tenant_id='init' AND user_id=$1", [account.u.id])).toHaveLength(0);
});

it("restores legacy disabled init after migration but still rejects disabling it", async () => {
  const { up } = await import("@/lib/migrations/0017-tenant-slugs");
  const { cookie } = await user();
  await rbacQuery("UPDATE tenants SET disabled_at=123 WHERE id='init'");
  try {
    await up(rbacQuery, process.env.ARTIFACT_DB_DRIVER === "postgres" ? "postgres" : "sqlite");
    const context = { params: Promise.resolve({ tenantId: "init" }) };
    expect((await settings(req({ disabled: false }, cookie, false), context)).status).toBe(403);
    expect((await settings(req({ disabled: false }), context)).status).toBe(200);
    expect(await rbacQuery("SELECT disabled_at FROM tenants WHERE id='init'")).toEqual([{ disabled_at: null }]);
    expect((await settings(req({ disabled: true }), context)).status).toBe(400);
    const [audit] = await rbacQuery("SELECT reason FROM rbac_audit WHERE tenant_id='init' AND action='tenant.update' ORDER BY created_at DESC LIMIT 1");
    expect(JSON.parse(audit.reason as string)).toMatchObject({ before: { disabled_at: 123 }, after: { disabled: false } });
  } finally { await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id='init'"); }
});
