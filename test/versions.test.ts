// Version history + rollback — version listing and forward-only rollback. Covers the lib verbs, the
// GET /versions & POST /rollback routes, and the read-only ?v version preview.
import { afterEach, describe, expect, it } from "vitest";
import { committed } from "./helpers";
import { createSite, editSite, getSiteView, listVersions, rollbackTo } from "@/lib/sites";
import { servePreviewFile } from "@/lib/preview";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { GET as versionsGET } from "@/app/api/sites/[slug]/versions/route";
import { POST as rollbackPOST } from "@/app/api/sites/[slug]/rollback/route";
import { POST as sitesPOST } from "@/app/api/sites/route";
import { readVersionFile, testAudit} from "./helpers";
import { updateSiteSharing } from "@/lib/db";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("versions — history listing", () => {
  it("lists newest-first and flags exactly the current version, with source/fileCount/byteSize", async () => {
    const created = await createSite({ mode: "paste", html: "<title>V</title><body>v1</body>" });
    await wait(5);
    const edited = committed(await editSite(created.site.slug, { content: "<title>V</title><body>v2</body>" }, testAudit()));

    const list = (await listVersions(created.site.slug))!;
    expect(list.length).toBe(2);
    // newest first
    expect(list[0].id).toBe(edited!.version.id);
    expect(list[1].id).toBe(created.version.id);
    // exactly one current, and it is the served version
    expect(list[0].current).toBe(true);
    expect(list[1].current).toBe(false);
    expect(list.filter((v) => v.current).length).toBe(1);
    // shape the timeline UI reads
    expect(list[0].source).toBe("edit");
    expect(list[1].source).toBe("upload");
    expect(list[1].fileCount).toBeGreaterThan(0);
    expect(list[1].byteSize).toBeGreaterThan(0);
  });

  it("listVersions on an unknown slug returns null", async () => {
    expect((await listVersions("no-such-slug"))).toBeNull();
  });

  it("GET /api/sites/:slug/versions → { versions, currentVersionId }; unknown → 404", async () => {
    const created = await createSite({ mode: "paste", html: "<title>R</title><body>x</body>" });
    const res = await versionsGET(new Request("http://x/"), params(created.site.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentVersionId).toBe(created.version.id);
    expect(body.versions[0].current).toBe(true);

    const missing = await versionsGET(new Request("http://x/"), params("nope"));
    expect(missing.status).toBe(404);
  });
});

describe("rollback — forward-only restore, history preserved", () => {
  it("creates a NEW current version whose content equals the chosen old one; old versions stay listable", async () => {
    const created = await createSite({ mode: "paste", html: "<title>R</title><body>one</body>" });
    const v1 = created.version.id;
    await wait(5);
    await editSite(created.site.slug, { content: "<title>R</title><body>two</body>" }, testAudit());
    await wait(5);

    const rolled = await rollbackTo(created.site.slug, v1);
    expect(rolled).not.toBeNull();
    expect(rolled!.version.id).not.toBe(v1); // a NEW version, not the old row reused
    expect(rolled!.version.source).toBe("rollback");

    // The new current serves v1's content…
    const view = (await getSiteView(created.site.slug))!;
    expect(view.version.id).toBe(rolled!.version.id);
    expect(await readVersionFile(view.site.id, view.version.id, "index.html")).toContain("one");

    // …and history is NOT mutated: v1 + v2 + rollback = 3, all listable, v1's dir still on disk.
    const list = (await listVersions(created.site.slug))!;
    expect(list.length).toBe(3);
    expect(list.some((v) => v.id === v1)).toBe(true);
    expect(await readVersionFile(created.site.id, v1, "index.html")).toContain("one");
    expect(list.find((v) => v.current)!.id).toBe(rolled!.version.id);
  });

  it("rolling back to a foreign or unknown version returns null", async () => {
    const a = await createSite({ mode: "paste", html: "<title>A</title><body>a</body>" });
    const b = await createSite({ mode: "paste", html: "<title>B</title><body>b</body>" });
    expect(await rollbackTo(a.site.slug, b.version.id)).toBeNull(); // b's version isn't a's
    expect(await rollbackTo(a.site.slug, "ver_nope")).toBeNull();
    expect(await rollbackTo("no-such-slug", a.version.id)).toBeNull();
  });

  it("POST /api/sites/:slug/rollback { versionId } → new current version; bad version → 404", async () => {
    const created = await createSite({ mode: "paste", html: "<title>Rt</title><body>one</body>" });
    const v1 = created.version.id;
    await editSite(created.site.slug, { content: "<title>Rt</title><body>two</body>" }, testAudit());

    const req = (versionId: string) =>
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", "x-edit-token": created.site.editToken }, body: JSON.stringify({ versionId }) });
    const res = await rollbackPOST(req(v1), params(created.site.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versionId).toBeTruthy();
    expect(body.versionId).not.toBe(v1);

    const bad = await rollbackPOST(req("ver_missing"), params(created.site.slug));
    expect(bad.status).toBe(404);

    // Without the site's edit token, rollback is forbidden (per-site gate).
    const noToken = await rollbackPOST(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: v1 }) }),
      params(created.site.slug),
    );
    expect(noToken.status).toBe(403);
  });
});

