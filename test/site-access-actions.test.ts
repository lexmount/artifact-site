import { afterEach, expect, it, vi } from "vitest";
import { retrySiteAccess } from "@/components/site-access-actions";
import { logoutAuth } from "@/lib/auth-store";
vi.mock("@/lib/auth-store", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/auth-store")>(), logoutAuth: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ setAnalyticsUser: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

it.each(["", "/artifacts"])("preserves the complete link for login and switching under %s", async mount => {
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
  const assign = vi.fn();
  const target = `${mount}/s/report?version=v1&share=a%2Bb&collection=c#page-3`;
  const url = new URL(target, "https://hub.example");
  vi.stubGlobal("window", { location: { pathname: url.pathname, search: url.search, hash: url.hash, assign } });
  await retrySiteAccess();
  expect(logoutAuth).not.toHaveBeenCalled();
  expect(assign).toHaveBeenLastCalledWith(`${mount}/api/auth/login?return_to=${encodeURIComponent(target)}`);
  await retrySiteAccess(true);
  expect(logoutAuth).toHaveBeenCalledOnce();
  expect(assign).toHaveBeenLastCalledWith(`${mount}/api/auth/login?return_to=${encodeURIComponent(target)}&switch_account=1`);
  expect(vi.mocked(logoutAuth).mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[1]);
});
it("stays on the original page if sign-out fails", async () => {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname: "/s/report", search: "?version=v1", hash: "#p2", assign } });
  vi.mocked(logoutAuth).mockRejectedValueOnce(new Error("network"));
  await expect(retrySiteAccess(true)).rejects.toThrow("network");
  expect(assign).not.toHaveBeenCalled();
});
