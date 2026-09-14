import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetWarnedForTests, OIDC_CALLBACK_PATHS, config } from "@/lib/config";
import { redirectUri } from "@/lib/oidc";

const KEYS = ["ARTIFACT_OIDC_REDIRECT_PATH", "ARTIFACT_PUBLIC_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("oidc redirect path", () => {
  // The redirect_uri we send has to name a route that exists, or login dies at the IdP with a
  // mismatch (or worse, 404s after a successful authorization). Keep the list and the route files
  // in lockstep — this test is the lock.
  it("every advertised callback path has a route file backing it", () => {
    for (const p of OIDC_CALLBACK_PATHS) {
      const file = path.join(process.cwd(), "src/app", p, "route.ts");
      expect(existsSync(file), `${p} 缺少路由文件 ${file}`).toBe(true);
    }
  });

  it("defaults to the canonical path", () => {
    delete process.env.ARTIFACT_OIDC_REDIRECT_PATH;
    process.env.ARTIFACT_PUBLIC_URL = "https://artifact-site.example.net";
    expect(config.oidcRedirectPath).toBe("/api/auth/callback");
    expect(redirectUri()).toBe("https://artifact-site.example.net/api/auth/callback");
  });

  it("honours a registered alias so a deployment can match an IdP entry it does not own", () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://artifact-site.example.net";
    process.env.ARTIFACT_OIDC_REDIRECT_PATH = "/v1/access/auth/oauth/callback";
    expect(redirectUri()).toBe("https://artifact-site.example.net/v1/access/auth/oauth/callback");
  });

  it("rejects a path with no route rather than advertising an address that 404s", () => {
    __resetWarnedForTests(); // warnOnce is per process; an earlier case may have printed this one
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ARTIFACT_PUBLIC_URL = "https://artifact-site.example.net";
    process.env.ARTIFACT_OIDC_REDIRECT_PATH = "/oauth/cb";
    expect(config.oidcRedirectPath).toBe("/api/auth/callback");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is invalid"));
  });
});
