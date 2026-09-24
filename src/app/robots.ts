import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { resolvePublicBase } from "@/lib/publish-skill";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = resolvePublicBase(await headers());
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/explore", "/for-agents"],
      disallow: [
        "/me",
        "/admin",
        "/notifications",
        "/tenants",
        "/activate",
        "/api/",
        "/oauth/",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
