import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDbForTests, rbacQuery, upsertUser } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { searchSites } from "@/lib/search";
import { resolveCommentAccess } from "@/lib/comments/access";
import { describeCommentPermissions } from "@/lib/comments/permissions";
import { mintSession } from "@/lib/session";
import { commentSettings } from "@/lib/comments/service";

beforeEach(() => vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", ""));
afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });
it("creates privately even without a configured public URL", async () => {
  const { site } = await createSite({ mode: "paste", html: "<h1>Private launch</h1>" });
  expect(site.visibility).toBe("private");
});
it("allows anonymous reading only for new main discussions after link access is enabled", async () => {
  const user = await upsertUser({ authProvider: "simplification", providerSubject: "owner", email: "owner@example.com" });
  const { site } = await createSite({ mode: "paste", html: "<h1>Launch review</h1>" }, { ownerId: user.id });
  const scope = { siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" as const } };
  const request = new Request("https://example.com");
  expect(describeCommentPermissions(await resolveCommentAccess(request, site, scope)).canRead).toBe(false);
  await rbacQuery("UPDATE sites SET visibility='unlisted' WHERE id=$1", [site.id]);
  const access = describeCommentPermissions(await resolveCommentAccess(request, site, scope));
  expect(access.canRead).toBe(true);
  expect(access.canCreate).toBe(false);
  expect(await searchSites(undefined, "Launch", 10)).toEqual([]);
  const reader = await upsertUser({ authProvider: "simplification", providerSubject: "reader", email: "reader@example.com" });
  const readerSession = await mintSession(request, reader.id);
  const readerRequest = new Request("https://example.com/api", { headers: { cookie: readerSession.cookie } });
  expect(describeCommentPermissions(await resolveCommentAccess(readerRequest, site, scope))).toMatchObject({ canRead: true, canCreate: true, canReply: true, canManageSettings: false });
  const { cookie } = await mintSession(request, user.id);
  const ownerRequest = new Request("https://example.com/api", { method: "PATCH", headers: { cookie, origin: "https://example.com" } });
  await commentSettings(ownerRequest, site.slug, { mainPolicy: "off" });
  const closed = describeCommentPermissions(await resolveCommentAccess(request, site, scope));
  expect(closed.canRead).toBe(true);
  expect(closed.canCreate).toBe(false);
  expect(describeCommentPermissions(await resolveCommentAccess(readerRequest, site, scope))).toMatchObject({ canRead: true, canCreate: false, canReply: false });
  expect(describeCommentPermissions(await resolveCommentAccess(ownerRequest, site, scope)).canCreate).toBe(false);
  // Legacy sites without the new opt-in keep their old login/off behavior.
  await rbacQuery("DELETE FROM site_comment_settings WHERE site_id=$1", [site.id]);
  expect(describeCommentPermissions(await resolveCommentAccess(request, site, scope)).canRead).toBe(false);
});
