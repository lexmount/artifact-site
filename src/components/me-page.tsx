"use client";

// /me — the person's own sites: title and the upload action, two scopes (created by me / I can
// edit), the folder rail and list, and the low-frequency account tools (publish tokens)
// behind one menu instead of two more tabs.
//
// Signed out — an anonymous creator, or every visitor on a deployment with no identity provider —
// the page still lists the sites THIS BROWSER created: the owner tokens in local storage, matched
// against the server's list (which the server page resolved for this viewer, so the browser's own
// unlisted and private sites are in it). That list is the only index an anonymous creator has, and
// the product looked exactly like this before identity existed; identity only adds to it.
import AppShell from "@/components/app-shell";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import PublishTokensCard from "@/components/publish-tokens";
import MySites from "@/components/my-sites";
import RecentList from "@/components/recent-list";
import { useRecentShelf } from "@/components/recent-sites";
import MoreMenu from "@/components/more-menu";
import { useT } from "@/components/locale-provider";
import { loginHref, useAuth } from "@/lib/use-auth";
import type { SiteSummary } from "@/lib/types";
import { NO_SLUGS, mergeMySites, useOwnerSlugs } from "@/lib/my-sites";

type TabId = "owned" | "collab" | "recent" | "tokens";

const subscribeNever = () => () => {};

/** The home page's "All history →" lands on the recent tab: /me?tab=recent. */
function useWantsRecent(): boolean {
  return useSyncExternalStore(subscribeNever, () => new URLSearchParams(window.location.search).get("tab") === "recent", () => false);
}

export default function MePage({ allSites }: { allSites: SiteSummary[] }) {
  const t = useT();
  const { user, oidcEnabled, loading } = useAuth();
  // The anonymous half: what this browser created, filtered to what the server still lists.
  const browserSlugs = useOwnerSlugs();
  const mine = useMemo(() => mergeMySites(allSites, browserSlugs, NO_SLUGS), [allSites, browserSlugs]);
  const [data, setData] = useState<{ owned: SiteSummary[]; collaborating: SiteSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<TabId | null>(null);
  const wantsRecent = useWantsRecent();
  const tab: TabId = picked ?? (wantsRecent ? "recent" : "owned");
  // Every browser has a view history, signed in or not — the third tab is the same for both.
  const shelf = useRecentShelf(allSites);
  const clearHistory = () => { if (window.confirm(t("Clear your view history? The sites themselves are not affected."))) shelf.clear(); };


  const load = useCallback(() => {
    if (!user) return;
    fetch("/api/me/sites")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error ?? t("Failed to load")))))
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [user, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Every owned card gets the manage actions — this list IS the account's ownership, verbatim.
  const ownedSlugs = useMemo(() => new Set((data?.owned ?? []).map((s) => s.slug)), [data]);

  return (
    <AppShell>
      {loading && <p className="page-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}

      {!loading && !user && (
        <>
          <div className="work-title">
            <h1>{t("My sites")}</h1>
            <Link className="primary" href="/"><ArrowUp size={16} aria-hidden="true" /> {t("Upload")}</Link>
          </div>
          <div className="work-tabs" role="tablist" aria-label={t("Account views")}>
            <button type="button" role="tab" id="me-tab-browser" aria-controls="me-panel" aria-selected={tab !== "recent"} onClick={() => setPicked("owned")}>
              {t("Created in this browser")} · {mine.length}
            </button>
            <button type="button" role="tab" id="me-tab-recent" aria-controls="me-panel" aria-selected={tab === "recent"} onClick={() => setPicked("recent")}>
              {t("Recently viewed")} · {shelf.items.length}
            </button>
            <span className="work-tabs-tools">
              {tab === "recent"
                ? shelf.items.length > 0 && <button type="button" className="quiet" onClick={clearHistory}>{t("Clear history")}</button>
                /* Identity is an addition, never a wall: the sign-in offer sits beside the list, and only where an IdP exists. */
                : oidcEnabled && <a className="quiet" href={loginHref("/me")}>{t("Sign in to see your sites on every device")}</a>}
            </span>
          </div>
          <div role="tabpanel" id="me-panel" aria-labelledby={tab === "recent" ? "me-tab-recent" : "me-tab-browser"}>
            {/* No onMutated: the list is the server page's prop, and useSiteActions already calls router.refresh() after a delete or rename. */}
            {tab === "recent" ? <RecentList shelf={shelf} /> : <MySites sites={mine} />}
          </div>
        </>
      )}

      {user && (
        <>
          <div className="work-title">
            <h1>{t("My sites")}</h1>
            <Link className="primary" href="/"><ArrowUp size={16} aria-hidden="true" /> {t("Upload")}</Link>
          </div>
          <div className="work-tabs" role="tablist" aria-label={t("Account views")}>
            <button type="button" role="tab" id="me-tab-owned" aria-controls="me-panel" aria-selected={tab === "owned"} onClick={() => setPicked("owned")}>
              {t("Created by me")}{data ? ` · ${data.owned.length}` : ""}
            </button>
            <button type="button" role="tab" id="me-tab-collab" aria-controls="me-panel" aria-selected={tab === "collab"} onClick={() => setPicked("collab")}>
              {t("I can edit")}{data ? ` · ${data.collaborating.length}` : ""}
            </button>
            <button type="button" role="tab" id="me-tab-recent" aria-controls="me-panel" aria-selected={tab === "recent"} onClick={() => setPicked("recent")}>
              {t("Recently viewed")} · {shelf.items.length}
            </button>
            <span className="work-tabs-tools">
              {tab === "recent" && shelf.items.length > 0 && <button type="button" className="quiet" onClick={clearHistory}>{t("Clear history")}</button>}
              {/* Publish tokens are kept in the account tools menu. */}
              <MoreMenu label={t("Account tools")} buttonClassName="quiet" buttonContent={<>{t("Account tools")} ⌄</>}>
                <button type="button" role="menuitem" className="menu-item" data-active={tab === "tokens"} onClick={() => setPicked("tokens")}>{t("Publish tokens")}</button>
              </MoreMenu>
            </span>
          </div>

          <div role="tabpanel" id="me-panel" aria-labelledby={tab === "owned" || tab === "collab" || tab === "recent" ? `me-tab-${tab}` : undefined} aria-label={tab === "tokens" ? t("Publish tokens") : undefined}>
            {error && <p className="page-note error" role="alert">{error}</p>}
            {(tab === "owned" || tab === "collab") && !data && !error && (
              <p className="page-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>
            )}
            {/* onMutated: a delete must re-run load(), or the row just sits there looking not deleted. */}
            {tab === "owned" && data && <MySites sites={data.owned} serverOwned={ownedSlugs} onMutated={load} />}
            {/* Collaborations: the same list, every row editable (the server vetted the collaboration),
                but a collaborator's actions stop at editing — renaming, sharing and deleting settle
                with the owner, so the menu offers none of them. */}
            {tab === "collab" && data && <MySites sites={data.collaborating} serverOwned={ownedSlugs} onMutated={load} manage={false} editable />}
            {tab === "recent" && <RecentList shelf={shelf} />}
            {tab === "tokens" && <div className="account-tool"><PublishTokensCard /></div>}
          </div>
        </>
      )}
    </AppShell>
  );
}
