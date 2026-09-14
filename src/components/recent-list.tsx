"use client";

// The full "Recently viewed" shelf on /me: every site this browser has opened (the store keeps 50),
// newest first, in the same rows as the site lists. History is the browser's, not the account's:
// a row can be removed from it, the whole shelf cleared, and neither touches the site itself.
import Link from "next/link";
import MoreMenu from "@/components/more-menu";
import { kindLabel } from "@/components/artifact-card";
import { VisibilityCell } from "@/components/my-sites";
import type { RecentShelf } from "@/components/recent-sites";
import { useLocale, useT } from "@/components/locale-provider";
import { useSiteActions } from "@/lib/site-actions";
import { relTime } from "@/lib/rel-time";
import { countText } from "@/lib/i18n";

const NO_TOKENS: Readonly<Record<string, string | undefined>> = {};

export default function RecentList({ shelf }: { shelf: RecentShelf }) {
  const t = useT();
  const locale = useLocale();
  const { toast, copyLink } = useSiteActions(NO_TOKENS);

  if (shelf.items.length === 0) {
    return (
      <div className="empty">
        <h3>{t("No view history yet")}</h3>
        <p><Link href="/explore">{t("Open any site and it will show up here, easy to find next time you come back.")}</Link></p>
      </div>
    );
  }

  return (
    <>
      <div className="site-list">
        <div className="list-header"><span>{t("Site")}</span><span>{t("Who can open")}</span><span>{t("Versions")}</span><span>{t("Viewed")}</span><span /></div>
        {shelf.items.map(({ summary: s, visitedAt }) => (
          <div className="site-row" key={s.slug}>
            <div className="site-name">
              <Link href={`/s/${s.slug}`} className="mini" aria-hidden="true" tabIndex={-1}>
                <iframe src={`/api/preview/${s.slug}?thumb=1`} title="" loading="lazy" tabIndex={-1} inert sandbox="" />
              </Link>
              <div>
                <strong><Link href={`/s/${s.slug}`}>{s.title}</Link></strong>
                <small>{kindLabel(s.kind, t)}{s.takenDownAt ? ` · ${t("Taken down")}` : ""}</small>
              </div>
            </div>
            <span className="row-visibility"><VisibilityCell site={s} t={t} /></span>
            <span>{s.versionCount}</span>
            <span className="row-date">{relTime(visitedAt, t, locale)}</span>
            <span className="row-menu-wrap">
              <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly buttonClassName="row-more" buttonContent="⋯">
                <Link role="menuitem" className="menu-item" href={`/s/${s.slug}`}>{t("Open")}</Link>
                <button type="button" role="menuitem" className="menu-item" onClick={() => void copyLink(s.slug)}>{t("Copy link")}</button>
                <button type="button" role="menuitem" className="menu-item" onClick={() => shelf.remove(s.slug)}>{t("Remove from history")}</button>
              </MoreMenu>
            </span>
          </div>
        ))}
      </div>
      <div className="list-end"><span>{countText(t, shelf.items.length, "{n} site", "{n} sites")}</span></div>
      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}
