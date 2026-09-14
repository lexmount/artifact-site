// Device authorisation → publish token → owned from birth. This chain is the foundation of "anything
// an agent produces must have an identity attached"; each of its three invariants gets one test:
// the grant is single-use (consume is atomic), a token folded into a session creates sites that are
// owned directly, and revocation takes effect immediately. The HTTP layer calls the route handlers
// directly, in the same shape as claim.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getPublishToken, listSitesByOwner, listPublishTokens, revokePublishToken, upsertUser } from "@/lib/db";
import { csrfSafe, mintSession, resolveSession } from "@/lib/session";
import { hashTokenSecret } from "@/lib/publish-token";
import { POST as deviceStart } from "@/app/api/device/start/route";
import { POST as devicePoll } from "@/app/api/device/poll/route";
import { POST as deviceApprove } from "@/app/api/device/approve/route";
import { POST as createSitePOST } from "@/app/api/sites/route";

const ORIGIN = "http://test.local";
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-device-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

function post(path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function signedInCookie(): Promise<{ userId: string; cookie: string }> {
  const u = await upsertUser({ authProvider: "t", providerSubject: "device-user", email: "dev@x.test", emailVerified: true });
  const { cookie } = await mintSession(new Request(`${ORIGIN}/`), u.id);
  return { userId: u.id, cookie: cookie.split(";")[0] };
}

async function fullHandshake() {
  const start = await (await deviceStart(post("/api/device/start"))).json();
  const { userId, cookie } = await signedInCookie();
  const approve = await deviceApprove(post("/api/device/approve", {
    headers: { origin: ORIGIN, cookie },
    body: { user_code: start.user_code },
  }));
  expect(approve.status).toBe(200);
  const redeemed = await (await devicePoll(post("/api/device/poll", { body: { device_code: start.device_code } }))).json();
  expect(redeemed.status).toBe("approved");
  return { userId, token: redeemed.token as string, start };
}

describe("device authorization", () => {
  it("start → pending → approve → poll mints a token bound to the approving user", async () => {
    const start = await (await deviceStart(post("/api/device/start"))).json();
    expect(start.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(start.verification_url).toContain(`/activate?code=${start.user_code}`);

    const pending = await (await devicePoll(post("/api/device/poll", { body: { device_code: start.device_code } }))).json();
    expect(pending.status).toBe("pending");

    const { userId, cookie } = await signedInCookie();
    // Neither case nor the hyphen should get in the way — the code is read off one screen and typed
    // into another.
    const sloppy = start.user_code.toLowerCase().replace("-", "");
    const ok = await deviceApprove(post("/api/device/approve", { headers: { origin: ORIGIN, cookie }, body: { user_code: sloppy } }));
    expect(ok.status).toBe(200);

    const redeemed = await (await devicePoll(post("/api/device/poll", { body: { device_code: start.device_code } }))).json();
    expect(redeemed.status).toBe("approved");
    expect(redeemed.token).toMatch(/^ahp_/);
    expect(redeemed.user.email).toBe("dev@x.test");
    expect((await getPublishToken(hashTokenSecret(redeemed.token)))!.userId).toBe(userId);
  });

  it("start ships a ready-to-forward user_message — the agent must not have to compose one", async () => {
    const start = await (await deviceStart(post("/api/device/start"))).json();
    const msg = start.user_message as string;
    // Self-contained: both routes and the code, so relaying this ONE block is enough for the user
    // to finish authorizing. A field the agent has to assemble is a field it will skip.
    expect(msg).toContain(start.verification_url);
    expect(msg).toContain(start.verification_url_manual);
    expect(msg).toContain(start.user_code);
    expect(start.verification_url_manual).toMatch(/\/activate$/);
    expect(msg).toContain("10 minutes"); // the deadline, from DEVICE_GRANT_TTL_MS
  });

  it("redemption is one-shot — a replayed poll never mints a second credential", async () => {
    const { start } = await fullHandshake();
    const replay = await devicePoll(post("/api/device/poll", { body: { device_code: start.device_code } }));
    expect(replay.status).toBe(400);
  });

  it("a failed token mint leaves the grant approved — the retry succeeds instead of stranding the user", async () => {
    const { approveDeviceGrant, getDeviceGrant, insertDeviceGrant, insertPublishToken, redeemDeviceGrant } = await import("@/lib/db");
    const { userId } = await signedInCookie();
    const code = "atomic-redeem-device-code";
    await insertDeviceGrant({ deviceCode: hashTokenSecret(code), userCode: "CCCC-DDDD", createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    expect(await approveDeviceGrant("CCCC-DDDD", userId, Date.now())).toBe(true);

    // Occupy the token PK so the transactional mint must fail mid-redeem.
    await insertPublishToken({ id: "tok_dup", userId, name: "占位", createdAt: Date.now() });
    await expect(redeemDeviceGrant(hashTokenSecret(code), { id: "tok_dup", name: "重复" }, Date.now())).rejects.toThrow();
    expect((await getDeviceGrant(hashTokenSecret(code)))!.status, "mint failed → consume must roll back").toBe("approved");

    // The retry (fresh token id) completes the redemption.
    expect(await redeemDeviceGrant(hashTokenSecret(code), { id: "tok_fresh", name: "重试" }, Date.now())).toBe(userId);
    expect((await getDeviceGrant(hashTokenSecret(code)))!.status).toBe("consumed");
  });

  it("an expired grant polls as expired — not as \"already redeemed\"", async () => {
    const { insertDeviceGrant } = await import("@/lib/db");
    const code = "expired-device-code-under-test";
    await insertDeviceGrant({
      deviceCode: hashTokenSecret(code), userCode: "AAAA-BBBB",
      createdAt: Date.now() - 1000, expiresAt: Date.now() - 1,
    });
    const res = await (await devicePoll(post("/api/device/poll", { body: { device_code: code } }))).json();
    expect(res.status).toBe("expired");
  });

  it("approving needs a browser session: anonymous and token-session callers are refused", async () => {
    const start = await (await deviceStart(post("/api/device/start"))).json();
    const anon = await deviceApprove(post("/api/device/approve", { headers: { origin: ORIGIN }, body: { user_code: start.user_code } }));
    expect(anon.status).toBe(401);

    // A leaked token must not be able to approve itself a fresh replacement.
    const { token } = await fullHandshake();
    const viaToken = await deviceApprove(post("/api/device/approve", {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      body: { user_code: start.user_code },
    }));
    expect(viaToken.status).toBe(401);
  });
});

describe("publishing with a token", () => {
  it("folds into a session and a created site is owned from birth", async () => {
    const { userId, token } = await fullHandshake();

    const session = await resolveSession(new Request(`${ORIGIN}/api/sites`, { headers: { authorization: `Bearer ${token}` } }));
    expect(session?.userId).toBe(userId);
    expect(session?.id.startsWith("pt:")).toBe(true);

    const res = await createSitePOST(post("/api/sites", {
      headers: { authorization: `Bearer ${token}` },
      body: { mode: "paste", html: "<!doctype html><html><head><title>t</title></head><body>x</body></html>", title: "born owned" },
    }));
    expect(res.status).toBe(200);
    const owned = await listSitesByOwner(userId);
    expect(owned.map((s) => s.title)).toContain("born owned");
  });

  it("the stale-skill notice reaches exactly the anonymous agent — not token flows, not IdP-less deployments", async () => {
    const oidc = { ARTIFACT_OIDC_ISSUER: "https://idp.example/oidc", ARTIFACT_OIDC_CLIENT_ID: "cid", ARTIFACT_OIDC_CLIENT_SECRET: "s" };
    const site = { mode: "paste", html: "<!doctype html><html><head><title>t</title></head><body>x</body></html>" };
    try {
      Object.assign(process.env, oidc);
      // Anonymous + IdP configured → the one audience the banner is for.
      const anon = await (await createSitePOST(post("/api/sites", { body: site }))).json();
      expect(anon.notice).toContain("/for-agents.md");
      expect(anon.notice).toContain("/api/device/start");
      // Token publishers already run the new flow — no banner.
      const { token } = await fullHandshake();
      const viaToken = await (await createSitePOST(post("/api/sites", { headers: { authorization: `Bearer ${token}` }, body: site }))).json();
      expect(viaToken.notice).toBeUndefined();
    } finally {
      for (const k of Object.keys(oidc)) delete process.env[k];
    }
    // No IdP → no device flow to point at; the banner would only mislead.
    const noIdp = await (await createSitePOST(post("/api/sites", { body: site }))).json();
    expect(noIdp.notice).toBeUndefined();
  });

  it("a Bearer write is CSRF-safe without an Origin; cookies alone are not", () => {
    expect(csrfSafe(new Request(`${ORIGIN}/x`, { headers: { authorization: "Bearer ahp_whatever" } }))).toBe(true);
    expect(csrfSafe(new Request(`${ORIGIN}/x`, { headers: { cookie: "ah_session=s" } }))).toBe(false);
  });

  it("revocation cuts the fold immediately and never falls back to cookies", async () => {
    const { userId, token } = await fullHandshake();
    const [row] = await listPublishTokens(userId);
    expect(await revokePublishToken(row.id, userId)).toBe(true);
    const session = await resolveSession(new Request(`${ORIGIN}/`, { headers: { authorization: `Bearer ${token}` } }));
    expect(session).toBeNull();
  });

  it("a revoked bearer fails loudly on the OPEN routes — never a silently anonymous site", async () => {
    const { POST: forkPOST } = await import("@/app/api/sites/[slug]/fork/route");
    const { userId, token } = await fullHandshake();
    const siteBody = { mode: "paste", html: "<!doctype html><html><head><title>t</title></head><body>x</body></html>", title: "owned before revoke" };
    const made = await (await createSitePOST(post("/api/sites", { headers: { authorization: `Bearer ${token}` }, body: siteBody }))).json();

    const [row] = await listPublishTokens(userId);
    await revokePublishToken(row.id, userId);

    // The agent still holds the token and still EXPECTS born-owned publishing. 401 tells it the
    // truth; a 200 would mint an unowned site it believes it owns.
    const create = await createSitePOST(post("/api/sites", { headers: { authorization: `Bearer ${token}` }, body: siteBody }));
    expect(create.status).toBe(401);
    const fork = await forkPOST(post(`/api/sites/${made.slug}/fork`, { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ slug: made.slug as string }) });
    expect(fork.status).toBe(401);
  });
});
