import { afterEach, expect, it } from "vitest";
import { closeDbForTests, rbacQuery, upsertUser, createId } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { accountSiteRole } from "@/lib/rbac-access";
import { canReadVersion } from "@/lib/share";
import { resolveAuthority, resolveViewer } from "@/lib/authz";
import { putUserSiteRole } from "@/lib/role-bindings";
afterEach(closeDbForTests);
async function fixture() {
  const owner = await upsertUser({
    authProvider: "test",
    providerSubject: createId("u"),
  });
  const user = await upsertUser({
    authProvider: "test",
    providerSubject: createId("u"),
  });
  const { site } = await createSite(
    { mode: "paste", html: "<p>private</p>" },
    { ownerId: owner.id },
  );
  await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1", [
    site.id,
  ]);
  site.visibility = "private";
  return { site, user, owner };
}
it("uses bindings, never retired collaborator records, for account roles", async () => {
  const { site, user } = await fixture();
  await expect(rbacQuery(
    "INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'admin',1)",
    [site.id, user.id],
  )).rejects.toThrow();
  expect(await accountSiteRole(site, { userId: user.id })).toBeNull();
  await putUserSiteRole(rbacQuery, site.id, user.id, "editor", null);
  expect(await accountSiteRole(site, { userId: user.id })).toBe("editor");
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [user.id]);
  expect(await accountSiteRole(site, { userId: user.id })).toBeNull();
});
it("seeds a database permission catalog and enforces binding shape", async () => {
  await fixture();
  expect(
    (
      await rbacQuery(
        "SELECT permission_code FROM role_permissions WHERE role_id='editor'",
      )
    ).map((r) => r.permission_code),
  ).toContain("site.content.edit");
  await expect(
    rbacQuery(
      "INSERT INTO role_bindings(id,subject_type,resource_type,role_id,created_at,updated_at) VALUES('bad','user','site','editor',1,1)",
    ),
  ).rejects.toThrow();
});
it("everyone readers can open a private current version without gaining write authority", async () => {
  const { site } = await fixture();
  await rbacQuery(
    "INSERT INTO role_bindings(id,subject_type,resource_type,resource_site_id,role_id,created_at,updated_at) VALUES('all','everyone','site',$1,'commenter',1,1)",
    [site.id],
  );
  const req = new Request("https://example.com");
  expect((await resolveAuthority(resolveViewer(req), site)).role).toBe(
    "viewer",
  );
  expect(await canReadVersion(req, site, site.currentVersionId, null)).toBe(
    true,
  );
});

it("global grants stop at takedown and do not make private sites discoverable", async () => {
  const { site, user } = await fixture();
  const { listSiteSummaries, listSitesForCollaborator } = await import(
    "@/lib/db"
  );
  await rbacQuery(
    "INSERT INTO role_bindings(id,subject_type,resource_type,resource_site_id,role_id,created_at,updated_at) VALUES($1,'everyone','site',$2,'editor',1,1)",
    [createId("all"), site.id],
  );
  expect(await accountSiteRole(site, { userId: user.id })).toBe("editor");
  expect(
    (await listSiteSummaries({ userId: user.id })).some(
      (s) => s.slug === site.slug,
    ),
  ).toBe(false);
  expect(
    (await listSitesForCollaborator(user.id)).some((s) => s.slug === site.slug),
  ).toBe(false);
  await rbacQuery("UPDATE sites SET taken_down_at=1 WHERE id=$1", [site.id]);
  site.takenDownAt = 1;
  expect(await accountSiteRole(site, { userId: user.id })).toBeNull();
  expect(
    await canReadVersion(
      new Request("https://example.com"),
      site,
      site.currentVersionId,
      null,
    ),
  ).toBe(false);
});

it("reads permission changes from the catalog without a process cache", async () => {
  const { site, user } = await fixture();
  const { databaseRoleAllows } = await import("@/lib/role-bindings");
  await putUserSiteRole(rbacQuery, site.id, user.id, "editor", null);
  expect(
    await databaseRoleAllows(
      await accountSiteRole(site, { userId: user.id }),
      "site.source.export",
    ),
  ).toBe(true);
  await rbacQuery(
    "DELETE FROM role_permissions WHERE role_id='editor' AND permission_code='site.source.export'",
  );
  try {
    expect(
      await databaseRoleAllows(
        await accountSiteRole(site, { userId: user.id }),
        "site.source.export",
      ),
    ).toBe(false);
  } finally {
    await rbacQuery(
      "INSERT INTO role_permissions(role_id,permission_code) VALUES('editor','site.source.export')",
    );
  }
});

it("keeps the frozen migration catalog aligned with the reference roles", async () => {
  await fixture();
  const { ROLE_PERMISSIONS } = await import("@/lib/rbac");
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const rows = await rbacQuery("SELECT permission_code FROM role_permissions WHERE role_id=$1", [role]);
    expect(rows.map(r => r.permission_code).sort()).toEqual([...permissions].sort());
  }
});
it("excludes broad grants from the named collaborator audience exclusion list", async () => {
  const { site, user } = await fixture();
  const { listAudienceExcludedUserIds } = await import("@/lib/db");
  for (const subject of ["everyone", "tenant"]) {
    await rbacQuery("INSERT INTO role_bindings(id,subject_type,subject_tenant_id,resource_type,resource_site_id,role_id,created_at,updated_at) VALUES($1,$2,$3,'site',$4,'editor',1,1)", [createId("b"),subject,subject === "tenant" ? site.tenantId : null,site.id]);
  }
  expect(await listAudienceExcludedUserIds(site.id)).toEqual([]);
  await putUserSiteRole(rbacQuery, site.id, user.id, "editor", null);
  expect(await listAudienceExcludedUserIds(site.id)).toHaveLength(1);
});
