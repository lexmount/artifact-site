import type { Metadata } from "next";
import type { Locale } from "@/lib/i18n";

const SOCIAL_IMAGE_PATH = "/brand/artifact-site-social.png";

const ogLocale: Record<Locale, string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
};

/** Metadata shared only by the platform's public marketing pages. Artifact viewers provide their
 * own policy-aware metadata and must never inherit this banner or marketing copy. */
export function marketingMetadata({
  base,
  path,
  locale,
  title,
  description,
}: {
  base: string;
  path: string;
  locale: Locale;
  title: string;
  description: string;
}): Metadata {
  const url = new URL(path, `${base}/`).toString();
  const image = new URL(SOCIAL_IMAGE_PATH, `${base}/`).toString();

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: "artifact-site",
      title,
      description,
      url,
      locale: ogLocale[locale],
      images: [{ url: image, width: 2000, height: 1000, alt: "artifact-site" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
