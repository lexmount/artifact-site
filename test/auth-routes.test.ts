import { afterEach, expect, it, vi } from "vitest";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { mintSession, resolveSession } from "@/lib/session";
import { closeDbForTests, upsertUser } from "@/lib/db";

afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });

it("revokes the session and expires the browser cookie through an HTTPS proxy", async () => {
  vi.stubEnv("ARTIFACT_PUBLIC_URL", "https://app.example.com");
  const user = await upsertUser({ authProvider: "test", providerSubject: "logout" });
  const headers = { "x-forwarded-proto": "https", origin: "https://app.example.com" };
  const { cookie } = await mintSession(new Request("http://internal/api/auth/callback", { headers }), user.id);
  const request = new Request("http://internal/api/auth/logout", { method: "POST", headers: { ...headers, cookie: cookie.split(";")[0] } });
  expect(await resolveSession(request)).not.toBeNull();
  const result = await logout(request);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true });
  expect(result.cookies.get("artifact_auth_change")).toMatchObject({ value: "", maxAge: 0 });
  expect(result.headers.get("set-cookie")).toContain("__Host-ah_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  expect(await resolveSession(request)).toBeNull();
});

it("rejects cross-site logout without revoking the session", async () => {
  const user = await upsertUser({ authProvider: "test", providerSubject: "csrf" });
  const { cookie } = await mintSession(new Request("https://app.example.com"), user.id);
  const request = new Request("https://app.example.com/api/auth/logout", { method: "POST", headers: { origin: "null", cookie: cookie.split(";")[0] } });
  expect((await logout(request)).status).toBe(401);
  expect(await resolveSession(request)).not.toBeNull();
});

it("prevents caching both anonymous and authenticated account responses", async () => {
  const user = await upsertUser({ authProvider: "test", providerSubject: "cache" });
  const { cookie } = await mintSession(new Request("https://app.example.com"), user.id);
  for (const value of ["", cookie.split(";")[0]]) {
    const result = await me(new Request("https://app.example.com/api/auth/me", { headers: { cookie: value } }));
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("vary")).toBe("Cookie, Authorization");
    expect((await result.json()).user?.id ?? null).toBe(value ? user.id : null);
  }
});

it("suppresses automatic sign-in after local logout without ending the IdP session", async () => {
  vi.stubEnv("ARTIFACT_OIDC_ISSUER", "https://idp.example/oidc");
  vi.stubEnv("ARTIFACT_OIDC_CLIENT_ID", "client");
  vi.stubEnv("ARTIFACT_OIDC_CLIENT_SECRET", "secret");
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifacts");
  vi.stubEnv("ARTIFACT_PUBLIC_URL", "https://app.example.com/artifacts");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    const request = new Request("https://app.example.com/artifacts/api/auth/me");
    expect((await (await me(request)).json()).autoLogin).toBe(true);
    const result = await logout(new Request("https://app.example.com/artifacts/api/auth/logout", {
      method: "POST", headers: { origin: "https://app.example.com" },
    }));
    const preference = result.headers.getSetCookie().find(value => value.startsWith("artifact_sso_opt_out="))!;
    expect(preference).toContain("Path=/artifacts; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure");
    const optedOut = new Request(request, { headers: { cookie: preference.split(";")[0] } });
    expect((await (await me(optedOut)).json()).autoLogin).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("rolls back both browser revocations if the second update fails", async () => {
  const { rbacQuery, getSession } = await import("@/lib/db");
  const user = await upsertUser({ authProvider: "test", providerSubject: "atomic-logout" });
  const base = new Request("https://app.example.com");
  const explicit = await mintSession(base, user.id);
  const automatic = await mintSession(base, user.id, { automatic: true });
  const otherBrowser = await mintSession(base, user.id);
  const credential = (cookie: string) => cookie.split(";")[0];
  const request = new Request("https://app.example.com/api/auth/logout", {
    method: "POST", headers: { origin: "https://app.example.com", cookie: [explicit.cookie, automatic.cookie].map(credential).join("; ") },
  });
  const automaticId = (await resolveSession(new Request(base, { headers: { cookie: credential(automatic.cookie) } })))!.id;
  const explicitId = (await resolveSession(request))!.id;
  const postgres = process.env.ARTIFACT_DB_DRIVER === "postgres";
  // A database trigger fails only on the second credential, after the first UPDATE ran.
  if (postgres) {
    await rbacQuery(`CREATE FUNCTION fail_logout_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${automaticId}' THEN RAISE EXCEPTION 'injected revocation failure'; END IF; RETURN NEW; END $$`);
    await rbacQuery("CREATE TRIGGER fail_logout_update BEFORE UPDATE OF revoked_at ON sessions FOR EACH ROW EXECUTE FUNCTION fail_logout_update()");
  } else {
    await rbacQuery(`CREATE TRIGGER fail_logout_update BEFORE UPDATE OF revoked_at ON sessions WHEN NEW.id = '${automaticId}' BEGIN SELECT RAISE(ABORT, 'injected revocation failure'); END`);
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const failed = await logout(request);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("set-cookie")).toBeNull();
    expect((await getSession(explicitId))?.revokedAt).toBeNull();
    expect((await getSession(automaticId))?.revokedAt).toBeNull();
    expect((await resolveSession(request))?.userId).toBe(user.id);
  } finally {
    log.mockRestore();
    await rbacQuery(postgres ? "DROP TRIGGER fail_logout_update ON sessions" : "DROP TRIGGER fail_logout_update");
    if (postgres) await rbacQuery("DROP FUNCTION fail_logout_update()");
  }
  expect((await logout(request)).status).toBe(200);
  expect(await resolveSession(request)).toBeNull();
  expect(await resolveSession(new Request(base, { headers: { cookie: credential(automatic.cookie) } }))).toBeNull();
  expect((await resolveSession(new Request(base, { headers: { cookie: credential(otherBrowser.cookie) } })))?.userId).toBe(user.id);
});
