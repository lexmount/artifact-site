"use client";

import SiteDownload from "@/components/site-download";

// "My sites": a folder rail on the left (all / unfiled / the person's own folders, with counts),
// the tools row (title search, sort, list or grid), then the sites — as rows with a "…" menu, or
// as cards. Folders are a personal classification: they never change who may open a site.
import { usePermissionsForSites } from "@/lib/site-permissions";
import { useCallback, useMemo, useState, type SyntheticEvent } from "react";
import Link from "next/link";
import SiteLink from "@/components/site-link";
import { Folder, Globe, Lock, EyeOff, LayoutGrid, List, Search } from "lucide-react";
import type { SiteSummary } from "@/lib/types";
import { loginHref, useAuth } from "@/lib/use-auth";
import { useShelf, type ShelfOutcome } from "@/lib/folder-shelf";
import {
  FILTER_ALL,
  FILTER_UNFILED,
  MAX_FOLDERS,
  countsByFolder,
  filterByFolder,
  filterBySearch,
  folderOf,
} from "@/lib/folders";
import ArtifactCard, { kindLabel } from "@/components/artifact-card";
import { relTime } from "@/lib/rel-time";
import { useOwnedTokens } from "@/lib/edit-token";
import { useSiteActions } from "@/lib/site-actions";
import MoreMenu from "@/components/more-menu";
import { useLocale, useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

const NEW_FOLDER = "__new__";
const PAGE_SIZE = 12;

const STORAGE_HINT = "Browser storage refused the write (it may be full, or in private/disabled mode), so this change was not saved.";

type Sort = "updated" | "title";
type View = "list" | "grid";

export function VisibilityCell({ site, t }: { site: SiteSummary; t: (k: string) => string }) {
  if (site.visibility === "private") return <><Lock size={15} aria-hidden="true" /> {t("Private")}</>;
  if (site.visibility === "unlisted") return <><EyeOff size={15} aria-hidden="true" /> {t("Unlisted")}</>;
  return <><Globe size={15} aria-hidden="true" /> {t("Public")}</>;
}

/**
 * `manage`: the owner's actions (rename, delete) — off for lists of other people's sites.
 * `editable`: every row may be edited regardless of ownership — the "I can edit" list, where the
 * server already vetted the collaboration and the browser holds no token for it.
 */
export default function MySites({ sites, onMutated, manage = true }: { sites: SiteSummary[]; serverOwned?: ReadonlySet<string>; onMutated?: () => void; manage?: boolean; editable?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { user, oidcEnabled } = useAuth();
  const shelf = useShelf(user?.id ?? null);
  const state = shelf.state;
  const [filter, setFilter] = useState<string>(FILTER_ALL);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [view, setView] = useState<View>("list");
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [, setNonce] = useState(0);
  const tokens = useOwnedTokens(sites.map((s) => s.slug));
  const manageable = (slug: string): boolean => manage && Boolean(permissions[slug]?.canDelete);
  const canEdit = (slug: string): boolean => Boolean(permissions[slug]?.canEditContent);
  const { toast, copyLink, fork, remove } = useSiteActions(tokens, onMutated);

  const known = filter === FILTER_ALL || filter === FILTER_UNFILED || state.folders.some((f) => f.id === filter);
  const active = known ? filter : FILTER_ALL;
  const activeFolder = state.folders.find((f) => f.id === active) ?? null;

  const counts = useMemo(() => countsByFolder(sites, state), [sites, state]);
  const inFolder = useMemo(() => filterByFolder(sites, state, active), [sites, state, active]);
  const shown = useMemo(() => {
    const list = [...filterBySearch(inFolder, query)];
    if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, locale));
    return list;
  }, [inFolder, query, sort, locale]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageItems = shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const permissions = usePermissionsForSites(pageItems.map(s=>s.slug),tokens);

  const report = useCallback((r: ShelfOutcome): ShelfOutcome => {
    if (r.outcome === "storage") setHint(t(STORAGE_HINT));
    else if (r.outcome === "server") setHint(t("The change was not saved to your account: {error}", { error: r.error }));
    return r;
  }, [t]);

  const addFolder = useCallback(async (name: string, slug?: string): Promise<void> => {
    const r = report(await shelf.create(name, slug));
    if (r.outcome === "refused") {
      setHint(name.trim() ? t("At most {n} folders", { n: MAX_FOLDERS }) : t("A folder name cannot be empty"));
      return;
    }
    if (r.outcome !== "ok") return;
    setHint(null);
    if (r.id) setFilter(r.id);
  }, [shelf, report, t]);

  function submitNew(e?: SyntheticEvent) {
    e?.preventDefault();
    const name = draft.trim();
    setCreating(false);
    setDraft("");
    if (name) void addFolder(name);
  }

  function commitRename(id: string, previous: string) {
    setRenaming(null);
    const name = draft.trim();
    setDraft("");
    if (name && name !== previous) void shelf.rename(id, name).then(report);
  }

  function removeFolder(folder: { id: string; name: string }) {
    const n = counts.byId[folder.id] ?? 0;
    const detail = n > 0 ? t("The {n} sites inside go back to \"Unfiled\"; the sites themselves are not deleted.", { n }) : t("Sites are not affected.");
    if (!window.confirm(t("Delete the folder \"{name}\"? {detail}", { name: folder.name, detail }))) return;
    void shelf.remove(folder.id).then((r) => { if (report(r).outcome === "ok") setFilter(FILTER_ALL); });
  }

  function moveSite(slug: string, value: string) {
    setNonce((n) => n + 1);
    if (value === NEW_FOLDER) {
      const name = window.prompt(t("New folder name"));
      if (name?.trim()) void addFolder(name, slug);
      return;
    }
    void shelf.assign(slug, value === FILTER_UNFILED ? null : value).then(report);
  }

  const rail = (
    <aside className={`folder-rail${railOpen ? " is-open" : ""}`} id="folder-rail" aria-label={t("Folders")}>
      <div className="rail-head">
        <span>{t("Folders")}</span>
        <button type="button" aria-label={t("New folder")} onClick={() => { setCreating(true); setDraft(""); }}>+</button>
      </div>
      <nav aria-label={t("Choose a folder")}>
        <button className="folder" type="button" aria-current={active === FILTER_ALL} onClick={() => { setFilter(FILTER_ALL); setPage(0); }}>
          <span>{t("All sites")}</span><b>{counts.all}</b>
        </button>
        <button className="folder" type="button" aria-current={active === FILTER_UNFILED} onClick={() => { setFilter(FILTER_UNFILED); setPage(0); }}>
          <span>{t("Unfiled")}</span><b>{counts.unfiled}</b>
        </button>
        {state.folders.length > 0 && <div className="folder-separator" />}
        {state.folders.map((f) =>
          renaming === f.id ? (
            <input key={f.id} className="folder-input" autoFocus value={draft} maxLength={40} aria-label={t("Rename folder {name}", { name: f.name })}
              onChange={(e) => setDraft(e.target.value)} onBlur={() => commitRename(f.id, f.name)}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(f.id, f.name); else if (e.key === "Escape") { setRenaming(null); setDraft(""); } }} />
          ) : (
            <button key={f.id} className="folder" type="button" aria-current={active === f.id} onClick={() => { setFilter(f.id); setPage(0); }}
              onDoubleClick={() => { setRenaming(f.id); setDraft(f.name); }} title={t("Double-click to rename")}>
              <Folder size={16} aria-hidden="true" /><span>{f.name}</span><b>{counts.byId[f.id] ?? 0}</b>
            </button>
          ),
        )}
      </nav>
      {creating ? (
        <form className="folder-form" onSubmit={submitNew}>
          <input className="folder-input" autoFocus value={draft} maxLength={40} placeholder={t("Folder name")} aria-label={t("New folder name")}
            onChange={(e) => setDraft(e.target.value)} onBlur={() => submitNew()} onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setDraft(""); } }} />
        </form>
      ) : (
        <button className="folder-add" type="button" onClick={() => { setCreating(true); setDraft(""); }}>＋ {t("New folder")}</button>
      )}
      {activeFolder && (
        <div className="folder-actions">
          <button type="button" className="quiet" onClick={() => { setRenaming(activeFolder.id); setDraft(activeFolder.name); }}>{t("Rename")}</button>
          <button type="button" className="quiet" onClick={() => removeFolder(activeFolder)}>{t("Delete folder")}</button>
        </div>
      )}
      <p className="folder-hint">{t("Folders are for organising. They never change who can open a site.")}</p>
    </aside>
  );

  const empty = (
    <div className="empty">
      <h3>{query.trim() ? t("No site matches “{q}”", { q: query.trim() }) : active === FILTER_ALL ? t("You have no sites of your own yet") : t("This folder is still empty")}</h3>
      <p>
        {query.trim()
          ? <button type="button" className="quiet" onClick={() => setQuery("")}>{t("Clear the search")}</button>
          : active === FILTER_ALL
            ? <Link href="/">{t("Upload something on the home page, and the first site is yours.")}</Link>
            : t("Use \"Move to folder\" in a site's menu to put it here.")}
      </p>
      {active === FILTER_ALL && oidcEnabled && !user && !query.trim() && (
        <p><a className="quiet" href={loginHref("/me")}>{t("Sign in to recover sites from your other devices")}</a></p>
      )}
    </div>
  );

  return (
    <>
      <button type="button" className="mobile-folders" aria-expanded={railOpen} aria-controls="folder-rail" onClick={() => setRailOpen((v) => !v)}>
        {t("Folders")} · {activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")} ▾
      </button>
      <div className={`work-layout${railOpen ? " folders-open" : ""}`}>
        {rail}
        <section className="work-content">
          <div className="work-tools">
            <label className="searchbox">
              <Search size={16} aria-hidden="true" />
              <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder={t("Search site titles")} aria-label={t("Search my sites")} />
            </label>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("Sort")}>
              <option value="updated">{t("Recently updated")}</option>
              <option value="title">{t("Title A–Z")}</option>
            </select>
            <div className="view-switch">
              <button type="button" aria-label={t("List view")} aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} /></button>
              <button type="button" aria-label={t("Grid view")} aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={16} /></button>
            </div>
          </div>
          <div className="folder-heading">
            <h2>{activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")}</h2>
            <span aria-live="polite">· {shown.length}</span>
          </div>
          {hint && <p className="folder-note" role="status">{hint}</p>}

          {pageItems.length === 0 ? empty : view === "grid" ? (
            <div className="result-grid">{pageItems.map((s) => <ArtifactCard key={s.slug} site={s} actions={permissions[s.slug]?.canReadSource ? <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly>
              <SiteDownload slug={s.slug} editToken={tokens[s.slug]} />
            </MoreMenu> : undefined} />)}</div>
          ) : (
            <div className="site-list">
              <div className="list-header"><span>{t("Site")}</span><span>{t("Who can open")}</span><span>{t("Versions")}</span><span>{t("Updated")}</span><span /></div>
              {pageItems.map((s) => (
                <div className="site-row" key={s.slug}>
                  <div className="site-name">
                    <SiteLink slug={s.slug} href={`/s/${s.slug}`} className="mini" aria-hidden="true" tabIndex={-1}>
                      <iframe src={`/api/preview/${s.slug}?thumb=1`} title="" loading="lazy" tabIndex={-1} inert sandbox="" />
                    </SiteLink>
                    <div>
                      <strong><SiteLink slug={s.slug} href={`/s/${s.slug}`}>{s.title}</SiteLink></strong>
                      <small>{kindLabel(s.kind, t)}{s.takenDownAt ? ` · ${t("Taken down")}` : ""}</small>
                    </div>
                  </div>
                  <span className="row-visibility"><VisibilityCell site={s} t={t} /></span>
                  <span>{s.versionCount}</span>
                  <span className="row-date">{relTime(s.updatedAt, t, locale)}</span>
                  <span className="row-menu-wrap">
                    <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly buttonClassName="row-more" buttonContent="⋯">
                      <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}`}>{t("Open")}</SiteLink>
                      <button type="button" role="menuitem" className="menu-item" onClick={() => void copyLink(s.slug)}>{t("Copy link")}</button>
                      {permissions[s.slug]?.canReadSource && <SiteDownload slug={s.slug} editToken={tokens[s.slug]} />}
                      {canEdit(s.slug) && <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}/edit`}>{t("Edit")}</SiteLink>}
                      <button type="button" role="menuitem" className="menu-item" disabled={!permissions[s.slug]?.canReadSource} onClick={() => void fork(s.slug)}>{t("Save a copy")}</button>
                      {/* Not a menu item on purpose: choosing a folder keeps the menu open, so the row does not vanish under the pointer. */}
                      <label className="row-menu-move">
                        <span>{t("Move to folder")}</span>
                        <select value={folderOf(state, s.slug) ?? FILTER_UNFILED} aria-label={t("Move \"{title}\" to a folder", { title: s.title })} onChange={(e) => moveSite(s.slug, e.target.value)}>
                          <option value={FILTER_UNFILED}>{t("Unfiled")}</option>
                          {state.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                          <option value={NEW_FOLDER}>{t("+ New folder…")}</option>
                        </select>
                      </label>
                      {manageable(s.slug) && <button type="button" role="menuitem" className="menu-item danger" onClick={() => void remove(s.slug, s.title)}>{t("Delete")}</button>}
                    </MoreMenu>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="list-end">
            <span>{countText(t, shown.length, "{n} site", "{n} sites")}</span>
            {pages > 1 && (
              <div className="pager">
                <button type="button" className="quiet" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={t("Previous")}>‹</button>
                <span className="pager-current" aria-current="page">{current + 1}</span>
                <span>/ {pages}</span>
                <button type="button" className="quiet" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label={t("Next")}>›</button>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}
