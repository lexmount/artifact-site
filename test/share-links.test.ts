import * as database from "@/lib/db";
import * as commits from "@/lib/authorized-commit";
import { AuthError } from "@/lib/auth";
// Share links — the owner's management API and the reader's gate, exercised end to end: every token
// here was minted by POST /shares, and every admission decision comes back through resolveShareAccess
// or the unlock route. Nothing hand-builds a share row, because the bugs worth catching live exactly
// in the wiring between the two.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDbForTests, createShare, getShare, listShareGrants, recordShareView, updateSharePolicy, updateSiteSharing, upsertUser,
} from "@/lib/db";
import { createSite, getSiteView } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { canReadSite, hashPasscode, hashToken, resolveShareAccess } from "@/lib/share";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import type { Site } from "@/lib/types";
import { GET as sharesGET, POST as sharesPOST } from "@/app/api/sites/[slug]/shares/route";
import { DELETE as shareDELETE, PATCH as sharePATCH } from "@/app/api/sites/[slug]/shares/[shareId]/route";
import { DELETE as grantDELETE, POST as grantPOST } from "@/app/api/sites/[slug]/shares/[shareId]/grants/route";
import { GET as viewsGET } from "@/app/api/sites/[slug]/views/route";
import { GET as searchGET } from "@/app/api/users/search/route";
import { POST as unlockPOST } from "@/app/api/shares/[token]/unlock/route";
import { POST as forkPOST } from "@/app/api/sites/[slug]/fork/route";

const ORIGIN = "https://artifacts.example.net";
const dirs: string[] = [];
let seq = 0;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-share-links-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = ORIGIN;
  // Ownership must be enforced for `owner` to mean anything — and enforcement is itself ignored
  // without a configured IdP (see config.enforceOwnership), so the three OIDC vars are load-bearing.
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp.example/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "cid";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "secret";
  __resetRateLimitForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of [
    "ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_OIDC_ISSUER",
    "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET",
    "ARTIFACT_RATE_LIMIT", "ARTIFACT_RATE_LIMIT_BURST", "ARTIFACT_RATE_LIMIT_PER_MIN",
  ]) delete process.env[key];
  __resetRateLimitForTests();
});

// --- harness ------------------------------------------------------------------

interface Account { id: string; cookie: string; email: string }

/** An account plus the one cookie its browser would carry. */
async function signIn(displayName: string, email?: string): Promise<Account> {
  const address = email ?? `${displayName.toLowerCase()}${++seq}@corp.example`;
  const user = await upsertUser({
    authProvider: "test", providerSubject: `sub_${displayName}_${seq}`,
    email: address, emailVerified: true, displayName,
  });
  const { cookie } = await mintSession(new Request(`${ORIGIN}/`, { headers: { "x-forwarded-proto": "https" } }), user.id);
  return { id: user.id, cookie: cookie.split(";")[0], email: address };
}

async function siteOwnedBy(owner: Account, html = "<html><head><title>季度复盘</title></head><body>x</body></html>"): Promise<Site> {
  return (await createSite({ mode: "paste", html }, { ownerId: owner.id })).site;
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

/** A cookie-authenticated write, as the panel would send it (Origin is checked exactly). */
function write(path: string, cookie: string, method: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { cookie, origin: ORIGIN, "x-forwarded-proto": "https", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function read(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { "x-forwarded-proto": "https", ...(cookie ? { cookie } : {}) },
  });
}

/** What a reader's browser looks like: maybe a session, maybe a passcode grant, maybe nothing. */
function reader(...cookies: string[]): Request {
  const jar = cookies.filter(Boolean).join("; ");
  return new Request(`${ORIGIN}/v/t`, {
    headers: { "x-forwarded-proto": "https", ...(jar ? { cookie: jar } : {}) },
  });
}

interface Minted { id: string; token: string; url: string; passcode?: string }

async function mint(site: Site, owner: Account, body: Record<string, unknown> = {}): Promise<Minted> {
  const res = await sharesPOST(write(`/api/sites/${site.slug}/shares`, owner.cookie, "POST", body), params({ slug: site.slug }));
  expect(res.status).toBe(201);
  const data = await res.json();
  return { id: data.share.id, token: data.token, url: data.url, passcode: data.passcode };
}

const unlockJson = (token: string, passcode: string, ip = "10.0.0.1") =>
  unlockPOST(new Request(`${ORIGIN}/api/shares/${token}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-real-ip": ip },
    body: JSON.stringify({ passcode }),
  }), params({ token }));

const unlockForm = (token: string, passcode: string, ip = "10.0.0.1") =>
  unlockPOST(new Request(`${ORIGIN}/api/shares/${token}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https", "x-real-ip": ip },
    body: new URLSearchParams({ passcode }).toString(),
  }), params({ token }));

