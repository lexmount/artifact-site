import { afterEach, expect, it } from "vitest";
import { closeDbForTests, rbacQuery, createId, upsertUser, createShare, getSite } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { accountSiteRole } from "@/lib/rbac-access";
import { putUserSiteRole } from "@/lib/role-bindings";

afterEach(closeDbForTests);
const postgres = process.env.ARTIFACT_DB_DRIVER === "postgres";
async function tables() {
  return (await rbacQuery(postgres
    ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()"
    : "SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name);
}
async function columns(table: string) {
  return (await rbacQuery(postgres
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1"
    : `PRAGMA table_info(${table})`, postgres ? [table] : [])).map(r => r.name);
}
it("removes retired authorization storage and never recreates it on restart", async () => {
  for (let start = 0; start < 2; start++) {
    for (const table of ["site_members", "site_collaborators", "site_invites", "rbac_migrations"]) expect(await tables()).not.toContain(table);
    expect(await columns("tenant_members")).not.toContain("role");
    expect(await columns("sites")).not.toContain("edit_policy");
    expect(await columns("sites")).not.toContain("claim_token");
    await closeDbForTests();
  }
});
it("keeps live grants and membership usable after restart", async () => {
  const owner = await upsertUser({ authProvider: "cleanup", providerSubject: createId("u") });
  const user = await upsertUser({ authProvider: "cleanup", providerSubject: createId("u") });
  const { site } = await createSite({ mode: "paste", html: "<p>kept</p>" }, { ownerId: owner.id });
  await putUserSiteRole(rbacQuery, site.id, user.id, "editor", owner.id);
  const before = await rbacQuery("SELECT * FROM role_bindings WHERE resource_site_id=$1", [site.id]);
  await closeDbForTests();
  expect(await accountSiteRole(site, { userId: user.id })).toBe("editor");
  expect(await rbacQuery("SELECT * FROM role_bindings WHERE resource_site_id=$1", [site.id])).toEqual(before);
});

it("upgrades PR1 without changing bindings, role catalog, membership or audit history", async () => {
  const { restorePreCleanupSchema } = await import("./fixtures/pre-cleanup-schema");
  const { putTenantAdmin } = await import("@/lib/role-bindings");
  const owner = await upsertUser({ authProvider: "cleanup", providerSubject: createId("u") });
  const user = await upsertUser({ authProvider: "cleanup", providerSubject: createId("u") });
  const revoked = await upsertUser({ authProvider: "cleanup", providerSubject: createId("u") });
  const { site } = await createSite({ mode: "paste", html: "<p>preserved</p>" }, { ownerId: owner.id });
  await putUserSiteRole(rbacQuery, site.id, user.id, "commenter", owner.id);
  await putTenantAdmin(rbacQuery, site.tenantId, owner.id, true, owner.id);
  await createShare({id:createId("share"),siteId:site.id,tokenHash:createId("hash"),policy:"login",passcodeHash:null,label:"Preserved link",createdBy:owner.id,createdAnonId:null,expiresAt:null});
  await rbacQuery("INSERT INTO rbac_audit(id,tenant_id,actor_id,action,target_id,reason,created_at) VALUES($1,$2,$3,'authorization.grant',$4,'Preserved audit',123)", [createId("audit"),site.tenantId,owner.id,site.id]);
  const originalSite = await getSite(site.id);
  await restorePreCleanupSchema();
  // Historical rows disagree with current grants: cleanup must not read/import them.
  await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'admin',1),($1,$3,'editor',1)", [site.id,user.id,revoked.id]);
  await rbacQuery("UPDATE tenant_members SET role='admin' WHERE user_id=$1", [revoked.id]);
  await rbacQuery("CREATE TABLE site_invites(id TEXT PRIMARY KEY)");
  await rbacQuery("INSERT INTO site_invites(id) VALUES('obsolete')");
  await rbacQuery("CREATE TABLE rbac_migrations(id TEXT PRIMARY KEY)");
  await rbacQuery("INSERT INTO rbac_migrations(id) VALUES('initial')");
  const preserved = ["role_bindings", "roles", "permissions", "role_permissions", "rbac_audit", "site_shares", "versions"];
  const snapshot = new Map<string, string>();
  const canonical = (rows: unknown[]) => JSON.stringify(rows.map(r => JSON.stringify(r)).sort());
  for (const table of preserved) snapshot.set(table, canonical(await rbacQuery(`SELECT * FROM ${table}`)));
  const members = canonical(await rbacQuery("SELECT tenant_id,user_id FROM tenant_members"));
  await closeDbForTests();
  for (const table of preserved) expect(canonical(await rbacQuery(`SELECT * FROM ${table}`))).toBe(snapshot.get(table));
  expect(canonical(await rbacQuery("SELECT tenant_id,user_id FROM tenant_members"))).toBe(members);
  expect(await getSite(site.id)).toEqual(originalSite);
  expect(await accountSiteRole(site, {userId:user.id})).toBe("commenter");
  expect(await accountSiteRole(site, {userId:revoked.id})).toBeNull();
  for (const table of ["site_members","site_collaborators","site_invites","rbac_migrations"]) expect(await tables()).not.toContain(table);
  const marker = await rbacQuery("SELECT * FROM schema_migrations WHERE id='0009-authorization-cleanup'");
  await closeDbForTests();
  expect(await rbacQuery("SELECT * FROM schema_migrations WHERE id='0009-authorization-cleanup'")).toEqual(marker);
});

it("rolls back a failed cleanup and safely retries without touching grants", async () => {
  const { restorePreCleanupSchema } = await import("./fixtures/pre-cleanup-schema");
  const { rbacTransaction } = await import("@/lib/db");
  const { up } = await import("@/lib/migrations/0009-authorization-cleanup");
  await restorePreCleanupSchema();
  const grants = await rbacQuery("SELECT * FROM role_bindings ORDER BY id");
  await expect(rbacTransaction(q => up(async (sql, params) => {
    if (sql === "DROP TABLE IF EXISTS site_members") throw new Error("Injected cleanup failure");
    return q(sql,params);
  }, postgres ? "postgres" : "sqlite"))).rejects.toThrow("Injected cleanup failure");
  expect(await tables()).toContain("site_collaborators");
  expect(await columns("tenant_members")).toContain("role");
  expect(await rbacQuery("SELECT * FROM role_bindings ORDER BY id")).toEqual(grants);
  await closeDbForTests();
  expect(await tables()).not.toContain("site_collaborators");
  expect(await rbacQuery("SELECT * FROM role_bindings ORDER BY id")).toEqual(grants);
  await rbacTransaction(q => up(q, postgres ? "postgres" : "sqlite"));
});
