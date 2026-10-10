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
