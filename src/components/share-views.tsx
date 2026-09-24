"use client";
// View log — who, when, and through which door (a share link, or the direct /s/ address), newest first.
//
// This is a peer tab in sharing settings and fetches fresh data when mounted.
//
// The first row in the tab is the summary (opens / visitors / last open in the past 7 days),
// defined as "anyone other than me and collaborators" — it answers "is anyone else looking", and
// counting your own refreshes would only answer with noise. The detail rows below stay unfiltered: an
// audit list that silently drops your own rows is lying.
//
// Anonymous reading is this product's established semantics (having the link means you can view), so a "signed-out visit" is a normal row, not an anomaly.
import { useCallback, useEffect, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import {
  errorText, readShares, readViews, readViewsSummary, relTime, viaLabel, viewerLabel,
  type ShareListItem, type ShareViewRow, type ViewsSummary,
} from "@/components/share-model";

export default function ShareViews({ slug }: { slug: string }) {
  const t = useT();
  const locale = useLocale();
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [views, setViews] = useState<ShareViewRow[] | null>(null);
  const [summary, setSummary] = useState<ViewsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showExclusion, setShowExclusion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reference instant for "N minutes ago" is THE MOMENT OF FETCHING, not of rendering: calling
  // Date.now() during render is impure (react-hooks/purity blocks it), and every re-render would make
  // the times quietly jump.
  const [asOf, setAsOf] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [res, sharesResponse] = await Promise.all([
        fetch(`/api/sites/${slug}/views`, { cache: "no-store", signal }),
        fetch(`/api/sites/${slug}/shares`, { cache: "no-store", signal }),
      ]);
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, t("Failed to load view history")));
      const sharesBody: unknown = sharesResponse.ok ? await sharesResponse.json().catch(() => ({})) : null;
      // Reading a response body can be aborted too; the JSON fallback must not
      // let an obsolete request publish state after effect cleanup.
      if (signal?.aborted) return;
      if (sharesResponse.ok) setShares(readShares(sharesBody));
      // Newest first: the most recent visit is the most informative. The server may already sort; we do not rely on it.
      setViews(readViews(body).slice().sort((a, b) => b.viewedAt - a.viewedAt));
      setSummary(readViewsSummary(body));
      setAsOf(Date.now());
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : t("Failed to load view history"));
      setViews([]);
      setSummary(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => { await load(controller.signal); })();
    return () => controller.abort();
  }, [load]);

  return (
    <div className="share-views">
        <p className="share-intro">{t("See external visits across share links and the site address.")}</p>
        <div className="share-views-body">
          {loading && <p className="drawer-note"><Loader2 size={13} className="spin" /> {t("Loading…")}</p>}
          {error && <p className="share-error" role="alert">{error}</p>}
          {summary != null && !loading && (
            <p className="share-views-summary">
              <span className="share-views-summary-title">
                {t("External opens in the last {days} days:", { days: Math.round(summary.windowMs / 86_400_000) })}
                <span className={`share-views-info${showExclusion ? " is-open" : ""}`}>
                  <button type="button" aria-label={t("About external visit data")} aria-expanded={showExclusion} aria-describedby={showExclusion ? "share-views-exclusion" : undefined}
                    onClick={() => setShowExclusion(open => !open)}
                    onKeyDown={(event) => { if (event.key === "Escape" && showExclusion) { event.stopPropagation(); setShowExclusion(false); } }}><Info size={13} aria-hidden="true" /></button>
                  {showExclusion && <span id="share-views-exclusion" className="share-views-tooltip" role="tooltip">{t("External visit data does not include opens by you and your collaborators")}</span>}
                </span>
              </span>
              <b>{summary.opens}</b> {t("opens")}
              · <b>{summary.uniqueViewers}</b> {t("visitors")}
              {summary.lastViewedAt != null && <> · {t("last {when}", { when: relTime(summary.lastViewedAt, asOf, t, locale) })}</>}
            </p>
          )}
          {views != null && views.length === 0 && !loading && <p className="share-hint">{t("Nobody has opened it yet — via a share link or the site address.")}</p>}
          {views != null && views.length > 0 && (
            <>
            <p className="drawer-note">{t("History includes your own and collaborators’ opens. Latest 200 records.")}</p>
            <ul className="share-view-list">
              {views.map((v, i) => (
                <li key={`${v.shareId ?? "direct"}:${v.viewedAt}:${i}`}>
                  <span className="share-view-who">{viewerLabel(v, t)}</span>
                  <span className="share-view-when">{relTime(v.viewedAt, asOf, t, locale)}</span>
                  <span className="share-view-via">{v.shareId == null ? t("Opened directly") : t("via \"{share}\"", { share: viaLabel(v, shares, t) })}</span>
                </li>
              ))}
            </ul>
            </>
          )}
        </div>
    </div>
  );
}