/** The `ah_pass_<id>=…` pair out of a Set-Cookie, as the browser would send it back. */
function cookiePair(res: Response): string {
  const header = res.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";")[0];
}

// --- minting ------------------------------------------------------------------

describe("POST /shares", () => {
  it("keeps the same share URL available to managers after reload", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { label: "给客户的" });

    expect(share.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(share.url).toBe(`${ORIGIN}/v/${share.token}`);

    // A fresh management request can copy the original address again.
    const listed = await (await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({ slug: site.slug }))).json();
    expect(listed.shares[0].url).toBe(share.url);
    const stranger = await signIn("Stranger");
    expect((await sharesGET(read(`/api/sites/${site.slug}/shares`, stranger.cookie), params({ slug: site.slug }))).status).toBe(403);
    expect(listed.shares[0]).toMatchObject({ id: share.id, label: "给客户的", status: "live", live: true });
    await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", { policy: "public", expiresInDays: 7 }), params({ slug: site.slug, shareId: share.id }));
    const refreshed = await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({ slug: site.slug }));
    expect(refreshed.headers.get("cache-control")).toBe("private, no-store");
    expect((await refreshed.json()).shares[0].url).toBe(share.url);
    expect((await resolveShareAccess(reader(), share.token)).ok).toBe(true);

  });

  it("keeps historical hash-only links valid without inventing a recoverable URL", async () => {
    const owner = await signIn("LegacyOwner");
    const site = await siteOwnedBy(owner);
    await createShare({ id: "legacy-share", siteId: site.id, tokenHash: hashToken("legacy-token"),
      policy: "public", passcodeHash: null, label: null, createdBy: owner.id, createdAnonId: null, expiresAt: null });
    const listed = await (await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({ slug: site.slug }))).json();
    expect(listed.shares[0].url).toBeNull();
    expect((await resolveShareAccess(reader(), "legacy-token")).ok).toBe(true);
  });

  it("defaults to the login policy rather than to the open behaviour it replaces", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner);

    expect((await getShare(share.id))!.policy).toBe("login");
  });

  it("takes 7 / 30 / 90 days, treats absence as never expiring, and refuses anything else", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);

    const forever = await getShare((await mint(site, owner)).id);
    expect(forever!.expiresAt).toBeNull();

    const week = await getShare((await mint(site, owner, { expiresInDays: 7 })).id);
    expect(week!.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(week!.expiresAt).toBeLessThan(Date.now() + 8 * 86_400_000);

    const res = await sharesPOST(write(`/api/sites/${site.slug}/shares`, owner.cookie, "POST", { expiresInDays: 3650 }), params({ slug: site.slug }));
    expect(res.status).toBe(400);
  });

  it("generates a passcode when none is given, and echoes it exactly once", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });

    expect(share.passcode).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect((await getShare(share.id))!.hasPasscode).toBe(true);
    // A code the OWNER chose is not echoed back — they already have it.
    const chosen = await mint(site, owner, { policy: "passcode", passcode: "hunter2" });
    expect(chosen.passcode).toBeUndefined();
    expect((await resolveShareAccess(reader(), chosen.token, { passcodeAttempt: "HUNTER2" })).ok).toBe(true);
  });

  it("refuses a passcode on a policy that would never check it", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const res = await sharesPOST(write(`/api/sites/${site.slug}/shares`, owner.cookie, "POST", { policy: "login", passcode: "abcd" }), params({ slug: site.slug }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("passcode");
  });

  it("is owner-only, and rejects a cross-site post outright", async () => {
    const owner = await signIn("Owner");
    const stranger = await signIn("Stranger");
    const site = await siteOwnedBy(owner);

    expect((await sharesPOST(write(`/api/sites/${site.slug}/shares`, stranger.cookie, "POST", {}), params({ slug: site.slug }))).status).toBe(403);
    expect((await sharesGET(read(`/api/sites/${site.slug}/shares`, stranger.cookie), params({ slug: site.slug }))).status).toBe(403);

    const noOrigin = new Request(`${ORIGIN}/api/sites/${site.slug}/shares`, {
      method: "POST", headers: { cookie: owner.cookie, "x-forwarded-proto": "https", "content-type": "application/json" }, body: "{}",
    });
    expect((await sharesPOST(noOrigin, params({ slug: site.slug }))).status).toBe(401);
  });
});

