import { afterEach, expect, it, vi } from "vitest";
import { closeDbForTests, upsertUser } from "@/lib/db";
import { handleOidcCallback } from "@/lib/oidc-callback";

vi.mock("@/lib/oidc", () => ({
  completeLogin: async () => ({ subject: "analytics-account", returnTo: "/me" }),
  clearFlowCookie: () => "oidc_flow=; Path=/; Max-Age=0",
  OidcError: class extends Error {},
}));
vi.mock("@/lib/session", () => ({ mintSession: async () => ({ cookie: "session=test; Path=/; HttpOnly" }) }));
afterEach(async () => { await closeDbForTests(); vi.unstubAllEnvs(); });

it("distinguishes account insertion from refresh without timestamp heuristics", async () => {
  const input = { authProvider: "test", providerSubject: "new-user" };
  const first = await upsertUser(input);
  const second = await upsertUser(input);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.id).toBe(first.id);
});

it("marks only the first completed OIDC sign-in as signup", async () => {
  vi.stubEnv("ARTIFACT_GA_MEASUREMENT_ID", "G-TEST123");
  vi.stubEnv("ARTIFACT_GA_HOSTS", "app.example.com");
  vi.stubEnv("ARTIFACT_PUBLIC_URL", "https://app.example.com");
  const req = new Request("https://app.example.com/api/auth/callback?code=secret&state=secret");
  const first = await handleOidcCallback(req);
  expect(first.cookies.get("artifact_analytics_auth")?.value).toBe("new");
  const cookies = first.headers.getSetCookie().join("; ");
  expect(cookies).toContain("session=test");
  expect(cookies).toContain("oidc_flow=");
  expect(cookies).toContain("artifact_analytics_auth=new");
  const second = await handleOidcCallback(req);
  expect(second.cookies.get("artifact_analytics_auth")?.value).toBe("login");
  vi.stubEnv("ARTIFACT_GA_MEASUREMENT_ID", "");
  expect((await handleOidcCallback(req)).cookies.get("artifact_analytics_auth")).toBeUndefined();
});
