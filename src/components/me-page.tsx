"use client";

import { appPath } from "@/lib/app-path";
// /me — the person's own sites: title and the upload action, two scopes (created by me / I can
// edit), the folder rail and list, and the low-frequency account tools (publish tokens, the
// applications connected through OAuth) behind one menu instead of more tabs.
//
// Signed out — an anonymous creator, or every visitor on a deployment with no identity provider —
// the page still lists the sites THIS BROWSER created: the owner tokens in local storage, matched
// against the server's list (which the server page resolved for this viewer, so the browser's own
// unlisted and private sites are in it). That list is the only index an anonymous creator has, and
// the product looked exactly like this before identity existed; identity only adds to it.
import { useRouter, useSearchParams } from "next/navigation";
import type { DirectoryPage } from "@/lib/directory-query";
import { adminFetch } from "@/components/admin/format";
import AppShell from "@/components/app-shell";
import Link from "next/link";
import { useCallback, useMemo, useEffect, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import PublishTokensCard from "@/components/publish-tokens";
import ConnectedAppsCard from "@/components/connected-apps";
import MySites from "@/components/my-sites";
import RecentList from "@/components/recent-list";
import { useRecentShelf } from "@/components/recent-sites";
import MoreMenu from "@/components/more-menu";
import { useT } from "@/components/locale-provider";
import { loginHref, useAuth } from "@/lib/use-auth";
import type { SiteSummary } from "@/lib/types";
import { NO_SLUGS, mergeMySites, useOwnerSlugs } from "@/lib/my-sites";

type TabId = "owned" | "collab" | "recent" | "tokens" | "connections";

type AccountLookup<T> = { userId: string; status: "loading" | "error" | "success"; value?: T };

// Each lookup owns its retry and result. A failed request must not erase another
// lookup's successful result, or expose data from a previously signed-in account.
function useAccountLookup<T>(userId: string | undefined, fetchValue: () => Promise<T>) {
  const [result, setResult] = useState<AccountLookup<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    fetchValue().then(value => {
      if (alive) setResult({ userId, status: "success", value });
    }, () => {
      if (alive) setResult(previous => ({ userId, status: "error", value: previous?.userId === userId ? previous.value : undefined }));
    });
    return () => { alive = false; };
  }, [userId, attempt, fetchValue]);
  const current = result?.userId === userId ? result : null;
  const retry = () => {
    if (!userId) return;
    setResult({ userId, status: "loading", value: current?.value });
    setAttempt(value => value + 1);
  };
  return { status: current?.status ?? "loading", value: current?.value, retry };
}

async function loadTenantManager() {
  const { tenants } = await adminFetch<{ tenants: { id: string; role: string; disabledAt: number | null }[] }>("/api/tenants");
  return tenants.some(x => x.id !== "anonymous" && !x.disabledAt && x.role === "admin");
}
async function loadUnclaimedCount() {
  return (await adminFetch<{ sites: unknown[] }>("/api/me/adopt")).sites.length;
}