// --- the four policies ---------------------------------------------------------

describe("whom each policy admits and whom it refuses", () => {
  it("public: anyone can open it, without so much as a cookie", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const { token } = await mint(site, owner, { policy: "public" });

    expect((await resolveShareAccess(reader(), token)).ok).toBe(true);
  });

  it("login: anonymous gets needsLogin, any signed-in user is admitted", async () => {
    const owner = await signIn("Owner");
    const passerby = await signIn("Passerby");
    const site = await siteOwnedBy(owner);
    const { token } = await mint(site, owner, { policy: "login" });

    expect(await resolveShareAccess(reader(), token)).toMatchObject({ ok: false, reason: "needsLogin" });
    expect((await resolveShareAccess(reader(passerby.cookie), token)).ok).toBe(true);
  });

  it("people: a signed-in user not on the list gets notInvited; adding them admits them", async () => {
    const owner = await signIn("Owner");
    const guest = await signIn("Guest");
    const other = await signIn("Other");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "people" });

    expect(await resolveShareAccess(reader(), share.token)).toMatchObject({ ok: false, reason: "needsLogin" });
    expect(await resolveShareAccess(reader(guest.cookie), share.token)).toMatchObject({ ok: false, reason: "notInvited" });

    const added = await grantPOST(
      write(`/api/sites/${site.slug}/shares/${share.id}/grants`, owner.cookie, "POST", { email: guest.email }),
      params({ slug: site.slug, shareId: share.id }),
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ status: "linked", grant: { userId: guest.id } });

    expect((await resolveShareAccess(reader(guest.cookie), share.token)).ok).toBe(true);
    // Adding one person must not add everybody.
    expect(await resolveShareAccess(reader(other.cookie), share.token)).toMatchObject({ ok: false, reason: "notInvited" });

    // Takes effect immediately on removal — that is the entire point of "revoke at any time".
    await grantDELETE(
      write(`/api/sites/${site.slug}/shares/${share.id}/grants?userId=${guest.id}`, owner.cookie, "DELETE"),
      params({ slug: site.slug, shareId: share.id }),
    );
    expect(await resolveShareAccess(reader(guest.cookie), share.token)).toMatchObject({ ok: false, reason: "notInvited" });
  });

  it("passcode: no code → needsPasscode, wrong code → wrongPasscode, correct code admits case-insensitively", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });
    const code = share.passcode!;

    expect(await resolveShareAccess(reader(), share.token)).toMatchObject({ ok: false, reason: "needsPasscode" });
    expect(await resolveShareAccess(reader(), share.token, { passcodeAttempt: "ZZZZZZ" })).toMatchObject({ ok: false, reason: "wrongPasscode" });
    expect((await resolveShareAccess(reader(), share.token, { passcodeAttempt: code.toLowerCase() })).ok).toBe(true);
  });

  it("the cookie unlock plants skips the passcode from then on, and changing the code voids it on the spot", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });

    const res = await unlockJson(share.token, share.passcode!);
    expect(res.status).toBe(200);
    const grant = cookiePair(res);
    expect((await resolveShareAccess(reader(grant), share.token)).ok).toBe(true);

    // The cookie's signature is derived from the passcode hash, so re-keying the link revokes every
    // outstanding grant with no second table to sweep.
    const patched = await sharePATCH(
      write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", { policy: "passcode", passcode: "brandnew" }),
      params({ slug: site.slug, shareId: share.id }),
    );
    // PATCH works off the full ShareRow, hashes and all. The response projection is an ALLOWLIST for
    // exactly this reason — a spread would have shipped both secrets to the panel.
    const body = JSON.stringify(await patched.json());
    expect(body).not.toContain(hashToken(share.token));
    expect(body).not.toContain(hashPasscode("brandnew"));
    expect(body).toContain('"hasPasscode":true');
    expect(await resolveShareAccess(reader(grant), share.token)).toMatchObject({ ok: false, reason: "needsPasscode" });
    expect((await resolveShareAccess(reader(), share.token, { passcodeAttempt: "brandnew" })).ok).toBe(true);
  });

  it("private site: a stranger cannot read it, a reader holding the passcode cookie can — the gate recognises the same thing", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });
    await updateSiteSharing(site.id, "private", "owner");
    const priv = { ...site, visibility: "private" as const };

    expect(await canReadSite(reader(), priv, null)).toBe(false);
    const grant = cookiePair(await unlockJson(share.token, share.passcode!));
    expect(await canReadSite(reader(grant), priv, null)).toBe(false);
    const scoped = reader(grant); scoped.headers.set("x-artifact-share", share.token);
    expect(await canReadSite(scoped, priv, null)).toBe(true);
  });
});

