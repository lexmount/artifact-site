import { resolveRole } from "./fixtures/authorization-role";
import { putTenantAdmin, putUserSiteRole } from "@/lib/role-bindings";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDbForTests,
  createId,
  getSite,
  insertSiteWithVersion,
  rbacQuery,
  upsertUser,
  updateSiteVisibility,
  rbacTransaction,
} from "@/lib/db";
import { ANONYMOUS_TENANT, INIT_TENANT, roleAllows } from "@/lib/rbac";

afterEach(closeDbForTests);
describe("tenant migration and role contract", () => {
  it("seeds fixed tenants and initializes users without rejoining removed members", async () => {
    const user = await upsertUser({
      authProvider: "test",
      providerSubject: "member",
    });
    expect(user.tenantId).toBe(INIT_TENANT);
    expect(
      (await rbacQuery("SELECT id FROM tenants WHERE id IN ($1,$2) ORDER BY id", [ANONYMOUS_TENANT, INIT_TENANT])).map((r) => r.id),
    ).toEqual([ANONYMOUS_TENANT, INIT_TENANT]);
    await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [user.id]);
    await closeDbForTests();
    await upsertUser({ authProvider: "test", providerSubject: "member" });
    expect(
      await rbacQuery("SELECT * FROM tenant_members WHERE user_id=$1", [
        user.id,
      ]),
    ).toEqual([]);
  });
  it("assigns account and anonymous artifacts to distinct tenants", async () => {
    const user = await upsertUser({
      authProvider: "test",
      providerSubject: "owner",
    });
    for (const ownerId of [user.id, null]) {
      const id = createId("site");
      await insertSiteWithVersion(
        {
          id,
          slug: id,
          title: "t",
          kind: "single",
          editToken: "t",
          ownerId,
          visibility: "private",
        },
        {
          id: createId("v"),
          siteId: id,
          entry: "index.html",
          source: "upload",
          fileCount: 1,
          byteSize: 1,
        },
      );
      expect((await getSite(id))?.tenantId).toBe(
        ownerId ? "init" : "anonymous",
      );
    }
  });
  it("separates content, delegated management and ownership, reserving comment actions", () => {
    expect(roleAllows("editor", "site.content.edit")).toBe(true);
    expect(roleAllows("editor", "site.version.rollback")).toBe(false);
    expect(roleAllows("site-admin", "site.sharing.manage")).toBe(true);
    expect(roleAllows("site-admin", "site.owner.transfer")).toBe(false);
    expect(roleAllows("commenter", "comment.reply")).toBe(true);
    expect(roleAllows("viewer", "comment.read")).toBe(false);
  });
});

import { createShare, revokeShare } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { mintSession, csrfSafe } from "@/lib/session";
import {
  resolveViewer,
} from "@/lib/authz";
import { canReadVersion, hashToken } from "@/lib/share";
import { authorizePreview } from "@/lib/preview-access";
import { changeTenantMember } from "@/lib/rbac-access";
import { grantMember } from "./fixtures/authorization-api";
import { POST as claim } from "@/app/api/me/adopt/route";

