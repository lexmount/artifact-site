import { restorePreCleanupSchema } from "./fixtures/pre-cleanup-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDbForTests,
  createId,
  rbacQuery,
  upsertUser,
  getSite,
  createShare,
} from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { POST, GET } from "@/app/api/authorization/bindings/route";
import { PATCH, DELETE } from "@/app/api/authorization/bindings/[id]/route";
import { GET as resources } from "@/app/api/authorization/resources/route";
import { GET as subjects } from "@/app/api/authorization/subjects/route";
import { GET as roles } from "@/app/api/authorization/roles/route";
import { accountSiteRole, changeTenantMember } from "@/lib/rbac-access";
import { putTenantAdmin, putUserSiteRole } from "@/lib/role-bindings";
import {
  resolveAuthority,
  resolveViewer,
  requirePermission,
} from "@/lib/authz";
import { canReadVersion, hashToken } from "@/lib/share";
import { authorizePreview } from "@/lib/preview-access";
import { resolveCommentAccess } from "@/lib/comments/access";
import { describeCommentPermissions } from "@/lib/comments/permissions";
import { up as migrate } from "@/lib/migrations/0007-role-bindings";
const origin = "https://authorization.example";
afterEach(closeDbForTests);
async function actor() {
  const user = await upsertUser({
    authProvider: "authorization-test",
    providerSubject: createId("actor"),
    email: `${createId("email")}@example.com`,
    emailVerified: true,
  });
  const { cookie, session } = await mintSession(new Request(origin), user.id);
  return { user, session, cookie: cookie.split(";")[0] };
}
function request(cookie = "", method = "GET", body?: unknown, query = "") {
  return new Request(`${origin}/api/authorization/bindings${query}`, {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function fixture() {
  const owner = await actor(),
    member = await actor(),
    outsider = await actor();
  const { site } = await createSite(
    { mode: "paste", html: "<p>Restricted</p>" },
    { ownerId: owner.user.id },
  );
  await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1", [
    site.id,
  ]);
  site.visibility = "private";
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [
    outsider.user.id,
  ]);
  const resource = { type: "site", id: site.id };
  const query = `?resourceType=site&resourceId=${site.id}`;
  return { owner, member, outsider, site, resource, query };
}
async function grant(
  f: Awaited<ReturnType<typeof fixture>>,
  subject: unknown,
  roleId = "viewer",
) {
  return POST(
    request(f.owner.cookie, "POST", { resource: f.resource, subject, roleId }),
  );
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
describe("authorization API acceptance", () => {
  it("creates, lists, edits and revokes a grant with optimistic concurrency and audit", async () => {
    const f = await fixture();
    const response = await grant(f, { type: "user", id: f.member.user.id });
    expect(response.status).toBe(200);
    const binding = await response.json();
    expect(await accountSiteRole(f.site, f.member.session)).toBe("viewer");
    const listing = await GET(
      request(f.owner.cookie, "GET", undefined, f.query),
    );
    expect(listing.headers.get("cache-control")).toContain("no-store");
    expect((await listing.json()).bindings).toHaveLength(1);
    const update = { roleId: "commenter", expectedRevision: binding.revision };
    const results = await Promise.all([
      PATCH(request(f.owner.cookie, "PATCH", update), context(binding.id)),
      PATCH(request(f.owner.cookie, "PATCH", update), context(binding.id)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await accountSiteRole(f.site, f.member.session)).toBe("commenter");
    expect(
      (
        await DELETE(
          request(f.owner.cookie, "DELETE", { expectedRevision: 2 }),
          context(binding.id),
        )
      ).status,
    ).toBe(200);
    expect(await accountSiteRole(f.site, f.member.session)).toBeNull();
    expect(
      await rbacQuery(
        "SELECT id FROM rbac_audit WHERE target_id=$1 AND action LIKE 'authorization.%'",
        [f.site.id],
      ),
    ).toHaveLength(3);
  });
  it("rejects outsiders, foreign tenants, owner duplication, everyone admins and unauthenticated writes", async () => {
    const f = await fixture();
    for (const [subject, role] of [
      [{ type: "user", id: f.outsider.user.id }, "viewer"],
      [{ type: "tenant", id: "foreign" }, "viewer"],
      [{ type: "user", id: f.owner.user.id }, "editor"],
      [{ type: "everyone" }, "site-admin"],
    ] as const)
      expect((await grant(f, subject, role)).status).toBe(400);
    expect(
      (
        await POST(
          request("", "POST", {
            resource: f.resource,
            subject: { type: "everyone" },
            roleId: "viewer",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await GET(request(f.outsider.cookie, "GET", undefined, f.query))).status,
    ).toBe(403);
    expect((await grant(f, { type: "everyone", id: "*" })).status).toBe(400);
  });
  it("unions personal, own-tenant and global grants while distinguishing outsiders and anonymous readers", async () => {
    const f = await fixture();
    expect(
      (await grant(f, { type: "user", id: f.member.user.id }, "viewer")).status,
    ).toBe(200);
    expect(
      (await grant(f, { type: "tenant", id: f.site.tenantId }, "editor"))
        .status,
    ).toBe(200);
    expect((await grant(f, { type: "everyone" }, "commenter")).status).toBe(
      200,
    );
    expect(await accountSiteRole(f.site, f.member.session)).toBe("editor");
    expect(await accountSiteRole(f.site, f.outsider.session)).toBe("commenter");
    expect(
      (await resolveAuthority(resolveViewer(request()), f.site)).role,
    ).toBe("viewer");
    expect(
      await canReadVersion(request(), f.site, f.site.currentVersionId, null),
    ).toBe(true);
    const preview = await authorizePreview(request(), f.site, null);
    expect(preview?.key).toBeTruthy();
    expect(
      await authorizePreview(request(), f.site, preview!.key),
    ).not.toBeNull();
    await rbacQuery("DELETE FROM role_bindings WHERE subject_type='everyone'");
    expect(await authorizePreview(request(), f.site, preview!.key)).toBeNull();
  });
  it("limits viewers to reader versions and invalidates an editor preview when downgraded", async () => {
    const f = await fixture();
    const historical = f.site.currentVersionId;
    await editSite(
      f.site.slug,
      { content: "<p>New</p>" },
      {
        actor: { kind: "user", userId: f.owner.user.id, anonId: null },
        method: "api",
        ip: null,
        userAgent: null,
      },
    );
    const site = (await getSite(f.site.id))!;
    await putUserSiteRole(
      rbacQuery,
      site.id,
      f.member.user.id,
      "editor",
      f.owner.user.id,
    );
    const req = new Request(`${origin}/preview?v=${historical}`, {
      headers: { cookie: f.member.cookie },
    });
    const preview = await authorizePreview(req, site, null);
    expect(preview?.key).toBeTruthy();
    await putUserSiteRole(
      rbacQuery,
      site.id,
      f.member.user.id,
      "viewer",
      f.owner.user.id,
    );
    expect(
      await canReadVersion(
        request(f.member.cookie),
        site,
        historical,
        f.member.session,
      ),
    ).toBe(false);
    expect(await authorizePreview(req, site, preview!.key)).toBeNull();
    await expect(
      requirePermission(
        request(f.member.cookie),
        site,
        "site.source.export",
        f.member.session,
      ),
    ).rejects.toThrow();
  });
  it("preserves an edit share alongside a weaker direct role without opening history", async () => {
    const f = await fixture(),
      historical = f.site.currentVersionId;
    await editSite(
      f.site.slug,
      { content: "<p>New</p>" },
      {
        actor: { kind: "user", userId: f.owner.user.id, anonId: null },
        method: "api",
        ip: null,
        userAgent: null,
      },
    );
    const site = (await getSite(f.site.id))!;
    await putUserSiteRole(
      rbacQuery,
      site.id,
      f.member.user.id,
      "viewer",
      f.owner.user.id,
    );
    const token = createId("share");
    await createShare({
      id: createId("shr"),
      siteId: site.id,
      tokenHash: hashToken(token),
      label: "edit",
      policy: "public",
      mode: "edit",
      versionId: null,
      passcodeHash: null,
      expiresAt: null,
      createdAnonId: null,
      createdBy: f.owner.user.id,
    });
    const req = new Request(`${origin}/?share=${token}`, {
      headers: { cookie: f.member.cookie },
    });
    expect(
      (await resolveAuthority(resolveViewer(req, f.member.session), site)).role,
    ).toBe("editor");
    expect(await canReadVersion(req, site, historical, f.member.session)).toBe(
      false,
    );
  });
  it("keeps direct reader versions usable alongside a pinned share",async()=>{
    const f=await fixture(),historical=f.site.currentVersionId;
    await editSite(f.site.slug,{content:"<p>Current</p>"},{actor:{kind:"user",userId:f.owner.user.id,anonId:null},method:"api",ip:null,userAgent:null});
    const site=(await getSite(f.site.id))!;
    await putUserSiteRole(rbacQuery,site.id,f.member.user.id,"viewer",f.owner.user.id);
    const token=createId("share");
    await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),policy:"public",mode:"view",versionId:historical,passcodeHash:null,expiresAt:null,createdAnonId:null,label:null,createdBy:f.owner.user.id});
    const req=new Request(`${origin}/preview?share=${token}&v=${site.currentVersionId}`,{headers:{cookie:f.member.cookie}});
    const preview=await authorizePreview(req,site,null);
    expect(preview?.versionId).toBe(site.currentVersionId);
    expect(await authorizePreview(new Request(origin),site,preview!.key)).not.toBeNull();
  });
  it("honors comments off before a commenter grant and allows members-only comments", async () => {
    const f = await fixture();
    await grant(f, { type: "user", id: f.member.user.id }, "commenter");
    const scope = {
      siteId: f.site.id,
      versionId: f.site.currentVersionId,
      entry: { kind: "main" as const },
    };
    await rbacQuery(
      "INSERT INTO site_comment_settings(site_id,main_policy,updated_at) VALUES($1,'members',1) ON CONFLICT(site_id) DO UPDATE SET main_policy='members'",
      [f.site.id],
    );
    expect(
      describeCommentPermissions(
        await resolveCommentAccess(
          request(f.member.cookie),
          f.site,
          scope,
          f.member.session,
        ),
      ).canCreate,
    ).toBe(true);
    await rbacQuery(
      "UPDATE site_comment_settings SET main_policy='off' WHERE site_id=$1",
      [f.site.id],
    );
    expect(
      describeCommentPermissions(
        await resolveCommentAccess(
          request(f.member.cookie),
          f.site,
          scope,
          f.member.session,
        ),
      ).canCreate,
    ).toBe(false);
  });
  it("removes personal grants permanently when leaving and protects the last tenant administrator", async () => {
    const f = await fixture();
    await putTenantAdmin(rbacQuery, "init", f.owner.user.id, true, null);
    await grant(f, { type: "user", id: f.member.user.id }, "editor");
    await changeTenantMember(
      request(f.owner.cookie),
      "init",
      f.member.user.id,
      null,
    );
    expect(
      await rbacQuery("SELECT id FROM role_bindings WHERE subject_user_id=$1", [
        f.member.user.id,
      ]),
    ).toHaveLength(0);
    await changeTenantMember(
      request(f.owner.cookie),
      "init",
      f.member.user.id,
      "member",
    );
    expect(await accountSiteRole(f.site, f.member.session)).toBeNull();
    const tenantId = createId("isolated");
    await rbacQuery(
      "INSERT INTO tenants(id,name) VALUES($1,'Last administrator')",
      [tenantId],
    );
    await rbacQuery(
      "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
      [tenantId, f.owner.user.id],
    );
    await putTenantAdmin(rbacQuery, tenantId, f.owner.user.id, true, null);
    const [admin] = await rbacQuery(
      "SELECT id,revision FROM role_bindings WHERE resource_tenant_id=$1",
      [tenantId],
    );
    expect(
      (
        await DELETE(
          request(f.owner.cookie, "DELETE", {
            expectedRevision: Number(admin.revision),
          }),
          context(admin.id as string),
        )
      ).status,
    ).toBe(400);
  });
  it("limits role choices and prevents a site admin from appointing another admin", async () => {
    const f = await fixture();
    await grant(f, { type: "user", id: f.member.user.id }, "site-admin");
    const catalog = await roles(
      request(f.member.cookie, "GET", undefined, f.query),
    );
    expect(
      (await catalog.json()).roles.map((r: { id: string }) => r.id),
    ).toEqual(["viewer", "commenter", "editor"]);
    const response = await POST(
      request(f.member.cookie, "POST", {
        resource: f.resource,
        subject: { type: "tenant", id: "init" },
        roleId: "site-admin",
      }),
    );
    expect(response.status).toBe(403);
    expect((await resources(request(f.member.cookie))).status).toBe(200);
    const people = await subjects(
      request(f.owner.cookie, "GET", undefined, f.query),
    );
    expect(
      (await people.json()).subjects.map((s: { id: string }) => s.id),
    ).not.toContain(f.outsider.user.id);
  });
  it("searches literal email and resource punctuation",async()=>{
    const f=await fixture();
    const people=await subjects(request(f.owner.cookie,"GET",undefined,f.query+"&q="+encodeURIComponent(f.member.user.email!)));
    expect((await people.json()).subjects.map((s:{id:string})=>s.id)).toContain(f.member.user.id);
    await rbacQuery("UPDATE sites SET title='100%_report!' WHERE id=$1",[f.site.id]);
    const found=await resources(request(f.owner.cookie,"GET",undefined,"?q="+encodeURIComponent("100%_report!")));
    expect((await found.json()).resources.map((s:{id:string})=>s.id)).toContain(f.site.id);
  });
  it("migrates old grants once and never resurrects revoked bindings on a normal restart", async () => {
    const f = await fixture();
    await restorePreCleanupSchema();
    await rbacQuery(
      "INSERT INTO site_members(site_id,user_id,role,granted_by,granted_at) VALUES($1,$2,'admin',$3,123)",
      [f.site.id, f.member.user.id, "retired-author"],
    );
    await rbacQuery("UPDATE tenant_members SET role='admin' WHERE user_id=$1", [
      f.owner.user.id,
    ]);
    await migrate(rbacQuery);
    expect(await accountSiteRole(f.site, f.member.session)).toBe("site-admin");
    const [binding] = await rbacQuery(
      "SELECT * FROM role_bindings WHERE resource_site_id=$1",
      [f.site.id],
    );
    expect(Number(binding.created_at)).toBe(123);
    expect(binding.created_by).toBe("retired-author");
    await migrate(rbacQuery);
    expect(
      await rbacQuery(
        "SELECT id FROM role_bindings WHERE resource_site_id=$1",
        [f.site.id],
      ),
    ).toHaveLength(1);
    await rbacQuery("DELETE FROM role_bindings WHERE resource_site_id=$1", [
      f.site.id,
    ]);
    await closeDbForTests();
    expect(await accountSiteRole(f.site, f.member.session)).toBeNull();
  });
});

it("revokes disabled users' raw bindings and protects dormant administrator grants", async () => {
  const f = await fixture();
  const admin = await actor();
  await putUserSiteRole(rbacQuery, f.site.id, admin.user.id, "admin", f.owner.user.id);
  for (const role of ["editor", "admin"] as const) {
    await putUserSiteRole(rbacQuery, f.site.id, f.member.user.id, role, f.owner.user.id);
    await rbacQuery("UPDATE users SET disabled_at=1 WHERE id=$1", [f.member.user.id]);
    const [binding] = await rbacQuery("SELECT id,revision FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2", [f.site.id,f.member.user.id]);
    const ctx = context(String(binding.id));
    if (role === "admin") {
      expect((await DELETE(request(admin.cookie, "DELETE", {expectedRevision:Number(binding.revision)}), ctx)).status).toBe(403);
    }
    expect((await DELETE(request(f.owner.cookie, "DELETE", {expectedRevision:Number(binding.revision)}), ctx)).status).toBe(200);
    expect(await rbacQuery("SELECT id FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2", [f.site.id, f.member.user.id])).toHaveLength(0);
    await rbacQuery("UPDATE users SET disabled_at=NULL WHERE id=$1", [f.member.user.id]);
    const login = await mintSession(new Request(origin), f.member.user.id);
    expect(await accountSiteRole(f.site, login.session)).toBeNull();
  }
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE target_id=$1 AND action='authorization.revoke'", [f.site.id])).toHaveLength(2);
});
it("audits management reads once while owner reads and mutation checks do not add management events", async () => {
  const f = await fixture();
  await putTenantAdmin(rbacQuery, f.site.tenantId, f.member.user.id, true, f.owner.user.id);
  const managed = (method = "GET", body?: unknown) => {
    const req = request(f.member.cookie, method, body, f.query);
    req.headers.set("X-Management-Reason", "Review access");
    return req;
  };
  const audit = () => rbacQuery("SELECT * FROM rbac_audit WHERE target_id=$1 AND action='site.management'", [f.site.id]);
  expect((await GET(request(f.owner.cookie, "GET", undefined, f.query))).status).toBe(200);
  expect(await audit()).toHaveLength(0);
  for (const handler of [GET, subjects, roles]) {
    const req = managed();
    const url = new URL(req.url); url.searchParams.set("subjectType", "user");
    expect((await handler(new Request(url, req))).status).toBe(200);
  }
  const events = await audit();
  expect(events).toHaveLength(3);
  expect(JSON.stringify(events)).toContain("Review access");
  expect(JSON.stringify(events)).toContain(f.member.user.id);
  expect((await POST(managed("POST", { resource: f.resource, subject: { type: "everyone" }, roleId: "viewer" }))).status).toBe(200);
  expect(await audit()).toHaveLength(3);
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE target_id=$1 AND action LIKE 'authorization.%'", [f.site.id])).toHaveLength(1);
  await putUserSiteRole(rbacQuery, f.site.id, f.member.user.id, "editor", f.owner.user.id);
  expect((await resolveAuthority(resolveViewer(managed(), f.member.session), f.site)).source).toBe("management");
  const own = request(f.owner.cookie); own.headers.set("X-Management-Reason", "Review access");
  await putTenantAdmin(rbacQuery, f.site.tenantId, f.owner.user.id, true, f.owner.user.id);
  expect((await resolveAuthority(resolveViewer(own, f.owner.session), f.site)).source).toBe("account");
});

it("upgrades the original 0007 database without reimporting revoked grants", async () => {
  const f = await fixture();
  await restorePreCleanupSchema();
  const checksum = "aae4a393c7657a8677077d9a3f5592dd4c0c0eb64a5c0cf1b58ab04c0e8a40e1";
  await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'editor',1)", [f.site.id, f.member.user.id]);
  // Simulate a database that ran the original PR migration, then revoked its imported grant.
  await rbacQuery("UPDATE schema_migrations SET checksum=$1 WHERE id='0007-role-bindings'", [checksum]);
  await rbacQuery("DELETE FROM schema_migrations WHERE id='0008-site-members-view'");
  await rbacQuery("DROP VIEW authorization_site_members");
  const { statements } = await import("@/lib/migrations/0007-role-bindings");
  await rbacQuery(statements.find(s => s.startsWith("CREATE VIEW authorization_site_members"))!);
  await closeDbForTests();
  expect(await accountSiteRole(f.site, f.member.session)).toBeNull();
  expect(await rbacQuery("SELECT id FROM schema_migrations WHERE id='0008-site-members-view'")).toHaveLength(1);
  expect((await rbacQuery("SELECT checksum FROM schema_migrations WHERE id='0007-role-bindings'"))[0].checksum).toBe(checksum);
  await closeDbForTests();
  expect(await accountSiteRole(f.site, f.member.session)).toBeNull();
});