// --- death --------------------------------------------------------------------

describe("revocation and expiry", () => {
  it("both answer notFound — the reader cannot tell them apart, and must not be able to", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);

    const revoked = await mint(site, owner, { policy: "public" });
    await shareDELETE(write(`/api/sites/${site.slug}/shares/${revoked.id}`, owner.cookie, "DELETE"), params({ slug: site.slug, shareId: revoked.id }));

    const expired = await mint(site, owner, { policy: "public" });
    await updateSharePolicy(expired.id, "public", null, Date.now() - 1000); // wind the expiry straight into the past

    const never = "definitely-not-a-real-token";

    for (const token of [revoked.token, expired.token, never]) {
      expect(await resolveShareAccess(reader(), token)).toMatchObject({ ok: false, reason: "notFound" });
    }
    // And the share is not returned either: no hint that it ever existed may leak out.
    expect(await resolveShareAccess(reader(), revoked.token)).not.toHaveProperty("share");
  });

  it("revocation keeps the row rather than deleting it; the owner still sees 'revoked', not 'expired'", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "public" });
    await shareDELETE(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "DELETE"), params({ slug: site.slug, shareId: share.id }));

    const { shares } = await (await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({ slug: site.slug }))).json();
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ id: share.id, live: false, status: "revoked" });
    expect(shares[0].revokedAt).toBeGreaterThan(0);
  });

  it("no more edits after revocation — revocation must be final", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "login" });
    await shareDELETE(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "DELETE"), params({ slug: site.slug, shareId: share.id }));

    const res = await sharePATCH(
      write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", { policy: "public" }),
      params({ slug: site.slug, shareId: share.id }),
    );
    expect(res.status).toBe(409);
    expect((await getShare(share.id))!.policy).toBe("login"); // nothing was written
  });

  it("someone else's shareId under my slug → 404, not 200", async () => {
    const alice = await signIn("Alice");
    const mallory = await signIn("Mallory");
    const hers = await siteOwnedBy(alice);
    const his = await siteOwnedBy(mallory);
    const target = await mint(hers, alice, { policy: "people" });

    for (const res of [
      await sharePATCH(write(`/api/sites/${his.slug}/shares/${target.id}`, mallory.cookie, "PATCH", { policy: "public" }), params({ slug: his.slug, shareId: target.id })),
      await shareDELETE(write(`/api/sites/${his.slug}/shares/${target.id}`, mallory.cookie, "DELETE"), params({ slug: his.slug, shareId: target.id })),
      await grantPOST(write(`/api/sites/${his.slug}/shares/${target.id}/grants`, mallory.cookie, "POST", { userId: mallory.id }), params({ slug: his.slug, shareId: target.id })),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await getShare(target.id))!.policy).toBe("people");
    expect(await listShareGrants(target.id)).toHaveLength(0);
  });
});

// --- passcode brute force ------------------------------------------------------

