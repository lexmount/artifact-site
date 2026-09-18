import { afterEach, describe, expect, it } from "vitest";
import { closeDbForTests, createId, createShare, getShare, rbacQuery, rbacTransaction, revokeShare, upsertUser } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { buildPasscodeCookie, hashPasscode, hashToken, resolveShareAccess, sharePolicyAccess } from "@/lib/share";
import { resolveCommentAccess, requireCommentAccess } from "@/lib/comments/access";
import { describeCommentPermissions } from "@/lib/comments/permissions";
import type { ShareMode } from "@/lib/rbac";
import type { Site, SharePolicy } from "@/lib/types";

const origin = "https://comments.example";
afterEach(closeDbForTests);
async function identity() {
  const user = await upsertUser({ authProvider: "comment-access", providerSubject: createId("identity"), email: `${createId("mail")}@example.com`, emailVerified: true });
  const { session, cookie } = await mintSession(new Request(origin), user.id);
  return { user, session, cookie: cookie.split(";")[0] };
}
function request(cookie = "", token?: string, query = "", headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/comments${query}`, { headers: { cookie, ...(token ? { "x-artifact-share": token } : {}), ...headers } });
}
async function fixture() {
  const owner = await identity(), reader = await identity();
  const { site } = await createSite({ mode: "paste", html: "<html><body>Review this</body></html>" }, { ownerId: owner.user.id });
  await rbacQuery("UPDATE sites SET visibility='private' WHERE id=$1", [site.id]);
  return { owner, reader, site: { ...site, visibility: "private" as const } };
}
async function link(site: Site, mode: ShareMode = "comment", policy: SharePolicy = "public", versionId: string | null = null) {
  const token = createId("credential");
  const share = await createShare({ id: createId("share"), siteId: site.id, tokenHash: hashToken(token), policy, passcodeHash: policy === "passcode" ? hashPasscode("correct") : null, label: null, createdBy: site.ownerId, createdAnonId: null, expiresAt: null, mode, versionId });
  return { token, share, scope: { siteId: site.id, versionId: versionId ?? site.currentVersionId, entry: { kind: "share" as const, shareId: share.id } } };
}
const main = (site: Site) => ({ siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" as const } });

describe("comment access with real credentials and storage", () => {
  it.each(["header", "query", "both"])("excludes %s share credentials from private main access", async carrier => {
    const { site, reader } = await fixture();
    const { token, scope } = await link(site, "view");
    const req = request(reader.cookie, carrier !== "query" ? token : undefined, carrier !== "header" ? `?share=${token}` : "");
    expect((await resolveCommentAccess(req, site, scope)).canReadArtifact).toBe(true);
    const facts = await resolveCommentAccess(req, site, main(site));
    expect(facts.canReadMainArtifact).toBe(false);
    expect(describeCommentPermissions(facts).canRead).toBe(false);
    await expect(requireCommentAccess(req, site, main(site))).rejects.toMatchObject({ statusCode: 404 });
  });
  it("allows independent public main access while view shares hide their own discussions", async () => {
    const { site, reader } = await fixture();
    const { token, scope } = await link(site, "view");
    await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1", [site.id]);
    const req = request(reader.cookie, token);
    expect(describeCommentPermissions(await resolveCommentAccess(req, site, main(site))).canCreate).toBe(true);
    expect(describeCommentPermissions(await resolveCommentAccess(req, site, scope)).canRead).toBe(false);
  });
  it("checks the exact share and site rather than possession of any working link", async () => {
    const { site, reader } = await fixture();
    const one = await link(site), two = await link(site);
    const req = request(reader.cookie, one.token);
    expect(describeCommentPermissions(await resolveCommentAccess(req, site, one.scope)).canReply).toBe(true);
    expect(describeCommentPermissions(await resolveCommentAccess(req, site, two.scope)).canRead).toBe(false);
    const other = await fixture();
    expect((await resolveCommentAccess(req, other.site, one.scope)).canReadArtifact).toBe(false);
  });
  it("permits anonymous comment-share reads but requires an account to write", async () => {
    const { site } = await fixture();
    for (const mode of ["comment", "edit"] as const) {
      const { scope, token } = await link(site, mode);
      expect(describeCommentPermissions(await resolveCommentAccess(request("", token), site, scope))).toMatchObject({ canRead: true, canCreate: false, canReply: false });
    }
  });
  it("revalidates share revocation and preserves owner inspection without authoring", async () => {
    const { site, owner, reader } = await fixture();
    const { scope, token, share } = await link(site);
    await revokeShare(share.id, Date.now());
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie, token), site, scope)).canRead).toBe(false);
    expect(describeCommentPermissions(await resolveCommentAccess(request(owner.cookie), site, scope))).toMatchObject({ canRead: true, canCreate: false, canModerate: true });
  });
  it("limits following links to current version while pinned edit links support comments", async () => {
    const { site, reader } = await fixture();
    const following = await link(site), pinned = await link(site, "edit", "public", site.currentVersionId);
    const result = await editSite(site.slug, { content: "<html>Updated</html>" }, { actor: { kind: "user", userId: site.ownerId, anonId: null }, method: "api", ip: null, userAgent: null });
    if (!result || "conflict" in result) throw new Error("Fixture edit failed");
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie, following.token), site, following.scope)).canRead).toBe(false);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie, pinned.token), site, pinned.scope)).canCreate).toBe(true);
    expect((await resolveCommentAccess(request(reader.cookie, pinned.token), site, { ...pinned.scope, versionId: result.site.currentVersionId })).canReadArtifact).toBe(false);
  });
  it("checks passcode grants and verified people grants", async () => {
    const { site, reader } = await fixture();
    const passcode = await link(site, "comment", "passcode");
    expect((await resolveCommentAccess(request(reader.cookie, passcode.token), site, passcode.scope)).shareMode).toBeNull();
    const cookie = buildPasscodeCookie(request(), (await getShare(passcode.share.id))!).split(";")[0];
    expect((await resolveCommentAccess(request(`${reader.cookie}; ${cookie}`, passcode.token), site, passcode.scope)).shareMode).toBe("comment");
    const people = await link(site, "comment", "people");
    expect((await resolveCommentAccess(request(reader.cookie, people.token), site, people.scope)).shareMode).toBeNull();
    await rbacQuery("INSERT INTO share_grants(share_id,user_id,email,granted_at) VALUES($1,NULL,$2,$3)", [people.share.id, reader.user.email!, Date.now()]);
    expect((await resolveCommentAccess(request(reader.cookie, people.token), site, people.scope)).shareMode).toBe("comment");
    await rbacQuery("UPDATE users SET email_verified=FALSE WHERE id=$1", [reader.user.id]);
    expect((await resolveCommentAccess(request(reader.cookie, people.token), site, people.scope)).shareMode).toBeNull();
  });
  it("uses current session, membership, tenant and takedown state", async () => {
    const { site, owner, reader } = await fixture();
    await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'editor',$3)", [site.id, reader.user.id, Date.now()]);
    expect((await resolveCommentAccess(request(reader.cookie), site, main(site))).accountRole).toBe("editor");
    await rbacTransaction(async q => {
      await q("DELETE FROM site_members WHERE site_id=$1 AND user_id=$2", [site.id, reader.user.id]);
      expect((await resolveCommentAccess(request(reader.cookie), site, main(site), reader.session)).accountRole).toBeNull();
    });
    await rbacQuery("UPDATE sites SET taken_down_at=$1 WHERE id=$2", [Date.now(), site.id]);
    expect(describeCommentPermissions(await resolveCommentAccess(request(owner.cookie), site, main(site)))).toMatchObject({ canRead: true, canCreate: false });
    await rbacQuery("UPDATE tenants SET disabled_at=$1 WHERE id=$2", [Date.now(), site.tenantId]);
    expect((await resolveCommentAccess(request(owner.cookie), site, main(site))).canReadArtifact).toBe(false);
    await rbacQuery("UPDATE tenants SET disabled_at=NULL WHERE id=$1", [site.tenantId]);
    await rbacQuery("UPDATE sessions SET revoked_at=$1 WHERE id=$2", [Date.now(), owner.session.id]);
    await expect(resolveCommentAccess(request(owner.cookie), site, main(site), owner.session)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("does not advertise writes for delegated read-only tokens", async () => {
    const { site, owner } = await fixture();
    const facts = await resolveCommentAccess(request(owner.cookie), site, main(site), { ...owner.session, scopes: ["artifacts:read"] });
    expect(describeCommentPermissions(facts)).toMatchObject({ canRead: true, canCreate: false });
  });
  it("matches latest/official artifact access without widening fixed shares or private main access",async()=>{
    const {site,owner,reader}=await fixture();
    const following=await link(site), pinned=await link(site,"comment","public",site.currentVersionId);
    const result=await editSite(site.slug,{content:"<html>Latest</html>"},{actor:{kind:"user",userId:owner.user.id,anonId:null},method:"api",ip:null,userAgent:null});
    if(!result || "conflict" in result)throw new Error("Fixture edit failed");
    const latestScope={...following.scope,versionId:result.site.currentVersionId};
    await rbacQuery("UPDATE sites SET official_version_id=$1 WHERE id=$2",[site.currentVersionId,site.id]);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie,following.token),site,following.scope)).canCreate).toBe(true);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie,following.token),site,latestScope)).canCreate).toBe(true);
    expect((await resolveCommentAccess(request(reader.cookie,following.token),site,main(site))).canReadMainArtifact).toBe(false);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie,pinned.token),site,{...pinned.scope,versionId:result.site.currentVersionId})).canRead).toBe(false);
    await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1",[site.id]);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie),site,main(site))).canCreate).toBe(true);
    await rbacQuery("UPDATE sites SET official_version_id=NULL WHERE id=$1",[site.id]);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie,following.token),site,following.scope)).canRead).toBe(false);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie),site,main(site))).canRead).toBe(false);
    expect(describeCommentPermissions(await resolveCommentAccess(request(owner.cookie),site,main(site))).canCreate).toBe(true);
    expect(describeCommentPermissions(await resolveCommentAccess(request(reader.cookie,pinned.token),site,pinned.scope)).canRead).toBe(true);
  });

});

it.each(["public", "login", "people", "passcode"] as const)(
  "shares %s admission between artifact and comment reads",
  async (policy) => {
    const { site, reader } = await fixture();
    const item = await link(site, "comment", policy);
    for (const cookie of ["", reader.cookie]) {
      const r = request(cookie, item.token);
      expect(
        describeCommentPermissions(
          await resolveCommentAccess(r, site, item.scope),
        ).canRead,
      ).toBe((await resolveShareAccess(r, item.token)).ok);
    }
  },
);
it("denies unknown policies in the shared admission helper", async () => {
  const { site, reader } = await fixture();
  const item = await link(site);
  const r = request(reader.cookie, item.token);
  expect((await sharePolicyAccess(r, { ...item.share, tokenHash: hashToken(item.token), passcodeHash: null, policy: "unknown" as SharePolicy })).ok).toBe(false);
});
