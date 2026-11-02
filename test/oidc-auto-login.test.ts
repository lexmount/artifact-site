import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { __resetDiscoveryForTests, beginLogin } from "@/lib/oidc";
import { closeDbForTests } from "@/lib/db";

const ISSUER = "https://idp.example/oidc";
const CLIENT_ID = "test-client";
const dirs: string[] = [];

let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
let issuedIdToken: string | null = null;

/** A mock IdP: real RS256 signing + a real JWKS, so jwtVerify does genuine work. */
async function stubIdp(overrides: { issuer?: string } = {}) {
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: overrides.issuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        end_session_endpoint: `${ISSUER}/session/end`,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/jwks")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/token")) {
      return new Response(JSON.stringify({ id_token: issuedIdToken }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

async function mintIdToken(claims: Record<string, unknown>) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(CLIENT_ID)
    .setIssuedAt().setExpirationTime("5m")
    .sign(keys.privateKey);
}

const req = (cookie?: string) =>
  new Request("https://hub.example/api/auth/callback", { headers: cookie ? { cookie } : {} });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-oidc-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = "https://hub.example";
  process.env.ARTIFACT_OIDC_ISSUER = ISSUER;
  process.env.ARTIFACT_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "shh";
  keys = await generateKeyPair("RS256");
  __resetDiscoveryForTests();
  await stubIdp();
});

afterEach(async () => {
  await closeDbForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ["ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET"]) delete process.env[k];
  issuedIdToken = null;
});


describe("silent sign-in", () => {
  it("uses prompt=none only for automatic authentication", async () => {
    const automatic = await beginLogin(req(), "/me?view=all#folder", true);
    expect(new URL(automatic.url).searchParams.get("prompt")).toBe("none");
    const manual = await beginLogin(req(), "/me");
    expect(new URL(manual.url).searchParams.has("prompt")).toBe(false);
  });

  it("returns a bound silent denial to the original page without minting a session", async () => {
    const { handleOidcCallback } = await import("@/lib/oidc-callback");
    const flow = await beginLogin(req(), "/me?view=all#folder", true);
    const state = new URL(flow.url).searchParams.get("state")!;
    const request = new Request(`https://hub.example/api/auth/callback?error=login_required&state=${encodeURIComponent(state)}`, {
      headers: { cookie: flow.cookie.split(";")[0] },
    });
    const response = await handleOidcCallback(request);
    expect(response.headers.get("location")).toBe("https://hub.example/me?view=all#folder");
    expect(response.headers.get("set-cookie")).not.toContain("__Host-ah_session=");
    expect(response.headers.get("set-cookie")).toContain("artifact_sso_retry=");
    await expect(handleOidcCallback(request)).rejects.toThrow();
  });

  it("does not trust an unbound silent error or a query-supplied return path", async () => {
    const { handleOidcCallback } = await import("@/lib/oidc-callback");
    const flow = await beginLogin(req(), "/me", true);
    const state = new URL(flow.url).searchParams.get("state")!;
    await expect(handleOidcCallback(new Request(`https://hub.example/api/auth/callback?error=login_required&state=${state}&return_to=//evil.test`))).rejects.toThrow();
  });
});

it("establishes a real session from a silent callback through the alias", async () => {
  const { GET: callback } = await import("@/app/v1/access/auth/oauth/callback/route");
  const { resolveSession } = await import("@/lib/session");
  const flow = await beginLogin(req(), "/me?view=all#folder", true);
  const params = new URL(flow.url).searchParams;
  issuedIdToken = await mintIdToken({ sub: "silent-user", nonce: params.get("nonce"), email_verified: true });
  const result = await callback(new Request(`https://hub.example/v1/access/auth/oauth/callback?code=code&state=${params.get("state")}`, {
    headers: { cookie: flow.cookie.split(";")[0] },
  }));
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("https://hub.example/me?view=all#folder");
  const sessionCookie = result.headers.getSetCookie().find(c => c.startsWith("__Host-ah_sso_session="))!;
  expect(await resolveSession(req(sessionCookie.split(";")[0]))).not.toBeNull();
});