describe("passcode rate limiting: counted per share, not per IP", () => {
  beforeEach(() => {
    process.env.ARTIFACT_RATE_LIMIT = "on";
    process.env.ARTIFACT_RATE_LIMIT_BURST = "3";
    process.env.ARTIFACT_RATE_LIMIT_PER_MIN = "1"; // slow enough that it barely refills during the test
    __resetRateLimitForTests();
  });

  it("three guesses on the same link lock it, and it stays locked when guessing continues from another IP", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });

    for (let i = 0; i < 3; i++) expect((await unlockJson(share.token, "WRONG1", "1.1.1.1")).status).toBe(403);
    expect((await unlockJson(share.token, "WRONG1", "1.1.1.1")).status).toBe(429);
    // A distributed brute force gets no fresh budget: the budget belongs to the secret, not to the source address.
    expect((await unlockJson(share.token, "WRONG1", "9.9.9.9")).status).toBe(429);
  });

  it("[KEY] one person hammering one link does not stop them (or their office-mates) from opening other links", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const hammered = await mint(site, owner, { policy: "passcode" });
    const innocent = await mint(site, owner, { policy: "passcode" });

    for (let i = 0; i < 4; i++) await unlockJson(hammered.token, "WRONG1", "203.0.113.7");
    expect((await unlockJson(hammered.token, "WRONG1", "203.0.113.7")).status).toBe(429);

    // Same egress IP — counted per IP this one would be a 429, which is exactly what must be
    // avoided: one person's brute force must not lock out everyone behind the same NAT.
    const res = await unlockJson(innocent.token, innocent.passcode!, "203.0.113.7");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("ah_pass_");
  });

  it("[SECOND DIMENSION] one IP sweeping many different links is still stopped", async () => {
    // Counting per share is right, but it deliberately ignores who is asking — so someone already
    // holding a pile of links gets a fresh budget with every link they switch to. That is the gap.
    // The IP-dimension bucket is ten times the burst (here 1×10=10): it never squeezes office-mates
    // typing codes normally, yet it stops this kind of sweep.
    process.env.ARTIFACT_RATE_LIMIT_BURST = "1"; // per-share capacity 1, IP dimension 1×10=10
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const links = [];
    for (let i = 0; i < 12; i++) links.push(await mint(site, owner, { policy: "passcode" }));

    const SCANNER = "198.51.100.9";
    // Each link is tried only once — the per-share bucket (capacity 1) never fills, so whatever blocks can only be the IP dimension.
    for (let i = 0; i < 10; i++) {
      expect((await unlockJson(links[i].token, "WRONG1", SCANNER)).status).toBe(403);
    }
    expect((await unlockJson(links[10].token, "WRONG1", SCANNER)).status).toBe(429);

    // A different IP and an untouched link — budget remains. Proves that the 429 above was aimed at
    // that address, not at everyone. (links[10] cannot be reused: the per-share bucket deducts
    // before blocking, so its one slot is already spent.)
    expect((await unlockJson(links[11].token, "WRONG1", "198.51.100.10")).status).toBe(403);
  });

  it("a rate-limited form submission returns to the passcode page with the reason, instead of a bare 429 page", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });

    for (let i = 0; i < 3; i++) await unlockForm(share.token, "WRONG1", "198.51.100.4");
    const res = await unlockForm(share.token, "WRONG1", "198.51.100.4");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/v/${share.token}?e=slow`);
  });

  it("a correct code is a 303 back to /v/<token> with the cookie; a wrong code returns to the same page with e=wrong", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "passcode" });

    const wrong = await unlockForm(share.token, "NOPE12", "198.51.100.9");
    expect(wrong.headers.get("location")).toBe(`${ORIGIN}/v/${share.token}?e=wrong`);

    const ok = await unlockForm(share.token, share.passcode!, "198.51.100.9");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/v/${share.token}`);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

// --- inviting someone who has never been here ----------------------------------

