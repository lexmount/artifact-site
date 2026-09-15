// Per-site edit token — selectively sharing edit access. Viewing stays open; mutations (edit/delete/rename/rollback)
// require the site's edit token (x-edit-token header OR ?t= query), timing-safe compared. Fork stays
// open and mints a fresh token for the new site. Public GET payloads must never leak the token.
import { afterEach, describe, expect, it } from "vitest";
import { createSite } from "@/lib/sites";
import { backfillEditTokens, createEditToken, getSite, setEditToken } from "@/lib/db";
import { GET as listGET, POST as sitesPOST } from "@/app/api/sites/route";
import { DELETE as itemDELETE, GET as itemGET, PATCH as itemPATCH } from "@/app/api/sites/[slug]/route";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";
import { POST as forkPOST } from "@/app/api/sites/[slug]/fork/route";
import { POST as rollbackPOST } from "@/app/api/sites/[slug]/rollback/route";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

function editReq(slug: string, body: unknown, opts: { token?: string; queryToken?: string } = {}): Request {
  const url = opts.queryToken
    ? `http://x/api/sites/${slug}/edit?t=${encodeURIComponent(opts.queryToken)}`
    : `http://x/api/sites/${slug}/edit`;
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.token ? { "x-edit-token": opts.token } : {}) },
    body: JSON.stringify(body),
  });
}

async function createViaApi(html = "<title>T</title><body>x</body>"): Promise<{ slug: string; editToken: string }> {
  const res = await sitesPOST(new Request("http://x/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "paste", html }),
  }));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ slug: string; editToken: string }>;
}

afterEach(() => { delete process.env.PUBLISH_API_TOKEN; });

describe("edit token — generation & backfill", () => {
  it("createEditToken produces ~24 url-safe chars", () => {
    const token = createEditToken();
    expect(token).toHaveLength(24);
    expect(token).toMatch(URL_SAFE);
  });

  it("createSite mints a per-site edit token", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Tok</title><body>x</body>" });
    expect(site.editToken).toHaveLength(24);
    expect(site.editToken).toMatch(URL_SAFE);
  });

  it("POST /api/sites returns the editToken to the creator", async () => {
    const { slug, editToken } = await createViaApi();
    expect(slug).toBeTruthy();
    expect(editToken).toHaveLength(24);
    expect(editToken).toMatch(URL_SAFE);
  });

  it("backfills a legacy site row that has no edit token", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Legacy</title><body>x</body>" });
    // Simulate a row created before the feature existed.
    await setEditToken(site.id, "");
    expect((await getSite(site.id))!.editToken).toBe("");

    const fixed = await backfillEditTokens();
    expect(fixed).toBeGreaterThanOrEqual(1);
    expect((await getSite(site.id))!.editToken).toMatch(URL_SAFE);
    expect((await getSite(site.id))!.editToken.length).toBeGreaterThanOrEqual(20);
  });
});

