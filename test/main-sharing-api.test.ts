import { afterEach, expect, it, vi } from "vitest";
import { createId, upsertUser, getSite, rbacQuery, closeDbForTests, listSiteSummaries } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { resolveCommentAccess } from "@/lib/comments/access";
import { describeCommentPermissions } from "@/lib/comments/permissions";
import { createComment } from "@/lib/comments/service";
import { canReadSite, resolveShareAccess } from "@/lib/share";
import { GET, PUT } from "@/app/api/sites/[slug]/main-sharing/route";
import { POST as createShare } from "@/app/api/sites/[slug]/shares/route";
const origin = "https://sharing.test";
afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });
it("applies main-link and Discover updates immediately in the public edition", async () => {
  vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "private");
  const owner = await upsertUser({ authProvider: "test", providerSubject: createId("owner") });
  const { site } = await createSite({ mode: "paste", html: "<h1>Share now</h1>" }, { ownerId: owner.id });
  const { cookie } = await mintSession(new Request(origin), owner.id);
  const ctx = { params: Promise.resolve({ slug: site.slug }) };
  const req = (method = "GET", body?: unknown) => new Request(origin + `/api/sites/${site.slug}/main-sharing`, {
    method, headers: { cookie, origin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const shared = await createShare(req("POST", { policy: "public" }), ctx);
  expect(shared.status).toBe(201);
  const link = await shared.json();
  for (const [audience, visibility, listed] of [["anyone", "unlisted", false], ["public", "public", true], ["anyone", "unlisted", false], ["tenant", "private", false]] as const) {
    const response = await PUT(req("PUT", { action: "custom", policy: { audience, comments: false } }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ policy: { audience, comments: false }, pending: false });
    const fresh = (await getSite(site.id))!;
    expect(fresh.visibility).toBe(visibility);
    expect(await canReadSite(new Request(origin), fresh)).toBe(audience !== "tenant");
    expect((await listSiteSummaries()).some(s => s.slug === site.slug)).toBe(listed);
    expect((await resolveShareAccess(new Request(origin), link.token)).ok).toBe(true);
    expect(await (await GET(req(), ctx)).json()).toMatchObject({ links: 1, pending: false });
  }
  const stopped = await PUT(req("PUT", { action: "stop" }), ctx);
  expect(stopped.status).toBe(200);
  expect(await (await GET(req(), ctx)).json()).toMatchObject({ policy: { audience: "private", comments: false }, links: 0, members: 0 });
  expect((await resolveShareAccess(new Request(origin), link.token)).ok).toBe(false);
});


it.each(["off", "login", "members", "missing"] as const)("preserves anonymous legacy %s discussions when changing link and Discover access", async legacyPolicy => {
  vi.stubEnv("ARTIFACT_DEFAULT_VISIBILITY", "public");
  const anonId = createId("anonymous");
  const { site } = await createSite({ mode: "paste", html: "<h1>Legacy discussion</h1>" }, { anonOwnerId: anonId });
  const reader = await upsertUser({ authProvider: "legacy-sharing", providerSubject: createId("reader") });
  const { cookie } = await mintSession(new Request(origin), reader.id);
  const readerRequest = new Request(origin, { headers: { cookie, origin } });
  const scope = { siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" as const } };
  await createComment(readerRequest, site.slug, { scope, body: "Existing legacy discussion", clientRequestId: crypto.randomUUID(), anchor: { schemaVersion: 1, kind: "document", filePath: "index.html" } });
  if (legacyPolicy === "missing") await rbacQuery("DELETE FROM site_comment_settings WHERE site_id=$1", [site.id]);
  else await rbacQuery("UPDATE site_comment_settings SET main_policy=$1,reader_access=0 WHERE site_id=$2", [legacyPolicy, site.id]);
  const readers = [new Request(origin), readerRequest];
  const before = await Promise.all(readers.map(async request => describeCommentPermissions(await resolveCommentAccess(request, site, scope)).canRead));
  expect(before).toEqual([false, legacyPolicy === "login" || legacyPolicy === "missing"]);
  const context = { params: Promise.resolve({ slug: site.slug }) };
  for (const audience of ["anyone", "public"] as const) {
    const response = await PUT(new Request(origin + `/api/sites/${site.slug}/main-sharing`, { method: "PUT", headers: { origin, cookie: `__Host-ah_anon=${anonId}`, "content-type": "application/json" }, body: JSON.stringify({ action: "custom", policy: { audience, comments: legacyPolicy !== "off" } }) }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ policy: { audience }, pending: false });
    const fresh = (await getSite(site.id))!;
    expect(await Promise.all(readers.map(async request => describeCommentPermissions(await resolveCommentAccess(request, fresh, scope)).canRead))).toEqual(before);
    expect(await rbacQuery("SELECT main_policy,reader_access FROM site_comment_settings WHERE site_id=$1", [site.id])).toMatchObject([{ main_policy: legacyPolicy === "missing" ? "login" : legacyPolicy, reader_access: 0 }]);
  }
  const stopped = await PUT(new Request(origin, { method: "PUT", headers: { origin, cookie: `__Host-ah_anon=${anonId}`, "content-type": "application/json" }, body: JSON.stringify({ action: "custom", policy: { audience: "anyone", comments: false } }) }), context);
  expect(stopped.status).toBe(200);
  expect(await rbacQuery("SELECT main_policy,reader_access FROM site_comment_settings WHERE site_id=$1", [site.id])).toMatchObject([{ main_policy: "off", reader_access: 0 }]);
});

it("rejects an outdated main-sharing revision before it can reopen restricted access", async () => {
  const owner = await upsertUser({ authProvider: "sharing-revision", providerSubject: createId("owner") });
  const { site } = await createSite({ mode: "paste", html: "<h1>Revision guard</h1>" }, { ownerId: owner.id });
  const { cookie } = await mintSession(new Request(origin), owner.id);
  const context = { params: Promise.resolve({ slug: site.slug }) };
  const request = (policy: { audience: string; comments: boolean }, expectedRevision?: number) => new Request(origin, { method: "PUT", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ action: "custom", policy, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) });
  expect((await PUT(request({ audience: "anyone", comments: true }), context)).status).toBe(200);
  const stale = await (await GET(new Request(origin, { headers: { cookie } }), context)).json();
  expect((await PUT(request({ audience: "private", comments: true }), context)).status).toBe(200);
  const response = await PUT(request({ audience: "anyone", comments: false }, stale.revision), context);
  expect(response.status).toBe(409);
  expect(await (await GET(new Request(origin, { headers: { cookie } }), context)).json()).toMatchObject({ policy: { audience: "private", comments: true } });
});