describe("an unregistered email address can be added too", () => {
  it("adding succeeds (not 404), and once they sign in with that email they get in immediately", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "people" });
    const address = "newcomer@partner.example";

    const res = await grantPOST(
      write(`/api/sites/${site.slug}/shares/${share.id}/grants`, owner.cookie, "POST", { email: address }),
      params({ slug: site.slug, shareId: share.id }),
    );
    // /collaborators answers 404 here. This route must not — that refusal is what makes "share with
    // a colleague who has not registered yet" impossible, and it is the whole reason this endpoint
    // exists separately.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "pending", code: "pending_email" });
    expect(body.grant).toMatchObject({ userId: null, email: address, pending: true });

    // The owner's panel can see it is still waiting on a login.
    const { shares } = await (await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({ slug: site.slug }))).json();
    expect(shares[0].grants).toEqual([expect.objectContaining({ email: address, pending: true })]);

    // …and then they sign in.
    const newcomer = await signIn("Newcomer", address);
    expect((await resolveShareAccess(reader(newcomer.cookie), share.token)).ok).toBe(true);
  });

  it("the same email in different casing is the same person, not a second row", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "people" });

    for (const typed of ["Partner@Example.com", "partner@example.com", "PARTNER@EXAMPLE.COM"]) {
      await grantPOST(write(`/api/sites/${site.slug}/shares/${share.id}/grants`, owner.cookie, "POST", { email: typed }), params({ slug: site.slug, shareId: share.id }));
    }
    expect(await listShareGrants(share.id)).toHaveLength(1);

    // Any spelling can delete it.
    await grantDELETE(
      write(`/api/sites/${site.slug}/shares/${share.id}/grants?email=${encodeURIComponent("PARTNER@example.com")}`, owner.cookie, "DELETE"),
      params({ slug: site.slug, shareId: share.id }),
    );
    expect(await listShareGrants(share.id)).toHaveLength(0);
  });

  it("a malformed email is rejected outright, leaving no junk row on the list that could never take effect", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "people" });

    const res = await grantPOST(write(`/api/sites/${site.slug}/shares/${share.id}/grants`, owner.cookie, "POST", { email: "not-an-address" }), params({ slug: site.slug, shareId: share.id }));
    expect(res.status).toBe(400);
    expect(await listShareGrants(share.id)).toHaveLength(0);
  });
});

// --- people picker -------------------------------------------------------------

describe("GET /api/users/search", () => {
  const search = (q: string, cookie?: string) =>
    searchGET(read(`/api/users/search?q=${encodeURIComponent(q)}`, cookie));

  it("requires sign-in and at least two characters", async () => {
    const me = await signIn("Zhangsan");
    expect((await search("zh")).status).toBe(401);
    expect((await search("z", me.cookie)).status).toBe(400);
  });

  it("matches on display-name or verified-email prefix, and returns only three fields", async () => {
    const me = await signIn("Owner");
    const target = await signIn("Zhangsan", "zhangsan@corp.example");

    const byName = await (await search("zhang", me.cookie)).json();
    expect(byName.users).toEqual([{ id: target.id, displayName: "Zhangsan", email: "zhangsan@corp.example" }]);

    const byEmail = await (await search("zhangsan@", me.cookie)).json();
    expect(byEmail.users.map((u: { id: string }) => u.id)).toContain(target.id);
  });

  it("wildcards are literal, not 'give me everyone'", async () => {
    const me = await signIn("Owner");
    await signIn("Zhangsan");
    await signIn("Lisi");

    expect((await (await search("%", me.cookie)).json()).error).toBeTruthy(); // one character, stopped by the length check first
    expect((await (await search("%%", me.cookie)).json()).users).toEqual([]);
    expect((await (await search("_h", me.cookie)).json()).users).toEqual([]);
  });

  it("an unverified email neither matches nor is echoed — otherwise anyone could appear in this list under a colleague's address", async () => {
    const me = await signIn("Owner");
    const spoofer = await upsertUser({
      authProvider: "test", providerSubject: "sub_spoofer",
      email: "ceo@corp.example", emailVerified: false, displayName: "Spoofer",
    });

    expect((await (await search("ceo@", me.cookie)).json()).users).toEqual([]);
    const byName = await (await search("spoof", me.cookie)).json();
    expect(byName.users).toEqual([{ id: spoofer.id, displayName: "Spoofer", email: null }]);
  });
});

// --- the view log --------------------------------------------------------------

