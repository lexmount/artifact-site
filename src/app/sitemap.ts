import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { resolvePublicBase } from "@/lib/publish-skill";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = resolvePublicBase(await headers());
  return [
    { url: `${base}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/explore`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/for-agents`, changeFrequency: "monthly", priority: 0.7 },
  ];
}
