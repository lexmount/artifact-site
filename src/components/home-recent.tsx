"use client";

// The home page's one site module: what this browser opened recently — or, before there is any
// history, the newest public sites, so a first visit is not an empty page. One structure for both
// states; the heading and the "view all" destination are the only difference.
import Link from "next/link";
import type { SiteSummary } from "@/lib/types";
import ArtifactCard from "@/components/artifact-card";
import { useRecentShelf } from "@/components/recent-sites";
import { useLocale, useT } from "@/components/locale-provider";
import { relTime } from "@/lib/rel-time";

const SHOWN = 6;

export default function HomeRecent({ allSites }: { allSites: SiteSummary[] }) {
  const t = useT();
  const locale = useLocale();
  const shelf = useRecentShelf(allSites);
  const recent = shelf.items.slice(0, SHOWN);
  const fallback = allSites.filter((s) => s.visibility === "public" && !s.takenDownAt).slice(0, SHOWN);
  const showRecent = recent.length > 0;
  const items = showRecent ? recent.map((r) => r.summary) : fallback;

  return (
    <section className="home-sites" aria-label={showRecent ? t("Recently viewed") : t("Public sites")}>
      <div className="section-head">
        <h2>{showRecent ? t("Recently viewed") : t("Public sites")}</h2>
        <Link href={showRecent ? "/me?tab=recent" : "/explore"}>{showRecent ? t("All history →") : t("Explore →")}</Link>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <h3>{t("Nothing published yet")}</h3>
          <p>{t("Upload something above; the link is yours within seconds.")}</p>
        </div>
      ) : (
        <div className="recent-grid">
          {items.map((s, i) => (
            <ArtifactCard key={s.slug} site={s} note={showRecent ? t("Viewed {when}", { when: relTime(recent[i].visitedAt, t, locale) }) : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}