describe("GET /views", () => {
  it("the owner can see it, nobody else can", async () => {
    const owner = await signIn("Owner");
    const stranger = await signIn("Stranger");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "public" });
    await recordShareView({
      shareId: share.id, siteId: site.id, userId: stranger.id, anonId: null,
      ip: "203.0.113.1", userAgent: "probe", viewedAt: Date.now(),
    });

    const mine = await viewsGET(read(`/api/sites/${site.slug}/views`, owner.cookie), params({ slug: site.slug }));
    expect(mine.status).toBe(200);
    const { views } = await mine.json();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ shareId: share.id, userId: stranger.id, displayName: "Stranger" });

    expect((await viewsGET(read(`/api/sites/${site.slug}/views`, stranger.cookie), params({ slug: site.slug }))).status).toBe(403);
    expect((await viewsGET(read(`/api/sites/${site.slug}/views`), params({ slug: site.slug }))).status).toBe(403);
  });
});

describe("fork does not ride along on read permission", () => {
  // "Can view" and "can take a permanent copy, change its ownership, and make it public at will"
  // are two different things. A login-policy share grants the former and must not hand out the
  // latter on the side — otherwise any signed-in user could walk off with a private site's entire
  // file tree.
  it("a login-policy share lets people see it, but fork is refused", async () => {
    const owner = await signIn("Owner");
    const stranger = await signIn("Stranger");
    const site = await siteOwnedBy(owner);
    await updateSiteSharing(site.id, "private", "owner");
    const share = await mint(site, owner, { policy: "login" });

    const asStranger = reader(stranger.cookie);
    asStranger.headers.set("x-artifact-share", share.token);
    expect(await canReadSite(asStranger, (await getSiteView(site.slug))!.site)).toBe(true);

    const res = await forkPOST(write(`/api/sites/${site.slug}/fork`, stranger.cookie, "POST"), params({ slug: site.slug }));
    expect(res.status).toBe(404);
  });

  it("the owner forking their own private site works as before", async () => {
    const owner = await signIn("Owner");
    const site = await siteOwnedBy(owner);
    await updateSiteSharing(site.id, "private", "owner");

    const res = await forkPOST(write(`/api/sites/${site.slug}/fork`, owner.cookie, "POST"), params({ slug: site.slug }));
    expect(res.status).toBe(200);
  });

  it("view-only public readers cannot copy source through fork", async () => {
    const owner = await signIn("Owner");
    const stranger = await signIn("Stranger");
    const site = await siteOwnedBy(owner);
    // Set explicitly. This file's ARTIFACT_PUBLIC_URL is a non-intranet address, so a new site
    // defaults to private — relying on the default for a "public site" is luck, and this case
    // tests precisely "unaffected when public".
    await updateSiteSharing(site.id, "public", "owner");

    const res = await forkPOST(write(`/api/sites/${site.slug}/fork`, stranger.cookie, "POST"), params({ slug: site.slug }));
    expect(res.status).toBe(404);
  });
});


describe("saving audience and people together", () => {
  it("applies the new policy and guest list in one save", async () => {
    const owner = await signIn("DraftOwner"), guest = await signIn("DraftGuest");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "public" });
    const res = await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", {
      policy: "people", grants: [{ userId: guest.id }],
    }), params({ slug: site.slug, shareId: share.id }));
    expect(res.status).toBe(200);
    expect((await resolveShareAccess(reader(guest.cookie), share.token)).ok).toBe(true);
    expect((await listShareGrants(share.id)).map(g => g.userId)).toEqual([guest.id]);
  });
  it("removes guests explicitly and preserves unchanged grant timestamps", async () => {
    const owner = await signIn("ListOwner"), guest = await signIn("ListGuest");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "people" });
    const save = (grants: unknown[]) => sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", { grants }), params({ slug: site.slug, shareId: share.id }));
    expect((await save([{ userId: guest.id }, { email: "pending@example.net" }])).status).toBe(200);
    const grantedAt = (await listShareGrants(share.id)).find(g => g.userId === guest.id)!.grantedAt;
    expect((await save([{ userId: guest.id }])).status).toBe(200);
    expect(await listShareGrants(share.id)).toMatchObject([{ userId: guest.id, grantedAt }]);
    expect((await save([])).status).toBe(200);
    expect(await listShareGrants(share.id)).toEqual([]);
    expect((await resolveShareAccess(reader(guest.cookie), share.token)).ok).toBe(false);
  });

  it("rejects an invalid list without changing the existing audience", async () => {
    const owner = await signIn("InvalidDraftOwner");
    const site = await siteOwnedBy(owner);
    const share = await mint(site, owner, { policy: "public" });
    const res = await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", {
      policy: "people", grants: [{ email: "not-an-email" }],
    }), params({ slug: site.slug, shareId: share.id }));
    expect(res.status).toBe(400);
    expect((await getShare(share.id))?.policy).toBe("public");
  });
});

