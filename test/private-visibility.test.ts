// `private` finally means something. PR#27 refused this value because nothing enforced it — the
// API answered 200 and left the site world-readable. This file used to pin that refusal; it now
// pins the enforcement that replaced it.
//
// The load-bearing cases are the CONTENT OUTLETS, not the page. `/api/preview` is where an
// artifact's bytes come out and `POST /fork` copies the whole version tree into a site the forker
// owns, so a suite that only checked `/s/<slug>` would pass over a wide-open door.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSite, updateSiteSharing } from "@/lib/db";
import { createSite, getSiteView } from "@/lib/sites";
import { canReadSite } from "@/lib/share";
import { PUT as sharingPUT } from "@/app/api/sites/[slug]/sharing/route";
import { GET as itemGET } from "@/app/api/sites/[slug]/route";
import { GET as previewGET } from "@/app/api/preview/[slug]/[[...path]]/route";
import { POST as forkPOST } from "@/app/api/sites/[slug]/fork/route";
import { generateMetadata as generateSiteMetadata } from "@/app/s/[slug]/page";

// generateMetadata resolves the origin from headers(), which needs a request scope Next only
// provides while serving. A stranger's request carries no credentials — which is the case under test.
// `cookies` too: the page's copy is resolved through getT(), which reads the locale cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "x" }),
  cookies: async () => ({ get: () => undefined }),
}));

const ANON = "anon_owner_under_test";
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "private-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
});
afterEach(async () => {
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER",
    "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[key];
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const ownerCreds = { cookie: `__Host-ah_anon=${ANON}`, "x-forwarded-proto": "https", origin: "https://x" };
const strangerCreds = { "x-forwarded-proto": "https" };

const mine = async () =>
  (await createSite({ mode: "paste", html: "<title>t</title><body>secret</body>" }, { anonOwnerId: ANON })).site;

const setVisibility = (slug: string, visibility: string, editPolicy = "owner") =>
  sharingPUT(new Request(`https://x/api/sites/${slug}/sharing`, {
    method: "PUT", headers: { ...ownerCreds, "content-type": "application/json" },
    body: JSON.stringify({ visibility, editPolicy }),
  }), params(slug));

const req = (path: string, headers: Record<string, string>) => new Request(`https://x${path}`, { headers });

describe("PUT /sharing accepts private now that it is enforced", () => {
  it("stores it", async () => {
    const site = await mine();
    expect((await setVisibility(site.slug, "private")).status).toBe(200);
    expect((await getSite(site.id))!.visibility).toBe("private");
  });

  // Restored together with `private`, as the note left in PR#27 asked: write implies read, so
  // "only I can see it, but anyone signed in may edit it" is a deadlock.
  it("still refuses private + editPolicy=login", async () => {
    const site = await mine();
    const res = await setVisibility(site.slug, "private", "login");
    expect(res.status).toBe(400);
    expect((await getSite(site.id))!.visibility).not.toBe("private");
  });
});

describe("a private site refuses a stranger at every content outlet", () => {
  it("GET /api/sites/:slug — which carries the full source", async () => {
    const site = await mine();
    await updateSiteSharing(site.id, "private", "owner");

    const res = await itemGET(req(`/api/sites/${site.slug}`, strangerCreds), params(site.slug));
    expect(res.status).toBe(404);                       // 404, not 403: do not confirm it exists
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("/api/preview — where the bytes actually come out", async () => {
    const site = await mine();
    await updateSiteSharing(site.id, "private", "owner");

    const res = await previewGET(
      req(`/api/preview/${site.slug}`, strangerCreds),
      { params: Promise.resolve({ slug: site.slug, path: undefined }) },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret");
  });

  // The one that makes the other two worth anything: fork copies the whole tree to the forker.
  it("POST /fork — otherwise the gate is theatre", async () => {
    const site = await mine();
    await updateSiteSharing(site.id, "private", "owner");

    const res = await forkPOST(new Request(`https://x/api/sites/${site.slug}/fork`, {
      method: "POST", headers: { ...strangerCreds, origin: "https://x" },
    }), params(site.slug));
    expect(res.status).toBe(404);
  });
});

describe("metadata is gated too — the leak that hid behind a clean <head>", () => {
  // generateMetadata runs independently of the page. notFound() swaps the <head> for the not-found
  // boundary's, so the head looks right — but this function's return value is still serialised into
  // the RSC flight payload, and a plain curl reads it. The first end-to-end check grepped only for
  // the body payload and passed while the title and description were being handed out three times
  // over; asserting on the serialised metadata as a whole is what catches that.
  const named = async (title: string) =>
    (await createSite(
      { mode: "paste", html: `<title>${title}</title><meta name="description" content="${title}-desc"><body>x</body>` },
      { anonOwnerId: ANON },
    )).site;

  it("tells a stranger nothing about a private site", async () => {
    const site = await named("裁员名单第三批");
    await setVisibility(site.slug, "private");

    const meta = await generateSiteMetadata({ params: Promise.resolve({ slug: site.slug }) });

    expect(meta.title).toBe("Site not found — artifact-site");
    expect(meta.description).toBeNull();                  // null, not absent — absent means inherit
    expect(JSON.stringify(meta)).not.toContain("裁员名单第三批");
    expect(JSON.stringify(meta)).not.toContain("-desc");
  });

  it("still describes a public site properly", async () => {
    const site = await named("公开的年报");
    const meta = await generateSiteMetadata({ params: Promise.resolve({ slug: site.slug }) });
    expect(meta.title).toContain("公开的年报");
  });
});

describe("the owner keeps full access to their own private site", () => {
  it("canReadSite says yes for the creating browser", async () => {
    const site = await mine();
    await updateSiteSharing(site.id, "private", "owner");
    const view = (await getSiteView(site.slug))!;

    expect(await canReadSite(req(`/s/${site.slug}`, ownerCreds), view.site)).toBe(true);
    expect(await canReadSite(req(`/s/${site.slug}`, strangerCreds), view.site)).toBe(false);
  });

  it("and can still read the source through the API", async () => {
    const site = await mine();
    await updateSiteSharing(site.id, "private", "owner");

    const res = await itemGET(req(`/api/sites/${site.slug}`, ownerCreds), params(site.slug));
    expect(res.status).toBe(200);
    expect((await res.json()).content).toContain("secret");
  });
});

// The hard compatibility requirement: nothing that works today may stop working. Every existing
// site is public or unlisted and has no shares, so the gate must be a no-op for them.
describe("public and unlisted are untouched", () => {
  it.each(["public", "unlisted"] as const)("%s stays readable by a stranger everywhere", async (visibility) => {
    const site = await mine();
    await updateSiteSharing(site.id, visibility, "owner");
    const view = (await getSiteView(site.slug))!;

    expect(await canReadSite(req(`/s/${site.slug}`, strangerCreds), view.site)).toBe(true);
    expect((await itemGET(req(`/api/sites/${site.slug}`, strangerCreds), params(site.slug))).status).toBe(403);
    expect((await previewGET(
      req(`/api/preview/${site.slug}`, strangerCreds),
      { params: Promise.resolve({ slug: site.slug, path: undefined }) },
    )).status).toBe(200);
  });

  it("a site nobody ever touched is readable — the default costs nothing", async () => {
    const site = await mine();                          // never had its sharing set at all
    const view = (await getSiteView(site.slug))!;
    expect(await canReadSite(req(`/s/${site.slug}`, strangerCreds), view.site)).toBe(true);
  });
});