it("does not resurrect an opted-out browser when a silent callback arrives later", async () => {
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const flow = await beginLogin(req(), "/me", true);
  const params = new URL(flow.url).searchParams;
  issuedIdToken = await mintIdToken({ sub: "silent-user", nonce: params.get("nonce") });
  const result = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=code&state=${params.get("state")}`, {
    headers: { cookie: `${flow.cookie.split(";")[0]}; artifact_sso_opt_out=1` },
  }));
  expect(result.headers.get("location")).toBe("https://hub.example/me");
  expect(result.headers.get("set-cookie")).not.toContain("__Host-ah_session=");
});

it("keeps silent token failures anonymous, but still rejects invalid tokens", async () => {
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const flow = await beginLogin(req(), "/me", true);
  issuedIdToken = await mintIdToken({ sub: "silent-user", nonce: "wrong" });
  const state = new URL(flow.url).searchParams.get("state");
  const result = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=code&state=${state}`, {
    headers: { cookie: flow.cookie.split(";")[0] },
  }));
  expect(result.headers.get("location")).toBe("https://hub.example/me");
  expect(result.headers.get("set-cookie")).not.toContain("__Host-ah_session=");
});

it("honors opt-out and forces manual authentication without lifting suppression", async () => {
  const { GET: login } = await import("@/app/api/auth/login/route");
  const result = await login(new Request("https://hub.example/api/auth/login?silent=1&return_to=%2Fme", {
    headers: { cookie: "artifact_sso_opt_out=1" },
  }));
  expect(result.headers.get("location")).toBe("https://hub.example/me");
  expect(result.headers.get("set-cookie")).not.toContain("artifact_sso_opt_out=");
  const manual = await login(new Request("https://hub.example/api/auth/login?return_to=%2Fme", {
    headers: { cookie: "artifact_sso_opt_out=1" },
  }));
  expect(new URL(manual.headers.get("location")!).searchParams.get("prompt")).toBe("login");
  expect(manual.headers.get("set-cookie")).not.toContain("artifact_sso_opt_out=");
});

it("returns to the app with retry protection when silent discovery fails", async () => {
  const { GET: login } = await import("@/app/api/auth/login/route");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const result = await login(new Request("https://hub.example/api/auth/login?silent=1&return_to=%2Fme"));
  expect(result.headers.get("location")).toBe("https://hub.example/me");
  expect(result.headers.get("set-cookie")).toContain("artifact_sso_retry=1");
});

it.each(["denial", "success"])("keeps a manual flow valid after another tab finishes silent authentication with %s", async (outcome) => {
  const { GET: login } = await import("@/app/api/auth/login/route");
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const jar = new Map<string, string>();
  const apply = (cookie: string) => {
    const pair = cookie.split(";")[0];
    const [name, value] = pair.split("=");
    if (value) jar.set(name, pair); else jar.delete(name);
  };
  const headers = () => ({ cookie: [...jar.values()].join("; ") });
  const manual = await beginLogin(req(), "/me");
  apply(manual.cookie);
  const manualParams = new URL(manual.url).searchParams;
  const silent = await login(new Request("https://hub.example/api/auth/login?silent=1&return_to=%2F", { headers: headers() }));
  silent.headers.getSetCookie().forEach(apply);
  const silentParams = new URL(silent.headers.get("location")!).searchParams;
  issuedIdToken = await mintIdToken({ sub: "silent-user", nonce: silentParams.get("nonce") });
  const result = outcome === "denial" ? "error=login_required" : "code=code";
  const finished = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?${result}&state=${silentParams.get("state")}`, { headers: headers() }));
  finished.headers.getSetCookie().forEach(apply);
  issuedIdToken = await mintIdToken({ sub: "manual-user", nonce: manualParams.get("nonce") });
  const completed = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=code&state=${manualParams.get("state")}`, { headers: headers() }));
  expect(completed.headers.get("location")).toBe("https://hub.example/me?welcome=0");
  expect(completed.headers.get("set-cookie")).toContain("__Host-ah_session=");
});

it("preserves the manually selected account when an older silent callback completes", async () => {
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const { resolveSession } = await import("@/lib/session");
  const silent = await beginLogin(req(), "/me", true);
  const manual = await beginLogin(req(), "/me");
  const params = new URL(manual.url).searchParams;
  issuedIdToken = await mintIdToken({ sub: "manual-user", nonce: params.get("nonce") });
  const completed = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=code&state=${params.get("state")}`, {
    headers: { cookie: manual.cookie.split(";")[0] },
  }));
  const sessionCookie = completed.headers.getSetCookie().find(c => c.startsWith("__Host-ah_session="))!.split(";")[0];
  const original = await resolveSession(req(sessionCookie));
  const silentParams = new URL(silent.url).searchParams;
  issuedIdToken = await mintIdToken({ sub: "other-user", nonce: silentParams.get("nonce") });
  const result = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=code&state=${silentParams.get("state")}`, {
    headers: { cookie: `${sessionCookie}; ${silent.cookie.split(";")[0]}` },
  }));
  expect(result.headers.get("location")).toBe("https://hub.example/me");
  expect(result.headers.get("set-cookie")).not.toContain("__Host-ah_session=");
  expect((await resolveSession(req(sessionCookie)))?.userId).toBe(original?.userId);
});