export default function MePage({ allSites, directory, userId }: { allSites: SiteSummary[]; directory?: DirectoryPage; userId?: string }) {
  const t = useT();
  const auth = useAuth();
  const user = auth.loading && userId ? {id:userId} : auth.user;
  const {oidcEnabled} = auth;
  const tenantAccess = useAccountLookup(user?.id, loadTenantManager);
  const unclaimed = useAccountLookup(user?.id, loadUnclaimedCount);
  const loading = auth.loading && !userId;
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") ?? "owned") as TabId;
  const setPicked = (tab: TabId) => router.push(`/me?tab=${tab}`, {scroll:false});
  const browserSlugs = useOwnerSlugs();
  const mine = useMemo(() => mergeMySites(allSites, browserSlugs, NO_SLUGS), [allSites, browserSlugs]);
  const load = useCallback(() => router.refresh(), [router]);
  // Every browser has a view history, signed in or not — the third tab is the same for both.
  const shelf = useRecentShelf(allSites);
  const clearHistory = () => { if (window.confirm(t("Clear your view history? The sites themselves are not affected."))) shelf.clear(); };


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
                : oidcEnabled && <a className="quiet" href={appPath(loginHref(typeof window === "undefined" ? "/me" : `/me${window.location.search}`))}>{t("Sign in to see your sites on every device")}</a>}
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
              {t("Created by me")}{directory?.query.scope === "owned" ? ` · ${directory.counts.all}` : ""}
            </button>
            <button type="button" role="tab" id="me-tab-collab" aria-controls="me-panel" aria-selected={tab === "collab"} onClick={() => setPicked("collab")}>
              {t("I can edit")}{directory?.query.scope === "collab" ? ` · ${directory.counts.all}` : ""}
            </button>
            <button type="button" role="tab" id="me-tab-recent" aria-controls="me-panel" aria-selected={tab === "recent"} onClick={() => setPicked("recent")}>
              {t("Recently viewed")} · {shelf.items.length}
            </button>
            <span className="work-tabs-tools">
              {tab === "recent" && shelf.items.length > 0 && <button type="button" className="quiet" onClick={clearHistory}>{t("Clear history")}</button>}
              {/* Publish tokens are kept in the account tools menu. */}
              <Link href="/me/sharing" className="quiet">{t("Sharing preferences")}</Link>
              <MoreMenu label={t("Account tools")} buttonClassName="quiet" buttonContent={<>{t("Account tools")} ⌄</>}>
                {auth.isAdmin ? <Link role="menuitem" className="menu-item" href="/admin/tenants">{t("Tenant management")}</Link> : tenantAccess.value && <Link role="menuitem" className="menu-item" href="/tenants">{t("Tenant settings")}</Link>}
                <button type="button" role="menuitem" className="menu-item" data-active={tab === "tokens"} onClick={() => setPicked("tokens")}>{t("Publish tokens")}</button>
                <button type="button" role="menuitem" className="menu-item" data-active={tab === "connections"} onClick={() => setPicked("connections")}>{t("Connected applications")}</button>
              </MoreMenu>
            </span>
          </div>

          {([
            { key: "tenants", lookup: tenantAccess, message: t("Could not load tenant settings access."), retryLabel: t("Retry tenant settings access"), visible: !auth.isAdmin },
            { key: "claims", lookup: unclaimed, message: t("Could not check for unclaimed artifacts."), retryLabel: t("Retry checking unclaimed artifacts"), visible: true },
          ]).map(({ key, lookup, message, retryLabel, visible }) => visible && lookup.status !== "success" && (
            <p key={key} className="account-lookup-notice" data-account-lookup={key} role={lookup.status === "error" ? "alert" : "status"}>
              <span>{lookup.status === "error" ? message : key === "tenants" ? t("Checking tenant settings access…") : t("Checking for unclaimed artifacts…")}</span>
              {lookup.status === "error" && <button type="button" className="btn sm" aria-label={retryLabel} onClick={lookup.retry}>{t("Try again")}</button>}
            </p>
          ))}
          {Boolean(unclaimed.value) && <p className="account-claim-notice"><Link href="/me/claim">{t("Add browser-created artifacts to my account")}</Link><span>{t("{n} artifacts available", { n: unclaimed.value! })}</span></p>}
          <div role="tabpanel" id="me-panel" aria-labelledby={tab === "owned" || tab === "collab" || tab === "recent" ? `me-tab-${tab}` : undefined} aria-label={tab === "tokens" ? t("Publish tokens") : tab === "connections" ? t("Connected applications") : undefined}>
            {(tab === "owned" || tab === "collab") && directory && <MySites key={directory.query.scope} sites={directory.sites} directory={directory} userId={userId} onMutated={load} manage={tab === "owned"} />}
            {tab === "recent" && <RecentList shelf={shelf} />}
            {tab === "tokens" && <div className="account-tool"><PublishTokensCard /></div>}
            {tab === "connections" && <div className="account-tool"><ConnectedAppsCard /></div>}
          </div>
        </>
      )}
    </AppShell>
  );
}