describe("edit token — mutations are gated (403 without, 200 with)", () => {
  it("edit: 403 without token, 200 with the header token, 401 with originless ?t=, 403 with a wrong token", async () => {
    const { slug, editToken } = await createViaApi("<title>E</title><body>one</body>");

    const noToken = await editPOST(editReq(slug, { content: "<body>two</body>" }), params(slug));
    expect(noToken.status).toBe(403);

    const viaHeader = await editPOST(editReq(slug, { content: "<body>two</body>" }, { token: editToken }), params(slug));
    expect(viaHeader.status).toBe(200);

    const viaQuery = await editPOST(editReq(slug, { content: "<body>three</body>" }, { queryToken: editToken }), params(slug));
    expect(viaQuery.status).toBe(401);

    const wrong = await editPOST(editReq(slug, { content: "<body>four</body>" }, { token: "not-the-token" }), params(slug));
    expect(wrong.status).toBe(403);
  });

  it("delete: 403 without token, 200 with token", async () => {
    const denied = await createViaApi("<title>DA</title><body>x</body>");
    const delNo = await itemDELETE(new Request("http://x/", { method: "DELETE" }), params(denied.slug));
    expect(delNo.status).toBe(403);

    const allowed = await createViaApi("<title>DB</title><body>x</body>");
    const delYes = await itemDELETE(
      new Request("http://x/", { method: "DELETE", headers: { "x-edit-token": allowed.editToken } }),
      params(allowed.slug),
    );
    expect(delYes.status).toBe(200);
    expect((await delYes.json()).deleted).toBe(true);
  });

  it("rename: 403 without token, 200 with token", async () => {
    const { slug, editToken } = await createViaApi("<title>RN</title><body>x</body>");
    const patch = (token?: string) => new Request("http://x/", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(token ? { "x-edit-token": token } : {}) },
      body: JSON.stringify({ title: "新名字" }),
    });
    expect((await itemPATCH(patch(), params(slug))).status).toBe(403);
    expect((await itemPATCH(patch(editToken), params(slug))).status).toBe(200);
  });

  it("rollback: 403 without token, 200 with token", async () => {
    const { slug, editToken } = await createViaApi("<title>RB</title><body>one</body>");
    // Make a second version so there is an earlier one to roll back to.
    await editPOST(editReq(slug, { content: "<body>two</body>" }, { token: editToken }), params(slug));
    const versionsRes = await itemGET(new Request(`http://x/api/sites/${slug}`,{headers:{"x-edit-token":editToken}}), params(slug));
    const { site } = await versionsRes.json();
    // The current version id is on site.currentVersionId; roll back to it (still a valid, owned version).
    const targetVersionId = site.currentVersionId as string;

    const roll = (token?: string) => new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-edit-token": token } : {}) },
      body: JSON.stringify({ versionId: targetVersionId }),
    });
    expect((await rollbackPOST(roll(), params(slug))).status).toBe(403);
    expect((await rollbackPOST(roll(editToken), params(slug))).status).toBe(200);
  });

  it("admin override: the global PUBLISH_API_TOKEN Bearer unlocks edits without a per-site token", async () => {
    const { slug } = await createViaApi("<title>Admin</title><body>x</body>");
    process.env.PUBLISH_API_TOKEN = "s3cret";

    const forbidden = await editPOST(editReq(slug, { content: "<body>z</body>" }), params(slug));
    expect(forbidden.status).toBe(403);

    const req = new Request(`http://x/api/sites/${slug}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: JSON.stringify({ content: "<body>z</body>" }),
    });
    expect((await editPOST(req, params(slug))).status).toBe(200);
  });
});

describe("authorized fork mints a fresh token", () => {
  it("forks with source access and returns an independent anonymous token", async () => {
    const source = await createViaApi("<title>Src</title><body>x</body>");
    const res = await forkPOST(new Request("http://x/", { method: "POST", headers:{"x-edit-token":source.editToken} }), params(source.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBeTruthy();
    expect(body.slug).not.toBe(source.slug);
    expect(body.editToken).toHaveLength(24);
    expect(body.editToken).not.toBe(source.editToken);
  });
});

describe("public GET payloads never leak the edit token", () => {
  it("GET /api/sites/:slug omits edit_token from the site payload", async () => {
    const { slug, editToken } = await createViaApi("<title>Leak</title><body>x</body>");
    const res = await itemGET(new Request(`http://x/api/sites/${slug}`,{headers:{"x-edit-token":editToken}}), params(slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.editToken).toBeUndefined();
    expect(body.site).toBeTruthy();
    expect(body.site.editToken).toBeUndefined();
    // Raw serialized body must not contain the string anywhere either.
    expect(JSON.stringify(body)).not.toContain("editToken");
    expect(JSON.stringify(body)).not.toContain("edit_token");
  });

  it("GET /api/sites (list) omits edit_token from every entry", async () => {
    await createViaApi("<title>ListLeak</title><body>x</body>");
    const res = await listGET();
    expect(res.status).toBe(200);
    const { sites } = await res.json();
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) expect(s.editToken).toBeUndefined();
    expect(JSON.stringify(sites)).not.toContain("editToken");
    expect(JSON.stringify(sites)).not.toContain("edit_token");
  });
});