it("keeps concurrent silent bindings independent through both guest callbacks", async () => {
  const { GET: login } = await import("@/app/api/auth/login/route");
  const { GET: callback } = await import("@/app/api/auth/callback/route");
  const starts = await Promise.all(["/me?tab=recent", "/explore"].map(returnTo =>
    login(new Request(`https://hub.example/api/auth/login?silent=1&return_to=${encodeURIComponent(returnTo)}`))));
  const jar = new Map<string, string>();
  const apply = (cookie: string) => {
    const pair = cookie.split(";")[0], [name, value] = pair.split("=");
    if (value) jar.set(name, pair); else jar.delete(name);
  };
  starts.forEach(start => start.headers.getSetCookie().forEach(apply));
  for (const [index, start] of starts.entries()) {
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const result = await callback(new Request(`https://hub.example/api/auth/callback?error=login_required&state=${state}`, {
      headers: { cookie: [...jar.values()].join("; ") },
    }));
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(index ? "https://hub.example/explore" : "https://hub.example/me?tab=recent");
    result.headers.getSetCookie().forEach(apply);
  }
  expect([...jar.keys()].filter(name => name.includes("oidc_flow"))).toEqual([]);
});

it.each(["", "/artifacts"])("cancels an in-flight silent exchange after explicit login or logout at %s", async (mount) => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
  vi.stubEnv("ARTIFACT_PUBLIC_URL", `https://hub.example${mount}`);
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const { POST: logout } = await import("@/app/api/auth/logout/route");
  const { resolveSession } = await import("@/lib/session");
  for (const action of ["login", "switch", "logout", "login-logout"]) {
    const signOut = action === "logout" || action === "login-logout";
    const jar = new Map<string, string>();
    const apply = (cookie: string) => {
      const pair = cookie.split(";")[0], [name, value] = pair.split("=");
      if (value) jar.set(name, pair); else jar.delete(name);
    };
    const headers = () => ({ cookie: [...jar.values()].join("; "), origin: "https://hub.example" });
    const silent = await beginLogin(req(), "/me", true); apply(silent.cookie);
    const manual = await beginLogin(req(), "/me", false, action === "switch"); apply(manual.cookie);
    const silentParams = new URL(silent.url).searchParams, manualParams = new URL(manual.url).searchParams;
    const token = await mintIdToken({ sub: "obsolete-user", nonce: silentParams.get("nonce") });
    const originalFetch = globalThis.fetch;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/token") && String(init?.body).includes("code=slow")) {
        entered(); await held;
        return Response.json({ id_token: token });
      }
      return originalFetch(input, init);
    });
    const pending = handleOidcCallback(new Request(`https://hub.example${mount}/api/auth/callback?code=slow&state=${silentParams.get("state")}`, { headers: headers() }));
    await started;
    if (action !== "logout") {
      issuedIdToken = await mintIdToken({ sub: "selected-user", nonce: manualParams.get("nonce") });
      const completed = await handleOidcCallback(new Request(`https://hub.example${mount}/api/auth/callback?code=manual&state=${manualParams.get("state")}`, { headers: headers() }));
      completed.headers.getSetCookie().forEach(apply);
    }
    const selected = await resolveSession(new Request("https://hub.example/", { headers: headers() }));
    if (action !== "logout") expect(selected).not.toBeNull();
    if (signOut) (await logout(new Request(`https://hub.example${mount}/api/auth/logout`, { method: "POST", headers: headers() }))).headers.getSetCookie().forEach(apply);
    release();
    const late = await pending; late.headers.getSetCookie().forEach(apply);
    expect(late.headers.get("set-cookie")).not.toMatch(/ah_(?:sso_)?session=/);
    const final = await resolveSession(new Request("https://hub.example/", { headers: headers() }));
    expect(final?.userId ?? null).toBe(signOut ? null : selected!.userId);
    vi.stubGlobal("fetch", originalFetch);
  }
});

