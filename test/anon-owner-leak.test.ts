// P0 — the anonymous-ownership credential must never be echoed back in a public response.
//
// The full attack chain before the fix (reproducible end to end):
//   1. The victim creates a site anonymously (the product's main entry: drop a file, no login, no
//      token) and the server records the creating browser's cookie value in sites.anon_owner_id;
//   2. The attacker sends a **zero-credential** GET /api/sites/:slug — the old publicSite() only
//      stripped editToken and claimToken, so anonOwnerId came back in the clear with the site metadata;
//   3. The attacker puts that value into a __Host-ah_anon cookie and DELETEs the same slug. lib/anon
//      does no signature check on that cookie (reads it verbatim), and lib/authz decides anonymous
//      ownership with safeEqual(viewer.anonId, site.anonOwnerId) — so: owner, 200, site deleted.
//
// Since the vast majority of sites are unclaimed anonymous sites, this chain amounts to "anyone can
// delete/edit/roll back/change visibility on any site". The anonymous id is 24 random bytes and
// cannot be guessed; keeping it out of public responses breaks the chain, so this file pins exactly
// that: "not one byte of it appears in a public response" + "what a public response gives you
// cannot delete the site".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSiteBySlug } from "@/lib/db";
import { POST as sitesPOST } from "@/app/api/sites/route";
import { DELETE as itemDELETE, GET as itemGET } from "@/app/api/sites/[slug]/route";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const dirs: string[] = [];

const ENV_KEYS = [
  "ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP",
  "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET",
];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-anonleak-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  // Ownership enforcement must actually be on, otherwise authz takes the legacy edit-token branch
  // and the chain does not apply. config.enforceOwnership downgrades itself without OIDC, so all
  // three OIDC variables are supplied together.
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "c";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "s";
});

afterEach(async () => {
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

/** The victim: a browser with no login and no token drops a page. Returns the slug and the
 *  anonymous-owner id the server recorded. */
async function victimCreatesAnonymously(): Promise<{ slug: string; anonOwnerId: string }> {
  const res = await sitesPOST(new Request("https://x/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", origin: "https://x" },
    body: JSON.stringify({ mode: "paste", html: "<title>victim</title><body>hi</body>" }),
  }));
  expect(res.status).toBe(200);
  const { slug } = (await res.json()) as { slug: string };

  // Precondition: this really is an anonymous site that is unclaimed AND remembers its creating
  // browser. Without that, the assertions below prove nothing.
  const row = (await getSiteBySlug(slug))!;
  expect(row.ownerId).toBeNull();
  expect(row.anonOwnerId).toMatch(/^anon_/);
  return { slug, anonOwnerId: row.anonOwnerId! };
}

/** The attacker's public read: no cookie, no token, no session. */
function publicRead(slug: string): Request {
  return new Request(`https://x/api/sites/${slug}`, { headers: { "x-forwarded-proto": "https" } });
}

/** Delete the site as a given anonymous browser. __Host- prefixed cookies are only read over https,
 *  so both the URL and x-forwarded-proto must be https; writes also carry a same-origin origin. */
function deleteAsBrowser(slug: string, anonId: string): Request {
  return new Request(`https://x/api/sites/${slug}`, {
    method: "DELETE",
    headers: {
      "x-forwarded-proto": "https",
      origin: "https://x",
      cookie: `__Host-ah_anon=${encodeURIComponent(anonId)}`,
    },
  });
}

/** Recursively collect every string that looks like an anonymous id anywhere in a JSON value.
 *  Field names are ignored — a renamed key or a nested object is caught just the same, so the
 *  test guards against "the value leaks" rather than "one particular field name". */
function anonIdsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("anon_")) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) anonIdsIn(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) anonIdsIn(item, found);
  }
  return found;
}

describe("the anonymous-owner id never appears in a public response", () => {
  it("a public GET /api/sites/:slug response body does not contain the anonOwnerId value", async () => {
    const { slug, anonOwnerId } = await victimCreatesAnonymously();

    const res = await itemGET(publicRead(slug), params(slug));
    expect(res.status).toBe(200);
    const raw = await res.text();

    // The strictest check: the value does not occur anywhere in the raw response text.
    expect(raw).not.toContain(anonOwnerId);

    const body = JSON.parse(raw) as { site: Record<string, unknown> };
    expect(body.site).not.toHaveProperty("anonOwnerId");
    expect(anonIdsIn(body)).toEqual([]);
    // The other two per-site secrets must not leak either (the original publicSite existed for
    // them; pin that here so it does not regress).
    expect(body.site).not.toHaveProperty("editToken");
    expect(body.site).not.toHaveProperty("claimToken");
    // The projection must not strip too much: the metadata a public read is entitled to stays.
    expect(body.site.slug).toBe(slug);
    expect(body.site.currentVersionId).toBeTruthy();
  });

  it("forging __Host-ah_anon from what the public response exposes and DELETEing is no longer a 200", async () => {
    const { slug } = await victimCreatesAnonymously();

    // The attacker's entire starting material is this zero-credential public response.
    const body = (await (await itemGET(publicRead(slug), params(slug))).json()) as
      { site?: Record<string, unknown> };
    const leaked = typeof body.site?.anonOwnerId === "string" ? body.site.anonOwnerId : "";
    // After the fix there is genuinely nothing to steal here; the request is still sent so the 403
    // comes from authz rejecting it, not from the test returning early.
    const stolen = anonIdsIn(body)[0] ?? (leaked || "anon_nothing_left_to_steal");

    const res = await itemDELETE(deleteAsBrowser(slug, stolen), params(slug));
    expect(res.status).toBe(403);

    // And the site is still there — the 403 is not "deleted, then errored".
    const after = (await getSiteBySlug(slug))!;
    expect(after.deletedAt).toBeNull();
  });

  // The counter-check. Plugging the leak must not lock the anonymous main entry: the browser that
  // created the site is still its owner.
  it("the creator's own browser cookie can still delete its own site", async () => {
    const { slug, anonOwnerId } = await victimCreatesAnonymously();

    const res = await itemDELETE(deleteAsBrowser(slug, anonOwnerId), params(slug));
    expect(res.status).toBe(200);
    expect((await getSiteBySlug(slug))!.deletedAt).not.toBeNull();
  });
});
