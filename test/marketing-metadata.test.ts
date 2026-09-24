import { afterEach, describe, expect, it, vi } from "vitest";
import { marketingMetadata } from "@/lib/marketing-metadata";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const requestHeaders = vi.hoisted(() => ({ current: new Headers({ host: "localhost:4300" }) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

afterEach(() => {
  delete process.env.ARTIFACT_PUBLIC_URL;
  requestHeaders.current = new Headers({ host: "localhost:4300" });
});

describe("marketing metadata", () => {
  it("builds complete absolute Open Graph and Twitter cards", () => {
    const metadata = marketingMetadata({
      base: "https://artifacts.example.net",
      path: "/explore",
      locale: "zh-CN",
      title: "发现作品",
      description: "公开作品",
    });

    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "artifact-site",
      title: "发现作品",
      description: "公开作品",
      url: "https://artifacts.example.net/explore",
      locale: "zh_CN",
      images: [{ url: "https://artifacts.example.net/brand/artifact-site-social.png" }],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "发现作品",
      description: "公开作品",
      images: ["https://artifacts.example.net/brand/artifact-site-social.png"],
    });
  });
});

describe("crawler routes", () => {
  it("uses the configured public origin and excludes private application routes", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://artifacts.example.net/";
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

    expect(result.sitemap).toBe("https://artifacts.example.net/sitemap.xml");
    expect(rules.allow).toEqual(["/", "/explore", "/for-agents"]);
    expect(rules.disallow).toEqual(expect.arrayContaining(["/me", "/admin", "/api/", "/oauth/"]));
    expect(rules.disallow).not.toEqual(expect.arrayContaining(["/s/", "/v/"]));
    expect((await sitemap()).map((entry) => entry.url)).toEqual([
      "https://artifacts.example.net/",
      "https://artifacts.example.net/explore",
      "https://artifacts.example.net/for-agents",
    ]);
  });

  it("uses the request origin for an unconfigured self-hosted instance", async () => {
    requestHeaders.current = new Headers({ host: "artifacts.internal:8443", "x-forwarded-proto": "https" });
    expect((await robots()).sitemap).toBe("https://artifacts.internal:8443/sitemap.xml");
    expect((await sitemap())[0].url).toBe("https://artifacts.internal:8443/");
  });
});
