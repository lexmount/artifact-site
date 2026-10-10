import { afterEach, expect, it } from "vitest";
import { closeDbForTests, createId, rbacQuery, upsertUser } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { putUserSiteRole } from "@/lib/role-bindings";
import { GET } from "@/app/api/sites/[slug]/sharing/route";

const origin = "https://sharing.example";
afterEach(closeDbForTests);
it("returns a bounded member preview only to sharing managers and leaves the ordinary response compatible", async () => {
  const owner = await upsertUser({ authProvider: "test", providerSubject: createId("owner"), email: "owner@example.com" });
  const { site } = await createSite({ mode: "paste", html: "<h1>Private</h1>" }, { ownerId: owner.id });
  const { cookie } = await mintSession(new Request(origin), owner.id);
  const context = { params: Promise.resolve({ slug: site.slug }) };
  const members = [];
  for (let i = 0; i < 5; i++) {
    const member = await upsertUser({ authProvider: "test", providerSubject: createId("member"), displayName: `Member ${i}`, email: `member${i}@example.com` });
    members.push(member);
    await putUserSiteRole(rbacQuery, site.id, member.id, "viewer", owner.id);
  }
  const response = await GET(new Request(`${origin}/api/sites/${site.slug}/sharing?summary=1`, { headers: { cookie } }), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const summary = await response.json();
  expect(summary.canManageMembers).toBe(true);
  expect(summary.members).toHaveLength(3);
  expect(summary.moreMembers).toBe(true);
  expect(summary.members.every((member: { name: string }) => member.name.startsWith("Member "))).toBe(true);
  const ordinary = await GET(new Request(origin, { headers: { cookie } }), context);
  expect((await ordinary.json()).members).toBeUndefined();
  const reader = await mintSession(new Request(origin), members[0].id);
  expect((await GET(new Request(`${origin}?summary=1`, { headers: { cookie: reader.cookie } }), context)).status).toBe(403);
  expect((await GET(new Request(`${origin}?summary=1`), context)).status).toBe(403);
  // Sharing and member management are separate permissions, even if current built-in roles bundle them.
  await putUserSiteRole(rbacQuery, site.id, members[0].id, "site-admin", owner.id);
  await rbacQuery("DELETE FROM role_permissions WHERE role_id='site-admin' AND permission_code='site.members.manage'");
  try {
    const limited = await GET(new Request(`${origin}?summary=1`, { headers: { cookie: reader.cookie } }), context);
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({ canManageMembers: false, members: [], moreMembers: false });
  } finally {
    await rbacQuery("INSERT INTO role_permissions(role_id,permission_code) VALUES('site-admin','site.members.manage')");
  }
});
