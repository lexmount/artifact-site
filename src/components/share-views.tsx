"use client";
// View log — who, when, and through which door (a share link, or the direct /s/ address), newest first.
//
// Collapsed by default, fetching only on expand: the vast majority of the time the share panel is
// opened to send a link, not to check up on people, and on a widely forwarded link this list can be
// long. Each expand is one request; collapsing and expanding again re-fetches — the question is
// inherently "who has seen it as of now", and caching would only mislead.
//
// The first row after expanding is the summary (opens / visitors / last open in the past 7 days),
// defined as "anyone other than me and collaborators" — it answers "is anyone else looking", and
// counting your own refreshes would only answer with noise. The detail rows below stay unfiltered: an
// audit list that silently drops your own rows is lying.
//
// Anonymous reading is this product's established semantics (having the link means you can view), so a "signed-out visit" is a normal row, not an anomaly.
import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import {
  errorText, readViews, readViewsSummary, relTime, viaLabel, viewerLabel,
  type ShareListItem, type ShareViewRow, type ViewsSummary,
} from "@/components/share-model";

export default function ShareViews({ slug, shares, icon }: {
  slug: string;
  /** Used to translate a shareId into its note/policy — the records carry only the id, and an id on its own says nothing. */
  shares: ReadonlyArray<ShareListItem>;
  icon?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<ShareViewRow[] | null>(null);
  const [summary, setSummary] = useState<ViewsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reference instant for "N minutes ago" is THE MOMENT OF FETCHING, not of rendering: calling
  // Date.now() during render is impure (react-hooks/purity blocks it), and every re-render would make
  // the times quietly jump.
  const [asOf, setAsOf] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/views`, { cache: "no-store" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, t("Failed to load view history")));
      // Newest first: the most recent visit is the most informative. The server may already sort; we do not rely on it.
      setViews(readViews(body).slice().sort((a, b) => b.viewedAt - a.viewedAt));
      setSummary(readViewsSummary(body));
      setAsOf(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load view history"));
      setViews([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  return (
    <div className="share-views">
      <button type="button" className="share-views-toggle" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {icon}
        {t("View history")}
      </button>

      {open && (
        <div className="share-views-body">
          {loading && <p className="drawer-note"><Loader2 size={13} className="spin" /> {t("Loading…")}</p>}
          {error && <p className="share-error" role="alert">{error}</p>}
          {summary != null && !loading && (
            <p className="share-views-summary">
              {t("Last {days} days:", { days: Math.round(summary.windowMs / 86_400_000) })} <b>{summary.opens}</b> {t("opens")}
              · <b>{summary.uniqueViewers}</b> {t("visitors")}
              {summary.lastViewedAt != null && <> · {t("last {when}", { when: relTime(summary.lastViewedAt, asOf, t, locale) })}</>}
              <span className="share-views-summary-note">{t("Not counting opens by you and your collaborators")}</span>
            </p>
          )}
          {views != null && views.length === 0 && !loading && <p className="share-hint">{t("Nobody has opened it yet — via a share link or the site address.")}</p>}
          {views != null && views.length > 0 && (
            <ul className="share-view-list">
              {views.map((v, i) => (
                <li key={`${v.shareId ?? "direct"}:${v.viewedAt}:${i}`}>
                  <span className="share-view-who">{viewerLabel(v, t)}</span>
                  <span className="share-view-when">{relTime(v.viewedAt, asOf, t, locale)}</span>
                  <span className="share-view-via">{v.shareId == null ? t("Opened directly") : t("via \"{share}\"", { share: viaLabel(v, shares, t) })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
