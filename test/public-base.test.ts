import { readdirSync } from "node:fs";
import reserved from "../config/reserved-base-paths.json";
import { validateBasePath } from "@/lib/base-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBase, baseFromHeaders, parsePublicUrl } from "@/lib/public-base";
import { describeRuntime } from "@/lib/runtime";
import { isSameOrigin } from "@/lib/session";
import { analyticsPage } from "@/lib/analytics";
import { appPath, appFetch } from "@/lib/app-path";
const A = "https://old.example";
const B = "https://new.example/artifact-site";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubEnv("ARTIFACT_PUBLIC_URL", B);
  vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "/artifact-site");
}
describe("canonical public address", () => {
  it("uses the configured address regardless of the incoming Host", () => {
    setup();
    expect(requestBase(new Request(`${B}/api/auth/login`))).toBe(B);
    expect(requestBase(new Request(`${A}/api/auth/login`))).toBe(B);
    expect(baseFromHeaders(new Headers({host:"evil.example", "x-forwarded-proto":"http"}))).toBe(B);
  });
  it("retains request-derived root URLs when no public address is configured", () => {
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "");
    expect(requestBase(new Request(`${A}/api/sites`))).toBe(A);
    expect(baseFromHeaders(new Headers({host:"proxy.example", "x-forwarded-proto":"https"}))).toBe("https://proxy.example");
  });
  it("checks the origin rather than the path and rejects foreign or opaque writes", () => {
    setup();
    const req = (origin: string) => new Request(`${B}/api/sites`, {headers:{origin}});
    expect(isSameOrigin(req("https://new.example"))).toBe(true);
    expect(isSameOrigin(req(A))).toBe(false);
    expect(isSameOrigin(req("null"))).toBe(false);
    expect(isSameOrigin(req(B))).toBe(false);
  });
  it("requires the canonical path to match the compiled mount", () => {
    setup();
    expect(describeRuntime().errors).toEqual([]);
    vi.stubEnv("ARTIFACT_PUBLIC_URL", A);
    expect(describeRuntime().errors.join(" ")).toMatch(/must match.*build-time/);
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    expect(describeRuntime().errors.join(" ")).toMatch(/Subpath deployments require/);
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", "");
    expect(describeRuntime().errors).toEqual([]);
    vi.stubEnv("ARTIFACT_PUBLIC_URL", A);
    expect(describeRuntime().errors).toEqual([]);
  });
  it("rejects unsafe or ambiguous configured URLs", () => {
    for (const value of ["https://user:pass@new.example/artifact-site", "https://new.example/artifact-site?x=1", "https://new.example/a/../artifact-site", "https://new.example/%61rtifact-site"]) {
      expect(() => parsePublicUrl(value)).toThrow();
    }
  });
});
describe("application paths", () => {
  it("prefixes once, preserves external URLs and fragments", () => {
    setup();
    expect(appPath("/api/sites?q=1")).toBe("/artifact-site/api/sites?q=1");
    expect(appPath("/artifact-site/api/sites")).toBe("/artifact-site/api/sites");
    expect(appPath("/")).toBe("/artifact-site/");
    expect(appPath("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(appPath("//cdn.example/a.png")).toBe("//cdn.example/a.png");
    expect(appPath("#section")).toBe("#section");
  });
  it("redacts artifact identifiers in subpath analytics", () => {
    setup();
    expect(analyticsPage("https://new.example/artifact-site/v/secret?passcode=secret")).toEqual({page_location:"https://new.example/artifact-site/v/shared",page_title:"Shared artifact",page_type:"share"});
  });
  it("prefixes API requests without changing their body or external destinations", async () => {
    setup(); const fetch = vi.fn().mockResolvedValue(new Response("ok")); vi.stubGlobal("fetch", fetch);
    const init = {method:"POST", body:"payload"};
    await appFetch("/api/sites", init);
    expect(fetch).toHaveBeenCalledWith("/artifact-site/api/sites", init);
    await appFetch("https://other.example/api", init);
    expect(fetch).toHaveBeenLastCalledWith("https://other.example/api", init);
  });
});


describe("reserved deployment prefixes", () => {
  it.each(["api", "s", "oauth", "me", "v", "brand", "vendor", "_next"])("refuses /%s and nested mounts beneath it at boot", segment => {
    for (const mount of [`/${segment}`, `/${segment}/nested`]) {
      vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
      vi.stubEnv("ARTIFACT_PUBLIC_URL", `https://new.example${mount}`);
      expect(describeRuntime().errors.join(" ")).toMatch(/reserved application route/);
    }
  });
});


it("keeps every route and public directory reserved as the application grows", () => {
  for (const directory of ["src/app", "public"]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) {
        expect(reserved).toContain(entry.name);
        expect(() => validateBasePath(`/${entry.name}`)).toThrow(/reserved/);
      }
    }
  }
  for (const mount of ["", "/artifact-site", "/tools/artifact-site", "/api-tools"]) expect(() => validateBasePath(mount)).not.toThrow();
});