it.each([false, true])("preserves explicit state when a completed silent response is delivered late (logout=%s)", async (signOut) => {
  const { handleOidcCallback } = await import("@/lib/oidc-callback");
  const { POST: logout } = await import("@/app/api/auth/logout/route");
  const { resolveSession } = await import("@/lib/session");
  const jar = new Map<string, string>();
  const apply = (cookie: string) => {
    const pair = cookie.split(";")[0], [name, value] = pair.split("=");
    if (value) jar.set(name, pair); else jar.delete(name);
  };
  const headers = () => ({ cookie: [...jar.values()].join("; "), origin: "https://hub.example" });
  const silent = await beginLogin(req(), "/me", true); apply(silent.cookie);
  const manual = await beginLogin(req(), "/me", false, true); apply(manual.cookie);
  const sp = new URL(silent.url).searchParams, mp = new URL(manual.url).searchParams;
  issuedIdToken = await mintIdToken({ sub: "obsolete-user", nonce: sp.get("nonce") });
  const delayedResponse = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=silent&state=${sp.get("state")}`, { headers: headers() }));
  issuedIdToken = await mintIdToken({ sub: "selected-user", nonce: mp.get("nonce") });
  const explicit = await handleOidcCallback(new Request(`https://hub.example/api/auth/callback?code=manual&state=${mp.get("state")}`, { headers: headers() }));
  explicit.headers.getSetCookie().forEach(apply);
  const selected = await resolveSession(new Request("https://hub.example/", { headers: headers() }));
  if (signOut) (await logout(new Request("https://hub.example/api/auth/logout", { method: "POST", headers: headers() }))).headers.getSetCookie().forEach(apply);
  delayedResponse.headers.getSetCookie().forEach(apply);
  const current = await resolveSession(new Request("https://hub.example/", { headers: headers() }));
  expect(current?.userId ?? null).toBe(signOut ? null : selected!.userId);
});


describe.each(["", "/artifacts"])("normalized guest returns at mount %s", (mount) => {
  it.each(["opt-out", "retry", "session", "discovery", "rate-limit"])("keeps %s fallbacks on the application origin", async (condition) => {
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    const { GET: login } = await import("@/app/api/auth/login/route");
    const limiter = await import("@/lib/ratelimit");
    const rateCheck = vi.spyOn(limiter, "checkRateLimit").mockImplementation(() => {});
    let cookie = "";
    if (condition === "opt-out") cookie = "artifact_sso_opt_out=1";
    if (condition === "retry") cookie = "artifact_sso_retry=1";
    if (condition === "session") {
      const { upsertUser } = await import("@/lib/db");
      const { mintSession } = await import("@/lib/session");
      const user = await upsertUser({ authProvider: "test", providerSubject: "return-test" });
      cookie = (await mintSession(req(), user.id)).cookie.split(";")[0];
    }
    if (condition === "discovery") vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    if (condition === "rate-limit") rateCheck.mockImplementation(() => { throw new limiter.RateLimitError(); });
    const unsafe = ["/..//outside.example", "/%2e%2e//outside.example", "/a/..//outside.example", "/a/.%2e//outside.example"];
    for (const target of [...unsafe, ...unsafe.map(path => `${mount}${path}`), `${mount}/me?view=all#folder`]) {
      const result = await login(new Request(`https://hub.example${mount}/api/auth/login?silent=1&return_to=${encodeURIComponent(target)}`, { headers: { cookie } }));
      expect(result.status).toBe(302);
      expect(result.headers.get("location"), target).toBe(`https://hub.example${mount}${target.endsWith("#folder") ? "/me?view=all#folder" : "/"}`);
    }
  });
});

