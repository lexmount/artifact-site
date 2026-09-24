import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import pg from "pg";
import { closeDbForTests, getSite, rbacQuery } from "@/lib/db";
import { accountSiteRole, memberRole } from "@/lib/rbac-access";

it.skipIf(!process.env.ARTIFACT_DATABASE_URL)("upgrades populated 0.2.0 through full Postgres startup, then preserves revocation on restart", async () => {
  const originalUrl = process.env.ARTIFACT_DATABASE_URL!;
  const originalDriver = process.env.ARTIFACT_DB_DRIVER;
  const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: originalUrl, max: 1 });
  const isolated = new URL(originalUrl);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  const old = new pg.Pool({ connectionString: isolated.toString(), max: 1 });
  await closeDbForTests();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await old.query(readFileSync("test/fixtures/pre-rbac-0.2.0.sql", "utf8"));
    await old.query(readFileSync("test/fixtures/pre-rbac-grants.sql", "utf8"));
    expect((await old.query("SELECT id FROM rbac_migrations WHERE id='initial'")).rowCount).toBe(1);
    expect((await old.query("SELECT id FROM schema_migrations WHERE id LIKE '0007%'")).rowCount).toBe(0);
    const oldMarkers = (await old.query("SELECT * FROM schema_migrations ORDER BY id")).rows;
    const membership = (await old.query("SELECT tenant_id,user_id FROM tenant_members ORDER BY user_id")).rows;
    process.env.ARTIFACT_DATABASE_URL = isolated.toString();
    process.env.ARTIFACT_DB_DRIVER = "postgres";
    // First facade call initializes the actual store, base schema, lock and all numbered migrations.
    const site = (await getSite("upgrade-site"))!;
    expect(site.tenantId).toBe("upgrade-workspace");
    expect(site.ownerId).toBe("upgrade-owner");
    expect((await getSite("upgrade-anon"))?.editToken).toBe("preserved-anonymous-token");
    expect(await rbacQuery("SELECT * FROM schema_migrations WHERE id<'0007' ORDER BY id")).toEqual(oldMarkers);
    expect(await rbacQuery("SELECT tenant_id,user_id FROM tenant_members ORDER BY user_id")).toEqual(membership);
    expect(await memberRole("upgrade-workspace", "upgrade-admin")).toBe("admin");
    expect(await rbacQuery("SELECT id,role_id FROM role_bindings WHERE resource_type='tenant'")).toEqual([
      { id: "migrated-tenant:upgrade-workspace:upgrade-admin", role_id: "tenant-admin" },
    ]);
    for (const [user, role] of [["editor", "editor"], ["manager", "site-admin"], ["disabled", "editor"]]) {
      expect(await rbacQuery("SELECT id,role_id,created_by,created_at,updated_at,revision FROM role_bindings WHERE subject_user_id=$1", [`upgrade-${user}`])).toEqual([
        { id: `migrated-site:upgrade-site:upgrade-${user}`, role_id: role, created_by: "upgrade-owner", created_at: 12345, updated_at: 12345, revision: 1 },
      ]);
      expect(await accountSiteRole(site, { userId: `upgrade-${user}` })).toBe(user === "disabled" ? null : role);
    }
    expect(await rbacQuery("SELECT id FROM role_bindings WHERE subject_user_id='upgrade-left'")).toEqual([]);
    expect(await accountSiteRole(site, { userId: "upgrade-left" })).toBeNull();
    await rbacQuery("DELETE FROM role_bindings WHERE subject_user_id='upgrade-editor'");
    const markers = await rbacQuery("SELECT * FROM schema_migrations ORDER BY id");
    expect(markers).toHaveLength(13);
    for (let restart = 0; restart < 2; restart++) {
      await closeDbForTests();
      expect(await accountSiteRole(site, { userId: "upgrade-editor" })).toBeNull();
      expect(await accountSiteRole(site, { userId: "upgrade-manager" })).toBe("site-admin");
      expect(await rbacQuery("SELECT * FROM schema_migrations ORDER BY id")).toEqual(markers);
      expect(await rbacQuery("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('site_members','site_collaborators','site_invites','rbac_migrations')")).toEqual([]);
      expect(await rbacQuery("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='tenant_members' AND column_name='role') OR (table_name='sites' AND column_name IN ('claim_token','edit_policy')))")).toEqual([]);
    }
  } finally {
    await closeDbForTests();
    process.env.ARTIFACT_DATABASE_URL = originalUrl;
    if (originalDriver === undefined) delete process.env.ARTIFACT_DB_DRIVER;
    else process.env.ARTIFACT_DB_DRIVER = originalDriver;
    await old.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
