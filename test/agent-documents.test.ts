import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as agentsGET } from "@/app/AGENTS.md/route";
import { GET as indexGET } from "@/app/llms.txt/route";
import { GET as guideGET } from "@/app/for-agents.md/route";
import { DEFAULT_BASE, resolvePublicBase } from "@/lib/publish-skill";

afterEach(() => vi.unstubAllEnvs());

const documents = [
  { path: "/AGENTS.md", get: agentsGET, type: "text/markdown", title: "# Using artifact-site" },
  { path: "/llms.txt", get: indexGET, type: "text/plain", title: "# artifact-site" },
  { path: "/for-agents.md", get: guideGET, type: "text/markdown", title: "---\nname:" },
];

describe.each(["", "/artifact-site", "/tools/artifact-site"])("anonymous agent documents at %s", (mount) => {
  it.each(documents)("serves $path with canonical links and no authentication", async ({ path, get, type, title }) => {
    const base = `https://docs.example.net${mount}`;
    vi.stubEnv("ARTIFACT_PUBLIC_URL", base);
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    vi.stubEnv("ARTIFACT_CREATE_POLICY", "login");
    vi.stubEnv("ARTIFACT_OIDC_ISSUER", "https://login.example.net");
    const response = await get(new Request(`http://internal:4300${mount}${path}`, {
      headers: { host: "internal:4300", "x-forwarded-proto": "http", "accept-language": "zh-CN" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`${type}; charset=utf-8`);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("host");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("x-forwarded-proto");
    const body = await response.text();
    expect(body.startsWith(title)).toBe(true);
    expect(body).toContain(base);
    expect(body).not.toMatch(/\{\{BASE_URL\}\}|artifact-site\.example\.com|internal:4300/);
    if (path !== "/for-agents.md") {
      const links = [...body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(match => match[1]);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.startsWith(`${base}/`)).toBe(true);
      expect(body).toContain(`${base}/for-agents.md`);
      expect(body).not.toMatch(/Signed-off-by|npm test|CONTRIBUTING/);
    }
  });

  it("retains the compiled mount when deriving the base from trusted proxy headers", () => {
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    for (const proto of ["https", "http"]) {
      expect(resolvePublicBase(new Headers({ host: "docs.example.net:8443", "x-forwarded-proto": `${proto}, http` })))
        .toBe(`${proto}://docs.example.net:8443${mount}`);
    }
  });

  it("never substitutes a missing or malformed Host into a document", () => {
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    for (const host of ["", "evil.example/path", "user@evil.example", 'evil"><script>']) {
      expect(resolvePublicBase(new Headers({ host }))).toBe(`${DEFAULT_BASE}${mount}`);
    }
  });

  it.each(documents)("rebases $path per request without caching another host or scheme", async ({ path, get }) => {
    vi.stubEnv("ARTIFACT_PUBLIC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACT_BASE_PATH", mount);
    for (const [host, proto] of [["one.example.net", "https"], ["two.example.net", "http"]]) {
      const base = `${proto}://${host}${mount}`;
      const response = await get(new Request(`${base}${path}`, { headers: { host, "x-forwarded-proto": proto } }));
      const body = await response.text();
      expect(body).toContain(base);
      expect(body).not.toContain(DEFAULT_BASE);
    }
  });
});

it("rejects unsafe configured public URLs instead of putting markup or credentials in documentation", () => {
  for (const base of ["https://user:secret@example.net", "javascript:alert(1)", "https://example.net/?q=secret", "https://example.net/#fragment"]) {
    vi.stubEnv("ARTIFACT_PUBLIC_URL", base);
    expect(() => resolvePublicBase(new Headers({ host: "docs.example.net" }))).toThrow();
  }
});