describe("preview ?v — read-only version preview", () => {
  it("serves the pinned version; a non-matching value is refused", async () => {
    const created = await createSite({ mode: "paste", html: "<title>P</title><body>old</body>" });
    const oldId = created.version.id;
    await editSite(created.site.slug, { content: "<title>P</title><body>new</body>" }, testAudit());

    const current = await servePreviewFile(created.site.slug, undefined);
    expect(String(current.body)).toContain("new");

    const pinned = await servePreviewFile(created.site.slug, undefined, oldId);
    expect(pinned.status).toBe(200);
    expect(String(pinned.body)).toContain("old");

    // A plain cache-buster (or a foreign id) is ignored → current is served, not a 404.
    const fallback = await servePreviewFile(created.site.slug, undefined, "3");
    expect(fallback.status).toBe(404);
  });
});

// Rollback mints a new version by copying the chosen one's ENTIRE tree, so it amplifies disk and IO
// the same way fork's cp -r does — and create / fork / edit have all been behind the token bucket
// from the start. `manage` is required, so the reachable abuse is a site's own owner looping the
// call, not an open hole; this is the hardening that closes the gap, not a patch for a bypass.
describe("rollback — rate limiting (shares the budget with site creation / fork / edit)", () => {
  // The limiter is OFF under the test harness by default (config.rateLimit.enabled), so opt in
  // explicitly here and hand the environment back untouched — every other file assumes it is off.
  afterEach(() => {
    for (const k of ["ARTIFACT_RATE_LIMIT", "ARTIFACT_RATE_LIMIT_BURST", "ARTIFACT_RATE_LIMIT_PER_MIN"]) delete process.env[k];
    __resetRateLimitForTests();
  });

  function armLimiter(burst: string): void {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = burst;
    process.env.ARTIFACT_RATE_LIMIT_PER_MIN = "1"; // ~1 token/60s: nothing refills mid-test
    __resetRateLimitForTests();
  }

  /** A rollback request from one fixed client. x-real-ip pins the bucket key (see clientKey). */
  function rollReq(ip: string, editToken: string, versionId: string): Request {
    return new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip, "x-edit-token": editToken },
      body: JSON.stringify({ versionId }),
    });
  }

  it("429s once the burst is spent", async () => {
    const created = await createSite({ mode: "paste", html: "<title>RL</title><body>one</body>" });
    const v1 = created.version.id;
    await editSite(created.site.slug, { content: "<title>RL</title><body>two</body>" }, testAudit());
    const ip = "203.0.113.7";
    armLimiter("2");

    for (let i = 0; i < 2; i++) {
      expect((await rollbackPOST(rollReq(ip, created.site.editToken, v1), params(created.site.slug))).status).toBe(200);
    }
    const limited = await rollbackPOST(rollReq(ip, created.site.editToken, v1), params(created.site.slug));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBeTruthy();
  });

  // Not merely "rollback has A limiter" — it has THE limiter. A second bucket would have let a
  // flooder spend the create quota and still get a full rollback allowance on top of it.
  it("draws on the same bucket as POST /api/sites, not a private one", async () => {
    const created = await createSite({ mode: "paste", html: "<title>RL2</title><body>one</body>" });
    const v1 = created.version.id;
    await editSite(created.site.slug, { content: "<title>RL2</title><body>two</body>" }, testAudit());
    const ip = "203.0.113.9";
    armLimiter("1");

    // Spend the single token on the create route…
    const create = await sitesPOST(new Request("http://x/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ mode: "paste", html: "<title>RL2b</title><body>z</body>" }),
    }));
    expect(create.status).toBe(200);

    // …and rollback, from the same client, finds the bucket already empty.
    expect((await rollbackPOST(rollReq(ip, created.site.editToken, v1), params(created.site.slug))).status).toBe(429);
  });
});

// A private site's version history must not talk to strangers — the same site's /s/ and /api/preview
// both answer 404 and do not even reveal existence; yet this endpoint used to answer anyone, so a slug
// alone confirmed that the site exists, how many versions it has, how big, and when it was uploaded.
// Guarding one exit while leaving another open is no guard at all.
describe("versions — the read gate for private sites", () => {
  const anon = (slug: string) => new Request(`http://localhost/api/sites/${slug}/versions`);

  it("a public site is still readable by anyone", async () => {
    const created = await createSite({ mode: "paste", html: "<title>P</title><body>x</body>" });
    const res = await versionsGET(anon(created.site.slug), params(created.site.slug));
    expect(res.status).toBe(200);
    expect((await res.json() as { versions: unknown[] }).versions.length).toBe(1);
  });

  it("a private site answers strangers with 404 and leaks no version information at all", async () => {
    const created = await createSite({ mode: "paste", html: "<title>S</title><body>x</body>" });
    await updateSiteSharing(created.site.id, "private", "owner");

    const res = await versionsGET(anon(created.site.slug), params(created.site.slug));
    expect(res.status).toBe(404);
    const body = await res.text();
    // Not even siteId / versionId / byte counts may appear in the response
    expect(body).not.toContain(created.version.id);
    expect(body).not.toContain(created.site.id);
    expect(body).not.toContain("byteSize");
  });

  it("answers 404 rather than 403 — to someone who should not know, \"forbidden\" is itself information", async () => {
    const created = await createSite({ mode: "paste", html: "<title>S</title><body>x</body>" });
    await updateSiteSharing(created.site.id, "private", "owner");
    const res = await versionsGET(anon(created.site.slug), params(created.site.slug));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });
});
