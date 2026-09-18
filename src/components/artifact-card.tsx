"use client";

// A site as a picture with a caption: the live thumbnail, the title, one line of meta. The whole
// card is the link. Optional owner actions sit outside the navigation link.
import SiteLink from "@/components/site-link";
import type { ReactNode } from "react";
import type { SiteSummary } from "@/lib/types";
import { useLocale, useT } from "@/components/locale-provider";
import { relTime } from "@/lib/rel-time";

export function kindLabel(kind: SiteSummary["kind"], t: (k: string) => string): string {
  return kind === "single" ? t("Web page") : kind === "document" ? t("Document") : t("Site folder");
}

export default function ArtifactCard({ site, note, actions, href, preview }: { site: SiteSummary; note?: string; actions?: ReactNode; href?: string; preview?: string }) {
  const t = useT();
  const locale = useLocale();
  return (
    <article className="artifact-card">
      <SiteLink slug={site.slug} href={href ?? `/s/${site.slug}`} className="artifact-card-link" aria-label={t("Open {title}", { title: site.title })}>
        <div className="preview">
          {/* Same posture as the home grid's thumbnails: no scripts, not focusable, display only. */}
          <iframe src={preview ?? `/api/preview/${site.slug}?thumb=1`} title={t("{title} preview", { title: site.title })} loading="lazy" tabIndex={-1} inert sandbox="" aria-hidden="true" />
        </div>
        <p className="recent-title">{site.title}</p>
      </SiteLink>
      {actions && <div className="artifact-card-actions">{actions}</div>}
      {site.officialVersionId && <SiteLink slug={site.slug} className="official-pill" href={`/s/${site.slug}?version=${encodeURIComponent(site.officialVersionId)}`}>{t("Official v{n}", { n: site.officialVersionNumber ?? "" })}</SiteLink>}
      <p className="recent-meta">{kindLabel(site.kind, t)} · {note ?? relTime(site.updatedAt, t, locale)}</p>
    </article>
  );
}