const origin = "https://rbac.example";
async function identity() {
  const user = await upsertUser({
    authProvider: "rbac",
    providerSubject: createId("subject"),
    email: `${createId("email")}@example.com`,
    emailVerified: true,
  });
  const { session, cookie } = await mintSession(new Request(origin), user.id);
  return { user, session, cookie: cookie.split(";")[0] };
}
function request(
  cookie = "",
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return new Request(`${origin}/api/test`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function artifact(owner: Awaited<ReturnType<typeof identity>>) {
  return (
    await createSite(
      { mode: "paste", html: "<html><head></head><body>one</body></html>" },
      { ownerId: owner.user.id },
    )
  ).site;
}
async function link(
  site: Awaited<ReturnType<typeof artifact>>,
  mode: "view" | "comment" | "edit",
  versionId: string | null = null,
) {
  const token = createId("token");
  const share = await createShare({
    id: createId("share"),
    siteId: site.id,
    tokenHash: hashToken(token),
    policy: "public",
    passcodeHash: null,
    label: null,
    createdBy: site.ownerId,
    createdAnonId: null,
    expiresAt: null,
    mode,
    versionId,
  });
  return { share, token };
}

describe("RBAC boundaries", () => {
  it("site editors cannot manage members; site admins cannot promote admins", async () => {
    const owner = await identity(),
      editor = await identity(),
      admin = await identity(),
      target = await identity();
    const site = await artifact(owner);
    await putUserSiteRole(rbacQuery, site.id, editor.user.id, 'editor', null);
    await putUserSiteRole(rbacQuery, site.id, admin.user.id, 'admin', null);
    expect(
      await resolveRole(
        resolveViewer(request(editor.cookie), editor.session),
        site,
      ),
    ).toBe("editor");
    expect(
      await resolveRole(
        resolveViewer(request(admin.cookie), admin.session),
        site,
      ),
    ).toBe("site-admin");
    const ctx = { params: Promise.resolve({ slug: site.slug }) };
    expect(
      (
        await grantMember(
          request(
            editor.cookie,
            {},
            { email: target.user.email, role: "editor" },
          ),
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await grantMember(
          request(
            admin.cookie,
            {},
            { email: target.user.email, role: "admin" },
          ),
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await grantMember(
          request(
            admin.cookie,
            {},
            { email: target.user.email, role: "editor" },
          ),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await grantMember(
          request(
            owner.cookie,
            {},
            { email: target.user.email, role: "admin" },
          ),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await grantMember(
          request(
            admin.cookie,
            {},
            { email: target.user.email, role: "editor" },
          ),
          ctx,
        )
      ).status,
    ).toBe(403);
    const audit = await rbacQuery("SELECT target_id,reason FROM rbac_audit WHERE action='authorization.grant' AND target_id=$1",[site.id]);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some(row=>JSON.parse(row.reason as string).subject.id===target.user.id)).toBe(true);
  });
  it("tenant administration is explicit and cannot cross tenant boundaries", async () => {
    const owner = await identity(),
      admin = await identity();
    const site = await artifact(owner);
    const tenant = createId("tenant");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Other')", [
      tenant,
    ]);
    await rbacQuery(
      "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
      [tenant, admin.user.id],
    );
    await putTenantAdmin(rbacQuery,tenant,admin.user.id,true,null);
    expect(
      await resolveRole(
        resolveViewer(
          request(admin.cookie, { "x-management-reason": "support" }),
          admin.session,
        ),
        site,
      ),
    ).toBe(null);
    await putTenantAdmin(rbacQuery,"init",admin.user.id,true,null);
    expect(
      await resolveRole(
        resolveViewer(request(admin.cookie), admin.session),
        site,
      ),
    ).toBe(null);
    expect(
      await resolveRole(
        resolveViewer(
          request(admin.cookie, { "x-management-reason": "support" }),
          admin.session,
        ),
        site,
      ),
    ).toBe("tenant-admin");
    await rbacQuery("UPDATE tenants SET disabled_at=1 WHERE id='init'");
    expect(
      await resolveRole(
        resolveViewer(request(owner.cookie), owner.session),
        site,
      ),
    ).toBe(null);
    await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id='init'");
  });
  it("keeps one active tenant admin under concurrent removals", async () => {
    const a = await identity(),
      b = await identity();
    const tenant = createId("tenant");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Concurrent')", [
      tenant,
    ]);
    await rbacQuery(
      "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2),($1,$3)",
      [tenant, a.user.id, b.user.id],
    );
    await putTenantAdmin(rbacQuery,tenant,a.user.id,true,null);
    await putTenantAdmin(rbacQuery,tenant,b.user.id,true,null);
    const results = await Promise.allSettled([
      changeTenantMember(request(a.cookie), tenant, a.user.id, null),
      changeTenantMember(request(b.cookie), tenant, b.user.id, null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await rbacQuery(
        "SELECT user_id FROM authorization_tenant_members WHERE tenant_id=$1 AND role='admin'",
        [tenant],
      ),
    ).toHaveLength(1);
  });
  it("links grant external editors no membership or management and revoke immediately", async () => {
    const owner = await identity(),
      external = await identity();
    const site = await artifact(owner);
    await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [
      external.user.id,
    ]);
    const { share, token } = await link(site, "edit");
    const req = request(external.cookie, { "x-artifact-share": token });
    expect(
      await resolveRole(resolveViewer(req, external.session), site),
    ).toBe("editor");
    expect(
      await resolveRole(
        resolveViewer(request("", { "x-artifact-share": token }), null),
        site,
      ),
    ).toBe("viewer");
    expect(
      await rbacQuery("SELECT * FROM role_bindings WHERE subject_user_id=$1 AND resource_type='site'", [
        external.user.id,
      ]),
    ).toHaveLength(0);
    const access = await authorizePreview(req, site, null);
    expect(access).not.toBeNull();
    await revokeShare(share.id, Date.now());
    expect(
      await resolveRole(resolveViewer(req, external.session), site),
    ).toBe(null);
    expect(await authorizePreview(request(), site, access!.key)).toBeNull();
  });
  it("fixed shares and sub-resource grants cannot switch versions", async () => {
    const owner = await identity();
    const old = await artifact(owner);
    const updated = await editSite(
      old.slug,
      { content: "<html>two</html>" },
      {
        actor: { kind: "user", userId: owner.user.id, anonId: null },
        method: "api",
        ip: null,
        userAgent: null,
      },
    );
    if (!updated || "conflict" in updated) throw new Error("Edit failed");
    const site = updated.site;
    const { token } = await link(site, "view", old.currentVersionId);
    const req = request("", { "x-artifact-share": token });
    expect(await canReadVersion(req, site, old.currentVersionId)).toBe(true);
    expect(await canReadVersion(req, site, site.currentVersionId)).toBe(false);
    const access = await authorizePreview(req, site, null);
    expect(access?.versionId).toBe(old.currentVersionId);
    expect(
      await authorizePreview(
        new Request(`${origin}/?v=${site.currentVersionId}`),
        site,
        access!.key,
      ),
    ).toBeNull();
  });
  it("claiming requires browser provenance and an explicit destination membership", async () => {
    const owner = await identity();
    const anonId = createId("anon");
    const site = (
      await createSite(
        { mode: "paste", html: "<html>anon</html>" },
        { anonOwnerId: anonId },
      )
    ).site;
    expect(site.tenantId).toBe("anonymous");
    expect(
      (await claim(request(owner.cookie, {}, { tenantId: "init" }))).status,
    ).toBe(403);
    const cookie = `${owner.cookie}; __Host-ah_anon=${anonId}`;
    expect(
      (await claim(request(cookie, {}, { tenantId: "forbidden" }))).status,
    ).toBe(403);
    expect((await getSite(site.id))?.tenantId).toBe("anonymous");
    const result = await claim(request(cookie, {}, { tenantId: "init" }));
    expect(result.status).toBe(200);
    expect(await getSite(site.id)).toMatchObject({
      ownerId: owner.user.id,
      tenantId: "init",
      anonOwnerId: null,
    });
    expect(
      (await (await claim(request(cookie, {}, { tenantId: "init" }))).json())
        .adopted,
    ).toBe(0);
  });
});

import { disableUser } from "@/lib/admin";
import {
  DELETE as deleteSiteRoute,
  PATCH as renameSiteRoute,
} from "@/app/api/sites/[slug]/route";
import { POST as transferRoute } from "@/app/api/sites/[slug]/ownership/route";
import { POST as createLinkRoute } from "@/app/api/sites/[slug]/shares/route";

describe("RBAC action acceptance", () => {
  it("protects ownership actions while allowing delegated site settings", async () => {
    const owner = await identity(),
      admin = await identity(),
      editor = await identity();
    const site = await artifact(owner);
    await putUserSiteRole(rbacQuery, site.id, admin.user.id, 'admin', null);
    await putUserSiteRole(rbacQuery, site.id, editor.user.id, 'editor', null);
    const ctx = { params: Promise.resolve({ slug: site.slug }) };
    expect(
      (
        await renameSiteRoute(
          request(editor.cookie, {}, { title: "Denied" }),
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await renameSiteRoute(
          request(admin.cookie, {}, { title: "Delegated rename" }),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect((await deleteSiteRoute(request(admin.cookie), ctx)).status).toBe(
      403,
    );
    expect(
      (
        await transferRoute(
          request(admin.cookie, {}, { email: editor.user.email }),
          ctx,
        )
      ).status,
    ).toBe(403);
    expect((await getSite(site.id))?.ownerId).toBe(owner.user.id);
    expect(
      (
        await createLinkRoute(
          request(editor.cookie, {}, { policy: "public", mode: "edit" }),
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await createLinkRoute(
          request(
            admin.cookie,
            {},
            {
              policy: "public",
              mode: "edit",
              versionId: site.currentVersionId,
            },
          ),
          ctx,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await createLinkRoute(
          request(admin.cookie, {}, { policy: "public", mode: "edit" }),
          ctx,
        )
      ).status,
    ).toBe(201);
  });
  it("refuses disabling the last tenant administrator's account", async () => {
    const admin = await identity();
    const tenant = createId("tenant");
    await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'Protected')", [
      tenant,
    ]);
    await rbacQuery(
      "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
      [tenant, admin.user.id],
    );
    await putTenantAdmin(rbacQuery,tenant,admin.user.id,true,null);
    await expect(
      disableUser(
        request(),
        { kind: "token", userId: null },
        admin.user.id,
        "test",
      ),
    ).rejects.toThrow(/another active tenant administrator/);
    const replacement = await identity();
    await rbacQuery(
      "INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",
      [tenant, replacement.user.id],
    );
    await putTenantAdmin(rbacQuery,tenant,replacement.user.id,true,null);
    expect(
      (
        await disableUser(
          request(),
          { kind: "token", userId: null },
          admin.user.id,
          "test",
        )
      ).disabledAt,
    ).not.toBeNull();
    await expect(changeTenantMember(request(replacement.cookie),tenant,admin.user.id,null)).resolves.toBeUndefined();
  });
});

import { vi } from "vitest";
it("exempts a valid operator bearer from CSRF, never an invalid one", () => {
  vi.stubEnv("PUBLISH_API_TOKEN", "rbac-operator-test");
  try {
    expect(
      csrfSafe(
        new Request(origin, {
          headers: { authorization: "Bearer rbac-operator-test" },
        }),
      ),
    ).toBe(true);
    expect(
      csrfSafe(
        new Request(origin, { headers: { authorization: "Bearer wrong" } }),
      ),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("never exposes the anonymous browser credential in artifact resource keys", async () => {
  const anonId = createId("secret-browser");
  const site = (
    await createSite(
      { mode: "paste", html: "<html>private</html>" },
      { anonOwnerId: anonId },
    )
  ).site;
  await updateSiteVisibility(site.id, "private");
  site.visibility = "private";
  const access = await authorizePreview(
    request(`__Host-ah_anon=${anonId}`),
    site,
    null,
  );
  expect(access).not.toBeNull();
  const payload = Buffer.from(
    access!.key!.split(".")[1],
    "base64url",
  ).toString();
  expect(payload).not.toContain(anonId);
  expect(await authorizePreview(request(), site, access!.key)).not.toBeNull();
});

import { GET as previewRoute } from "@/app/api/preview/[slug]/[[...path]]/route";
it("exchanges the share URL for a read-only URL before serving artifact code", async () => {
  const owner=await identity();const site=await artifact(owner);const {token}=await link(site,"edit");
  const response=await previewRoute(new Request(`${origin}/api/preview/${site.slug}?share=${token}`),{params:Promise.resolve({slug:site.slug})});
  expect(response.status).toBe(307);
  const location=response.headers.get("location")!;
  expect(location).not.toContain(token);
  const resource=new Request(`${origin}${location}`);
  expect(await resolveRole(resolveViewer(resource),site)).toBe(null);
  const bytes=await previewRoute(resource,{params:Promise.resolve({slug:location.split("/")[3]})});
  expect(bytes.status).toBe(200);
  expect(await bytes.text()).toContain("one");
});

import { POST as assignOwnerRoute } from "@/app/api/admin/sites/[slug]/owner/route";
it("refuses administrative assignment that would orphan a site outside its owner's membership", async () => {
  const owner=await identity();
  const site=(await createSite({mode:"paste",html:"<html>unowned</html>"})).site;
  await rbacQuery("DELETE FROM tenant_members WHERE tenant_id='init' AND user_id=$1",[owner.user.id]);
  const {claimSiteAudited}=await import("@/lib/db");
  expect(await claimSiteAudited(site.id,owner.user.id,{id:createId("audit"),siteId:site.id,versionId:null,action:"claim",editorKind:"admin",actorUserId:null,actorAnonId:null,method:"api",ip:null,userAgent:null})).toBe(false);
  vi.stubEnv("PUBLISH_API_TOKEN","rbac-assign-test");
  try {
    const response=await assignOwnerRoute(request("",{authorization:"Bearer rbac-assign-test"},{email:owner.user.email}),{params:Promise.resolve({slug:site.slug})});
    expect(response.status).toBe(403);
    expect((await getSite(site.id))?.ownerId).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});

it("does not roll back concurrent store writes with a failing RBAC transaction", async () => {
  const owner = await identity();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const transaction = rbacTransaction(async q => {
    await q("INSERT INTO tenants(id,name) VALUES('rolled-back','Temporary')");
    entered();
    await proceed;
    throw new Error("deliberate rollback");
  });
  const rejected = expect(transaction).rejects.toThrow("deliberate rollback");
  await started;
  // This uses the ordinary store transaction, not rbacQuery; neither nested BEGIN nor
  // joining the unrelated transaction is allowed on SQLite's single connection.
  const concurrent = artifact(owner);
  const ordinaryWrite = rbacQuery("INSERT INTO tenants(id,name) VALUES('independent-write','Committed')");
  release();
  await rejected;
  const site = await concurrent;
  await ordinaryWrite;
  expect(await rbacQuery("SELECT id FROM tenants WHERE id='independent-write'")).toHaveLength(1);
  expect(await getSite(site.id)).not.toBeNull();
  expect(await rbacQuery("SELECT id FROM tenants WHERE id='rolled-back'")).toEqual([]);
});

it("routes implicit RBAC reads through the transaction and rolls them back", async () => {
  await expect(rbacTransaction(async q => {
    await q("INSERT INTO tenants(id,name) VALUES('transaction-read','Temporary')");
    expect(await rbacQuery("SELECT id FROM tenants WHERE id='transaction-read'")).toHaveLength(1);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await rbacQuery("SELECT id FROM tenants WHERE id='transaction-read'")).toEqual([]);
});

it("encrypts preview identities and binds credentials to the tenant and deployment key", async () => {
  const { mintScopedPreviewKey, readScopedPreviewKey } = await import("@/lib/preview-key");
  const owner = await identity(), site = await artifact(owner);
  const grant = { versionId: site.currentVersionId, userId: owner.user.id, shareId: "secret-share-identity", anonOwnerHash: null, fingerprint: "" };
  const key = await mintScopedPreviewKey(site, grant);
  expect(await readScopedPreviewKey(key, site)).toMatchObject(grant);
  const bytes = Buffer.from(key.split(".")[1], "base64url");
  expect(bytes.toString()).not.toContain(owner.user.id);
  expect(bytes.toString()).not.toContain(grant.shareId);
  expect(await readScopedPreviewKey(key, { ...site, tenantId: "other" })).toBeNull();
  bytes[bytes.length - 1] ^= 1;
  expect(await readScopedPreviewKey(`v3.${bytes.toString("base64url")}`, site)).toBeNull();
  const original = process.env.PREVIEW_SIGNING_SECRET;
  try {
    process.env.PREVIEW_SIGNING_SECRET = "independent-preview-secret";
    // Once initialized, an environment change does not overwrite the shared active key.
    expect(await readScopedPreviewKey(key, site)).not.toBeNull();
  } finally {
    if (original === undefined) delete process.env.PREVIEW_SIGNING_SECRET;
    else process.env.PREVIEW_SIGNING_SECRET = original;
  }
});

it("exports the requested historical snapshot and rejects foreign version ids", async () => {
  const { exportSiteZip } = await import("@/lib/sites");
  const { unzipSync } = await import("fflate");
  const owner = await identity(), site = await artifact(owner), other = await artifact(owner);
  await editSite(site.slug, { content: "<html>new content</html>" }, { actor: { kind: "user", userId: owner.user.id, anonId: null }, method: "api", ip: null, userAgent: null });
  const exported = await exportSiteZip(site.slug, site.currentVersionId);
  expect(exported!.versionId).toBe(site.currentVersionId);
  expect(new TextDecoder().decode(unzipSync(exported!.bytes)["index.html"])).toContain("one");
  expect(await exportSiteZip(site.slug, other.currentVersionId)).toBeNull();
});

it("returns precise tenant errors and skips nonexistent member removal audits", async () => {
  const { GET, PATCH } = await import("@/app/api/tenants/[tenantId]/route");
  const { POST } = await import("@/app/api/tenants/route");
  const { PUT } = await import("@/app/api/tenants/[tenantId]/members/route");
  const { DELETE } = await import("@/app/api/authorization/bindings/[id]/route");
  const owner = await identity(), site = await artifact(owner);
  const oldToken = process.env.PUBLISH_API_TOKEN;
  process.env.PUBLISH_API_TOKEN = "test-platform-operator";
  try {
    const headers = { authorization: "Bearer test-platform-operator" };
    const context = { params: Promise.resolve({ tenantId: "missing" }) };
    expect((await GET(request("", headers), context)).status).toBe(404);
    expect((await PATCH(request("", headers, { name: "Missing" }), context)).status).toBe(404);
    const body = { id: "duplicate", name: "Tenant", adminUserId: owner.user.id };
    expect((await POST(request("", headers, body))).status).toBe(201);
    expect((await POST(request("", headers, body))).status).toBe(409);
    const missing = await PUT(request("", headers, { email: "missing@example.com", role: "member" }), { params: Promise.resolve({ tenantId: "init" }) });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("user_not_found");
    const req = new Request(`${origin}/api/sites/${site.slug}/collaborators?userId=absent`, { method: "DELETE", headers: { cookie: owner.cookie, origin, "content-type":"application/json" }, body:JSON.stringify({expectedRevision:1}) });
    expect((await DELETE(req, { params: Promise.resolve({ id: "absent" }) })).status).toBe(404);
    expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.member.remove' AND target_id=$1", [site.id])).toEqual([]);
  } finally {
    if (oldToken === undefined) delete process.env.PUBLISH_API_TOKEN;
    else process.env.PUBLISH_API_TOKEN = oldToken;
  }
});

it("audits a management mutation once and rechecks SSE access without audit spam", async () => {
  const { canReadSite } = await import("@/lib/share");
  const owner = await identity(), target = await identity(), manager = await identity();
  const site = await artifact(owner);
  await putTenantAdmin(rbacQuery,"init",manager.user.id,true,null);
  const req = request(manager.cookie, { "x-management-reason": "Support request" }, { email: target.user.email });
  expect((await grantMember(req, { params: Promise.resolve({ slug: site.slug }) })).status).toBe(200);
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='authorization.grant' AND target_id=$1", [site.id])).toHaveLength(1);
  expect(await canReadSite(req, site)).toBe(true);
  for (let i = 0; i < 3; i++) expect(await canReadSite(req, site, undefined, false)).toBe(true);
  expect(await rbacQuery("SELECT id FROM rbac_audit WHERE action='site.read' AND target_id=$1", [site.id])).toHaveLength(1);
  await rbacQuery("DELETE FROM tenant_members WHERE tenant_id='init' AND user_id=$1", [manager.user.id]);
  await updateSiteVisibility(site.id, "private");
  expect(await canReadSite(req, { ...site, visibility: "private" }, undefined, false)).toBe(false);
});

it("limits people search after applying tenant membership", async () => {
  const { GET } = await import("@/app/api/users/search/route");
  const viewer = await identity();
  await rbacQuery("INSERT INTO tenants(id,name) VALUES('picker','Picker')");
  await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [viewer.user.id]);
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES('picker',$1)", [viewer.user.id]);
  const target = await upsertUser({ authProvider: "test", providerSubject: "picker-target", displayName: "Picker target" });
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES('picker',$1)", [target.id]);
  for (let i = 0; i < 55; i++) {
    const outsider = await upsertUser({ authProvider: "test", providerSubject: `picker-outsider-${i}`, displayName: "Picker outsider" });
    await rbacQuery("UPDATE users SET last_login_at=$1 WHERE id=$2", [Date.now() + 1000, outsider.id]);
  }
  const response = await GET(new Request(`${origin}/api/users/search?q=Picker`, { headers: { cookie: viewer.cookie } }));
  expect(response.status).toBe(200);
  expect((await response.json()).users.map((u: {id: string}) => u.id)).toEqual([target.id]);
});

it("fails closed for unsupported action gates", async () => {
  const { requirePermission } = await import("@/lib/authz");
  const owner = await identity(), site = await artifact(owner);
  await expect(requirePermission(request(owner.cookie), site, "site.future.manage" as Parameters<typeof requirePermission>[2])).rejects.toThrow("Unsupported permission gate");
});

it("persists one preview secret across concurrent first starts and store restarts", async () => {
  const { previewSecret } = await import("@/lib/preview-secret");
  const secrets = await Promise.all(Array.from({ length: 12 }, () => previewSecret()));
  expect(new Set(secrets.map(s => s.secret)).size).toBe(1);
  expect(secrets[0].secret).toMatch(/^[a-f0-9]{64}$/);
  await closeDbForTests();
  expect(await previewSecret()).toEqual(secrets[0]);
});

it("rotates preview secrets through the admin API without leaking them and rejects stale updates", async () => {
  const { GET, POST } = await import("@/app/api/admin/preview-key/route");
  const { previewSecret } = await import("@/lib/preview-secret");
  const { mintScopedPreviewKey, readScopedPreviewKey } = await import("@/lib/preview-key");
  const owner = await identity(), site = await artifact(owner);
  expect((await GET(request(owner.cookie))).status).toBe(401);
  expect((await POST(request(owner.cookie, {}, { revision: "fake" }))).status).toBe(401);
  const previous = process.env.PUBLISH_API_TOKEN;
  process.env.PUBLISH_API_TOKEN = "preview-test-operator";
  try {
    const headers = { authorization: "Bearer preview-test-operator" };
    const before = await previewSecret();
    const statusResponse = await GET(request("", headers));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({ revision: before.revision, updatedAt: before.updatedAt });
    const grant = { versionId: site.currentVersionId, shareId: null, userId: owner.user.id, anonOwnerHash: null, fingerprint: "" };
    const oldKey = await mintScopedPreviewKey(site, grant);
    const results = await Promise.all([POST(request("", headers, { revision: before.revision })), POST(request("", headers, { revision: before.revision }))]);
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    const after = await previewSecret();
    expect(after.secret).not.toBe(before.secret);
    for (const response of results) {
      const text = await response.text();
      expect(text).not.toContain(before.secret);
      expect(text).not.toContain(after.secret);
    }
    expect(await readScopedPreviewKey(oldKey, site)).toBeNull();
    expect(await readScopedPreviewKey(await mintScopedPreviewKey(site, grant), site)).toMatchObject(grant);
    const audit = await rbacQuery("SELECT * FROM admin_log WHERE target_id='preview-key'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(after.secret);
    await closeDbForTests();
    expect(await previewSecret()).toEqual(after);
  } finally {
    if (previous === undefined) delete process.env.PUBLISH_API_TOKEN;
    else process.env.PUBLISH_API_TOKEN = previous;
  }
});

it("version filtering adds no duplicate administrator read audit", async () => {
  const { readableVersionFilter, canReadSite } = await import("@/lib/share");
  const { listAdminLog } = await import("@/lib/db");
  const owner = await identity(), admin = await identity(), site = await artifact(owner);
  await updateSiteVisibility(site.id, "private");
  site.visibility = "private";
  const adminModule = await import("@/lib/admin");
  const auditRead = vi.spyOn(adminModule, "recordAdminRead");
  const previous = process.env.ARTIFACT_ADMIN_EMAILS;
  process.env.ARTIFACT_ADMIN_EMAILS = admin.user.email!;
  try {
    expect(await canReadSite(request(admin.cookie), site)).toBe(true);
    auditRead.mockClear();
    const allows = await readableVersionFilter(request(admin.cookie), site);
    expect(auditRead).not.toHaveBeenCalled();
    expect(allows(site.currentVersionId)).toBe(true);
    const rows = await listAdminLog({ limit: 100, targetId: site.id });
    expect(rows.filter(r => r.action === "site.view")).toHaveLength(1);
  } finally {
    auditRead.mockRestore();
    if (previous === undefined) delete process.env.ARTIFACT_ADMIN_EMAILS;
    else process.env.ARTIFACT_ADMIN_EMAILS = previous;
  }
});

it("records one access audit per management preview without a second preview event", async () => {
  const owner = await identity(), manager = await identity(), site = await artifact(owner);
  await updateSiteVisibility(site.id, "private");
  site.visibility = "private";
  await putTenantAdmin(rbacQuery,"init",manager.user.id,true,null);
  const access = await authorizePreview(request(manager.cookie, { "x-management-reason": "Support investigation" }), site, null);
  expect(access).not.toBeNull();
  expect(await rbacQuery("SELECT action FROM rbac_audit WHERE target_id=$1 AND actor_id=$2", [site.id, manager.user.id])).toEqual([{ action: "site.read" }]);
  expect(await authorizePreview(request(), site, access!.key)).not.toBeNull();
  expect(await rbacQuery("SELECT action FROM rbac_audit WHERE target_id=$1 AND actor_id=$2", [site.id, manager.user.id])).toEqual([{ action: "site.read" }]);
});

it("keeps an access audit for operator previews that pass the ordinary capability gate", async () => {
  const owner = await identity(), site = await artifact(owner);
  await updateSiteVisibility(site.id, "private");
  site.visibility = "private";
  const previous = process.env.PUBLISH_API_TOKEN;
  process.env.PUBLISH_API_TOKEN = "audit-preview-operator";
  try {
    const access = await authorizePreview(request("", { authorization: "Bearer audit-preview-operator" }), site, null);
    expect(access).not.toBeNull();
    expect(await rbacQuery("SELECT action FROM rbac_audit WHERE target_id=$1", [site.id])).toEqual([{ action: "site.read" }]);
  } finally {
    if (previous === undefined) delete process.env.PUBLISH_API_TOKEN;
    else process.env.PUBLISH_API_TOKEN = previous;
  }
});

it("downloads snapshots through the HTTP export gate and audits management downloads", async () => {
  const { GET } = await import("@/app/api/sites/[slug]/export/route");
  const { unzipSync } = await import("fflate");
  const owner = await identity(), admin = await identity(), reader = await identity();
  const site = await artifact(owner), other = await artifact(owner);
  const context = { params: Promise.resolve({ slug: site.slug }) };
  const download = (cookie: string, version = site.currentVersionId, headers = {}) => GET(
    new Request(`${origin}/api/sites/${site.slug}/export?version=${version}`, { headers: { cookie, ...headers } }), context);
  await editSite(site.slug, { content: "<html>second</html>" }, { actor: { kind: "user", userId: owner.user.id, anonId: null }, method: "api", ip: null, userAgent: null });
  const response = await download(owner.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-artifact-version")).toBe(site.currentVersionId);
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  expect(new TextDecoder().decode(unzipSync(new Uint8Array(await response.arrayBuffer()))["index.html"])).toContain("one");
  expect((await download(reader.cookie)).status).toBe(403);
  expect((await download(owner.cookie, other.currentVersionId)).status).toBe(404);
  const previous = process.env.ARTIFACT_ADMIN_EMAILS;
  process.env.ARTIFACT_ADMIN_EMAILS = admin.user.email!;
  try {
    for (const headers of [{}, { "x-management-reason": "" }, { "x-management-reason": "   " }, { "x-management-reason": "x".repeat(501) }]) {
      const denied = await download(admin.cookie, site.currentVersionId, headers);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: "You do not have permission to perform this action on this report" });
    }
    expect(await rbacQuery("SELECT * FROM rbac_audit WHERE target_id=$1 AND action=$2", [site.id, "site.source.export"])).toHaveLength(0);
    // A download is a read: taking a site down must not prevent the owner or an explicit
    // administrator from retrieving its saved files. No mutation permission is relaxed.
    await rbacQuery("UPDATE sites SET taken_down_at=$1 WHERE id=$2", [Date.now(), site.id]);
    expect((await download(owner.cookie)).status).toBe(200);
    expect((await download(admin.cookie, site.currentVersionId, { "x-management-reason": "  Support export  " })).status).toBe(200);
    const rows = await rbacQuery("SELECT * FROM rbac_audit WHERE target_id=$1 AND action=$2", [site.id, "site.source.export"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Support export");
    const { managementReasonHeaders } = await import("@/lib/management-reason");
    const chinese = managementReasonHeaders("支持导出\r\n工单确认 ✅");
    expect((await download(admin.cookie, site.currentVersionId, chinese)).status).toBe(200);
    const decodedAudits = await rbacQuery("SELECT action,reason FROM rbac_audit WHERE target_id=$1 AND reason=$2", [site.id, "支持导出 工单确认 ✅"]);
    expect(decodedAudits).toEqual([{ action: "site.source.export", reason: "支持导出 工单确认 ✅" }]);
    const rejectedReason = managementReasonHeaders("Rejected version export");
    expect((await download(admin.cookie, other.currentVersionId, rejectedReason)).status).toBe(404);
    expect(await rbacQuery("SELECT * FROM rbac_audit WHERE target_id=$1 AND reason=$2", [site.id, "Rejected version export"])).toHaveLength(0);
    // Ordinary reads retain their audit; only the export route owns its own event.
    const { getReadableView } = await import("@/lib/read-view");
    await getReadableView(request(admin.cookie, managementReasonHeaders("Normal administrative read")), site.slug);
    expect(await rbacQuery("SELECT action FROM rbac_audit WHERE target_id=$1 AND reason=$2", [site.id, "Normal administrative read"])).toEqual([{ action: "site.read" }]);
    expect((await download(admin.cookie, site.currentVersionId, managementReasonHeaders("中".repeat(501)))).status).toBe(403);
    // A normal editor/owner can supply a reason but must not be logged as an administrator.
    expect((await download(owner.cookie, site.currentVersionId, managementReasonHeaders("Owner export"))).status).toBe(200);
    expect(await rbacQuery("SELECT * FROM rbac_audit WHERE target_id=$1 AND reason=$2", [site.id, "Owner export"])).toHaveLength(0);
    await rbacQuery("UPDATE sites SET deleted_at=$1 WHERE id=$2", [Date.now(), site.id]);
    expect((await download(owner.cookie)).status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACT_ADMIN_EMAILS;
    else process.env.ARTIFACT_ADMIN_EMAILS = previous;
  }
});
