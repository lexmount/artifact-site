"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Folder, FileText, Search, Link2 } from "lucide-react";
import AppShell from "@/components/app-shell";
import { adminFetch } from "@/components/admin/format";
import { useT } from "@/components/locale-provider";
import { loginHref } from "@/lib/use-auth";
type Collection = {
  state: string;
  folders?: { id: string; name: string; count: number }[];
  name?: string;
  owner?: string;
  items: {
    slug: string;
    folderId: string | null;
    title: string;
    tenantName: string;
    updatedAt: number;
    comments: boolean;
  }[];
};
export default function CollectionPage({ token }: { token: string }) {
  const t = useT(),
    [data, setData] = useState<Collection | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const params = useSearchParams();
  const query = params.get("q") ?? "";
  const folders = data?.folders ?? [];
  const unfiled = data?.items.filter(s => !s.folderId).length ?? 0;
  const requestedFolder = params.get("folder") ?? "";
  const active = folders.length && (folders.some(f => f.id === requestedFolder) || (requestedFolder === "unfiled" && unfiled)) ? requestedFolder : "";
  function updateLocation(folder: string, search: string, replace = false) {
    const url = new URL(window.location.href);
    if (folder) url.searchParams.set("folder", folder); else url.searchParams.delete("folder");
    if (search) url.searchParams.set("q", search); else url.searchParams.delete("q");
    window.history[replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  }
  useEffect(() => {
    if (data?.state === "ready" && requestedFolder && requestedFolder !== active) {
      const url = new URL(window.location.href);
      url.searchParams.delete("folder");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, [data, requestedFolder, active]);
  const choices = [{ id: "", name: t("All sites"), count: data?.items.length ?? 0 }, ...(unfiled ? [{ id: "unfiled", name: t("Unfiled"), count: unfiled }] : []), ...folders];
  const selectedName = choices.find(f => f.id === active)?.name ?? t("All sites");
  const visibleItems = (data?.items ?? []).filter(s => (!active || (active === "unfiled" ? !s.folderId : s.folderId === active)) && s.title.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    let alive = true;
    adminFetch<Collection>(`/api/collections/${encodeURIComponent(token)}`)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [token, attempt]);
  return (
    <AppShell>
      <main className="collection-page">
        {error && (
          <p role="alert" className="drawer-error">
            {t("Could not load this collection.")} <button type="button" className="btn sm" onClick={() => { setError(""); setData(null); setAttempt(n => n + 1); }}>{t("Try again")}</button>
          </p>
        )}
        {!data && !error && (
          <div className="tenant-skeleton" aria-busy="true" />
        )}
        {data?.state === "ready" ? (
          <>
            <div className="collection-heading">
              <div className="scope-identity">
                <span>
                  <Folder />
                </span>
                <div>
                  <h1>
                    {data.name === "My entire collection"
                      ? t(data.name)
                      : data.name}
                  </h1>
                  <p>
                    {data.owner} ·{" "}
                    {t("{n} accessible documents", { n: data.items.length })}
                  </p>
                </div>
              </div>
              <label className="searchbox">
                <Search size={17} />
                <input
                  type="search"
                  placeholder={t("Search this collection")}
                  aria-label={t("Search this collection")}
                  value={query}
                  onChange={(e) => updateLocation(active, e.target.value, true)}
                />
              </label>
            </div>
            <p className="scope-notice">
              {t("Only documents you can access are shown.")}
            </p>
            <div className={folders.length ? "collection-browser" : undefined}>
            {folders.length > 0 && <>
              <nav className="collection-folders" aria-label={t("Folders")}>
                {choices.map(f => <button type="button" key={f.id} aria-current={active === f.id ? "page" : undefined} onClick={() => updateLocation(f.id, query)}><Folder size={18} aria-hidden="true" /><span>{f.name}</span><small>{f.count}</small></button>)}
              </nav>
              <label className="collection-folder-picker">{t("Folders")}<select value={active} onChange={e => updateLocation(e.target.value, query)}>{choices.map(f => <option key={f.id} value={f.id}>{f.name} · {f.count}</option>)}</select></label>
            </>}
            <section className="collection-content" aria-label={selectedName}>
            {folders.length > 0 && <h2>{selectedName}</h2>}
            {query && <p className="scope-muted" role="status">{t("{n} matching documents", { n: visibleItems.length })}</p>}
            <div className="collection-list">
              {visibleItems
                .map((s) => (
                  <Link
                    className="collection-row"
                    key={s.slug}
                    href={`/s/${s.slug}?collection=${encodeURIComponent(token)}`}
                  >
                    <FileText size={20} />
                    <strong>{s.title}</strong>
                    <span>{s.tenantName}</span>
                    <time>{new Date(s.updatedAt).toLocaleDateString()}</time>
                    <span
                      className={s.comments ? "scope-badge" : "scope-muted"}
                    >
                      {t(s.comments ? "Can comment" : "Can view")}
                    </span>
                  </Link>
                ))}
            </div>
            {visibleItems.length === 0 && <p className="scope-muted">{t("No documents match.")}</p>}
            </section>
            </div>
          </>
        ) : (
          data && (
            <div className="collection-empty">
              <Link2 size={32} />
              <h1>
                {t(
                  data.state === "login"
                    ? "Sign in to view this collection"
                    : data.state === "empty"
                      ? "No accessible documents"
                      : "Collection link disabled",
                )}
              </h1>
              <p>
                {t(
                  data.state === "unavailable"
                    ? "Contact the sharer for a new way to access these documents."
                    : "Documents in this collection use their own access permissions.",
                )}
              </p>
              {data.state === "login" && (
                <a
                  className="btn solid"
                  href={loginHref()}
                >
                  {t("Sign in")}
                </a>
              )}
            </div>
          )
        )}
      </main>
    </AppShell>
  );
}