it("retains publication provenance and renames without changing the shared address or access", async () => {
  const owner = await signIn("Publisher");
  const site = await siteOwnedBy(owner);
  const share = await mint(site, owner, { source: "publish", policy: "login" });
  const before = await getShare(share.id);
  const response = await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", { label: "Weekly review" }), params({slug: site.slug, shareId: share.id}));
  expect(response.status).toBe(200);
  expect((await response.json()).share).toMatchObject({label: "Weekly review", source: "publish"});
  const after = await getShare(share.id);
  expect(after).toMatchObject({token: before!.token, tokenHash: before!.tokenHash, policy: before!.policy, expiresAt: before!.expiresAt, source: "publish"});
  const listed = await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie), params({slug: site.slug}));
  expect((await listed.json()).shares[0]).toMatchObject({label: "Weekly review", source: "publish", url: share.url});
  const outsider = await signIn("Outsider");
  const denied = await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, outsider.cookie, "PATCH", {label:"Unauthorized"}), params({slug:site.slug, shareId:share.id}));
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect((await getShare(share.id))!.label).toBe("Weekly review");
});


it("does not disclose guest existence when the transaction authorization recheck fails", async () => {
  const owner = await signIn("RecheckOwner"), guest = await signIn("RecheckGuest");
  const site = await siteOwnedBy(owner);
  const share = await mint(site, owner, {policy: "people"});
  vi.spyOn(commits, "withPermissionCommit").mockRejectedValue(new AuthError("Credential revoked"));
  for (const userId of [guest.id, "nonexistent-user"]) {
    const res = await sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`, owner.cookie, "PATCH", {grants:[{userId}]}), params({slug:site.slug,shareId:share.id}));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({error: "Credential revoked"});
  }
});

it("preserves pending-email grant audit metadata after the recipient signs in", async () => {
  const owner = await signIn("PendingOwner");
  const site = await siteOwnedBy(owner);
  const share = await mint(site, owner, {policy:"people"});
  const save = (grants: unknown[]) => sharePATCH(write(`/api/sites/${site.slug}/shares/${share.id}`,owner.cookie,"PATCH",{grants}),params({slug:site.slug,shareId:share.id}));
  expect((await save([{email:"later@corp.example"}])).status).toBe(200);
  const before = await listShareGrants(share.id);
  const guest = await signIn("Later", "later@corp.example");
  expect((await save([{userId:guest.id}])).status).toBe(200);
  expect(await listShareGrants(share.id)).toEqual(before);
  expect((await resolveShareAccess(reader(guest.cookie), share.token)).ok).toBe(true);
  expect((await save([{email:"later@corp.example"}])).status).toBe(200);
  expect(await listShareGrants(share.id)).toEqual(before);
});


it("lists recoverable addresses without loading each share again or leaking storage secrets", async () => {
  const owner = await signIn("BulkOwner");
  const site = await siteOwnedBy(owner);
  await mint(site, owner);
  await mint(site, owner);
  const lookup = vi.spyOn(database, "getShare");
  const res = await sharesGET(read(`/api/sites/${site.slug}/shares`, owner.cookie),params({slug:site.slug}));
  expect(res.status).toBe(200);
  expect(lookup).not.toHaveBeenCalled();
  const {shares} = await res.json();
  expect(shares).toHaveLength(2);
  for (const share of shares) {
    expect(share.url).toContain("/v/");
    expect(share).not.toHaveProperty("token");
    expect(share).not.toHaveProperty("tokenHash");
    expect(share).not.toHaveProperty("passcodeHash");
  }
});
