"use client";

// The public directory: a title search over the cards. Filtering is local — the list is what the
// server already decided this viewer may see; the count is always the filtered count.
import { useState } from "react";
import { Search } from "lucide-react";
import type { SiteSummary } from "@/lib/types";
import ArtifactCard from "@/components/artifact-card";
import { useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

export default function ExploreGrid({ sites }: { sites: SiteSummary[] }) {
  const t = useT();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = query ? sites.filter((s) => s.title.toLowerCase().includes(query)) : sites;
  return (
    <>
      <div className="work-tools">
        <label className="searchbox">
          <Search size={16} aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search site titles")} aria-label={t("Search site titles")} />
        </label>
        <span className="tools-count" aria-live="polite">{countText(t, shown.length, "{n} site", "{n} sites")}</span>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          <h3>{query ? t("No site matches “{q}”", { q: query }) : t("Nothing public yet")}</h3>
          <p>{query ? <button type="button" className="quiet" onClick={() => setQ("")}>{t("Clear the search")}</button> : t("Public sites appear here as soon as someone publishes one.")}</p>
        </div>
      ) : (
        <div className="result-grid">
          {shown.map((s) => <ArtifactCard key={s.slug} site={s} />)}
        </div>
      )}
    </>
  );
}
