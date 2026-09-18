"use client";
import Link from "next/link";
import { useState, type KeyboardEvent } from "react";
import type { SiteSummary } from "@/lib/types";
import ArtifactCard from "@/components/artifact-card";
import { useRecentShelf } from "@/components/recent-sites";
import { useLocale, useT } from "@/components/locale-provider";
import { relTime } from "@/lib/rel-time";

const SHOWN = 6;
export default function HomeRecent({ allSites, ownedSites = [] }: { allSites: SiteSummary[]; ownedSites?: SiteSummary[] }) {
  const t = useT();
  const locale = useLocale();
  const shelf = useRecentShelf(allSites);
  const [tab, setTab] = useState<"recent" | "updated">("recent");
  const recent = shelf.items.slice(0, SHOWN);
  const updated = tab === "updated";
  const fallback = allSites.filter(s => s.visibility === "public" && !s.takenDownAt).slice(0, SHOWN);
  const showRecent = !updated && recent.length > 0;
  const items = updated ? ownedSites.slice(0, SHOWN) : showRecent ? recent.map(r => r.summary) : fallback;
  const ready = updated || shelf.ready;
  function switchWithKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? "recent" : e.key === "End" ? "updated" : updated ? "recent" : "updated";
    setTab(next);
    document.getElementById(`home-tab-${next}`)?.focus();
  }
  return (
    <section className="home-sites" aria-label={t("Your sites")}>
      <div className="section-head">
        <div className="work-tabs home-site-tabs" role="tablist" aria-label={t("Your sites")}>
          {(["recent", "updated"] as const).map(id => <button key={id} type="button" role="tab"
            id={`home-tab-${id}`} aria-controls="home-sites-panel" aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1} onKeyDown={switchWithKey} onClick={() => setTab(id)}>
            {t(id === "recent" ? "Recently viewed" : "Recently updated")}
          </button>)}
        </div>
        {ready && <Link href={updated ? "/me" : showRecent ? "/me?tab=recent" : "/explore"}>
          {t(updated ? "All my sites →" : showRecent ? "All history →" : "Explore →")}
        </Link>}
      </div>
      <div id="home-sites-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`} aria-busy={!ready}>
        <p className="drawer-note">{t(updated ? "Your sites, newest updates first." : "Only in this browser. Up to 50 sites.")}</p>
        {!ready ? <div className="home-sites-loading" role="status">{t("Loading…")}</div>
          : items.length === 0 ? <div className="empty">
            <h3>{t(updated ? "No sites of your own yet" : "Nothing published yet")}</h3>
            <p>{t("Upload something above; the link is yours within seconds.")}</p>
          </div> : <>
            {!updated && !showRecent && <p className="drawer-note">{t("No view history yet. Explore public sites below.")}</p>}
            <div className="recent-grid">{items.map((s, i) => <ArtifactCard key={s.slug} site={s}
              href={showRecent ? recent[i].href : undefined} preview={showRecent ? recent[i].preview : undefined}
              note={updated ? t("Updated {when}", { when: relTime(s.updatedAt, t, locale) })
                : showRecent ? t("Viewed {when}", { when: relTime(recent[i].visitedAt, t, locale) }) : undefined} />)}</div>
          </>}
      </div>
    </section>
  );
}
