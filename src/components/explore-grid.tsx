"use client";

// The public directory receives one server-filtered page and keeps search/sort/page in the URL.
import { useDirectoryNavigation } from "@/lib/use-directory-navigation";
import type { DirectoryPage } from "@/lib/directory-query";
import { useState } from "react";
import { Search } from "lucide-react";
import type { SiteSummary } from "@/lib/types";
import ArtifactCard from "@/components/artifact-card";
import { useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

export default function ExploreGrid({ sites, directory }: { sites: SiteSummary[]; directory?: DirectoryPage }) {
  const t = useT();
  const navigation=useDirectoryNavigation();
  const [localQ, setQ] = useState("");
  const q = directory ? navigation.search : localQ;
  const query = q.trim().toLowerCase();
  const shown = directory ? sites : query ? sites.filter((s) => s.title.toLowerCase().includes(query)) : sites;
  return (
    <>
      <div className="work-tools">
        <label className="searchbox">
          <Search size={16} aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => {setQ(e.target.value);if(directory)navigation.change("q",e.target.value,250);}} placeholder={t("Search site titles")} aria-label={t("Search site titles")} />
        </label>
        <select aria-label={t("Sort")} value={directory?.query.sort ?? "updated"} onChange={e=>navigation.change("sort",e.target.value)}><option value="updated">{t("Recently updated")}</option><option value="title">{t("Title A–Z")}</option></select>
        <span className="tools-count" aria-live="polite">{countText(t, directory?.total ?? shown.length, "{n} site", "{n} sites")}</span>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          <h3>{query ? t("No site matches “{q}”", { q: query }) : t("Nothing public yet")}</h3>
          <p>{query ? <button type="button" className="quiet" onClick={() => {setQ("");if(directory)navigation.change("q","");}}>{t("Clear the search")}</button> : t("Public sites appear here as soon as someone publishes one.")}</p>
        </div>
      ) : (
        <div className="result-grid" aria-busy={navigation.pending}>
          {shown.map((s) => <ArtifactCard key={s.slug} site={s} />)}
        </div>
      )}
      {directory && directory.total > 12 && <div className="pager">
        <button className="quiet" disabled={directory.query.page===0 || navigation.pending} onClick={()=>navigation.change("page",directory.query.page-1)}>{t("Previous")}</button>
        <span>{directory.query.page+1} / {Math.ceil(directory.total/12)}</span>
        <button className="quiet" disabled={(directory.query.page+1)*12>=directory.total || navigation.pending} onClick={()=>navigation.change("page",directory.query.page+1)}>{t("Next")}</button>
      </div>}
    </>
  );
}