describe.each(["", "/artifacts"])("account switching at mount %s", (mount) => {
  it.each(["success", "denied", "invalid-token"])("revokes the current session before switching: %s", async (outcome) => {
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    const { GET: login } = await import("@/app/api/auth/login/route");
    const { GET: callback } = await import("@/app/api/auth/callback/route");
    const { upsertUser } = await import("@/lib/db");
    const { mintSession, resolveSession } = await import("@/lib/session");
    const user = await upsertUser({ authProvider: "oidc", providerSubject: "old-account" });
    const explicit = await mintSession(req(), user.id);
    const automatic = await mintSession(req(), user.id, { automatic: true });
    const oldCookies = [explicit.cookie, automatic.cookie].map(c => c.split(";")[0]).join("; ");
    const { POST: logout } = await import("@/app/api/auth/logout/route");
    const signedOut = await logout(new Request(`https://hub.example${mount}/api/auth/logout`, {
      method: "POST", headers: { cookie: oldCookies, origin: "https://hub.example" },
    }));
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain(`artifact_sso_opt_out=1; Path=${mount || "/"};`);
    expect(await resolveSession(req(explicit.cookie.split(";")[0]))).toBeNull();
    expect(await resolveSession(req(automatic.cookie.split(";")[0]))).toBeNull();
    const start = await login(new Request(`https://hub.example${mount}/api/auth/login?switch_account=1&return_to=${encodeURIComponent(`${mount}/s/report?version=v1&share=a%2Bb#page-3`)}`, { headers: { cookie: "artifact_sso_opt_out=1" } }));
    const params = new URL(start.headers.get("location")!).searchParams;
    expect(params.get("prompt")).toBe("login");
    expect(await resolveSession(req(oldCookies))).toBeNull();
    expect(start.headers.get("set-cookie")).not.toContain("ah_session=");
    const flowCookie = start.headers.getSetCookie().find(c => c.startsWith("__Host-oidc_flow="))!.split(";")[0];
    issuedIdToken = await mintIdToken({ sub: "new-account", nonce: outcome === "invalid-token" ? "wrong" : params.get("nonce") });
    const request = new Request(`https://hub.example${mount}/api/auth/callback?${outcome === "denied" ? "error=access_denied" : "code=code"}&state=${params.get("state")}`, { headers: { cookie: `artifact_sso_opt_out=1; ${flowCookie}` } });
    const completed = await callback(request);
    if (outcome === "success") {
      expect(completed.status).toBe(302);
      expect(completed.headers.get("location")).toBe(`https://hub.example${mount}/s/report?version=v1&share=a%2Bb&welcome=0#page-3`);
      const cookie = completed.headers.getSetCookie().find(c => c.startsWith("__Host-ah_session="))!.split(";")[0];
      expect((await resolveSession(req(cookie)))?.userId).not.toBe(user.id);
      expect(await resolveSession(req(explicit.cookie.split(";")[0]))).toBeNull();
      expect(await resolveSession(req(automatic.cookie.split(";")[0]))).toBeNull();
      expect(completed.headers.get("set-cookie")).toContain(`artifact_sso_opt_out=; Path=${mount || "/"}; HttpOnly; SameSite=Lax; Max-Age=0`);
      expect(completed.headers.get("set-cookie")).toContain("artifact_auth_change=");
    } else {
      expect(completed.status).toBe(400);
      const html = await completed.text();
      expect(html).toContain("switch_account=1");
      expect(html).toContain(`return_to=${encodeURIComponent(`${mount}/s/report?version=v1&share=a%2Bb#page-3`)}`);
      expect(await resolveSession(req(oldCookies))).toBeNull();
      expect(completed.headers.get("set-cookie") || "").not.toContain("ah_session=");
      expect(completed.headers.get("set-cookie") || "").not.toContain("artifact_sso_opt_out=");
      const automaticRetry = await login(new Request(`https://hub.example${mount}/api/auth/login?silent=1`, { headers: { cookie: "artifact_sso_opt_out=1" } }));
      expect(automaticRetry.headers.get("location")).toBe(`https://hub.example${mount}/`);
    }
    expect((await callback(request)).status).toBe(400);
  });

  it("does not revoke a session on a switch-mode GET", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    const { GET: login } = await import("@/app/api/auth/login/route");
    const { upsertUser } = await import("@/lib/db");
    const { mintSession, resolveSession } = await import("@/lib/session");
    const user = await upsertUser({ authProvider: "oidc", providerSubject: "direct-switch" });
    const { cookie } = await mintSession(req(), user.id);
    const credential = cookie.split(";")[0];
    await login(new Request(`https://hub.example${mount}/api/auth/login?switch_account=1`, { headers: { cookie: credential } }));
    expect((await resolveSession(req(credential)))?.userId).toBe(user.id);
  });

  it("rejects conflicting automatic and switch modes", async () => {
    const { GET: login } = await import("@/app/api/auth/login/route");
    const result = await login(new Request("https://hub.example/api/auth/login?silent=1&switch_account=1"));
    expect(result.status).toBe(400);
    expect(result.headers.get("location")).toBeNull();
  });
});

describe.each(["", "/artifacts"])("interactive login return links at %s", mount => {
  it.each(["success", "denied"])("preserves query credentials and fragments after %s", async outcome => {
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    const { GET: callback } = await import("@/app/api/auth/callback/route");
    const target = `${mount}/s/report?version=v2&share=a%2Bb#page-4`;
    const flow = await beginLogin(req(), target);
    const params = new URL(flow.url).searchParams;
    issuedIdToken = await mintIdToken({ sub: "interactive-reader", nonce: params.get("nonce") });
    const result = await callback(new Request(`https://hub.example${mount}/api/auth/callback?${outcome === "denied" ? "error=access_denied" : "code=code"}&state=${params.get("state")}`, { headers: { cookie: flow.cookie.split(";")[0] } }));
    if (outcome === "success") {
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe(`https://hub.example${mount}/s/report?version=v2&share=a%2Bb&welcome=0#page-4`);
    } else {
      const html = await result.text();
      expect(html).toContain(`return_to=${encodeURIComponent(target)}`);
      expect(html).not.toContain("switch_account=1");
    }
  });
});
