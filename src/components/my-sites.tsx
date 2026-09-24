"use client";
import type { DirectoryPage } from "@/lib/directory-query";
import { useDirectoryNavigation } from "@/lib/use-directory-navigation";
import ArtifactCover from "@/components/artifact-cover";
import ProgressivePreview from "@/components/progressive-preview";

import VersionUpload, { type UploadTarget } from "@/components/version-upload";
import Coachmark from "@/components/coachmark";
import { hintKey, readHint } from "@/lib/coachmarks";
import { useLearnHint } from "@/lib/use-learn-hint";
import { useRouter } from "next/navigation";
import SiteDownload from "@/components/site-download";

// "My sites": a folder rail on the left (all / unfiled / the person's own folders, with counts),
// the tools row (title search, sort, list or grid), then the sites — as rows with a "…" menu, or
// as cards. Folders are a personal classification: they never change who may open a site.
import { usePermissionsForSites } from "@/lib/site-permissions";
import { useCallback, useEffect, useSyncExternalStore, useMemo, useState, type SyntheticEvent } from "react";
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
import ConfirmDialog from "@/components/confirm-dialog";
import { useSiteActions } from "@/lib/site-actions";
import SiteVersionCell from "@/components/site-version-cell";
import MoreMenu from "@/components/more-menu";
import { useLocale, useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";

const subscribeIntent = () => () => {};
const subscribeUpdateHint = (notify: () => void) => {
  window.addEventListener("artifact:hint-learned", notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener("artifact:hint-learned", notify);
    window.removeEventListener("storage", notify);
  };
};
const readIntent = () => new URLSearchParams(location.search).get("intent") === "update";
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
export default function MySites({ sites, onMutated, manage = true, directory, userId }: { sites: SiteSummary[]; directory?: DirectoryPage; userId?: string; serverOwned?: ReadonlySet<string>; onMutated?: () => void; manage?: boolean; editable?: boolean }) {
  const navigation = useDirectoryNavigation();
  useEffect(() => {
    if (directory) {
      performance.clearMarks("artifact:directory-ready");
      performance.mark("artifact:directory-ready");
    }
  }, [directory]);
  const t = useT();
  const router = useRouter();
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const wantsUpdate = useSyncExternalStore(subscribeIntent, readIntent, () => false);
  const locale = useLocale();
  const { user, oidcEnabled, loading } = useAuth();
  const updateLearned = useSyncExternalStore(subscribeUpdateHint,
    () => readHint(hintKey(user?.id ?? "browser", "update")).learned, () => true);
  const updateIntent = wantsUpdate && !loading && !updateLearned;
  const learn = useLearnHint();
  const shelf = useShelf(userId ?? user?.id ?? null, directory?.folders);
  const state = shelf.state;
  const [localFilter, setLocalFilter] = useState<string>(directory?.query.folder ?? FILTER_ALL);
  const filter=directory?.query.folder ?? localFilter;
  const setFilter = (value:string) => {setLocalFilter(value); if(directory)navigation.change("folder",value);};
  const [localQuery, setLocalQuery] = useState("");
  const query = directory ? navigation.search : localQuery;
  const setQuery = (value:string) => {setLocalQuery(value);if(directory)navigation.change("q",value,250);};
  const [localSort, setLocalSort] = useState<Sort>(directory?.query.sort ?? "updated");
  const sort=directory?.query.sort ?? localSort;
  const setSort = (value:Sort) => {setLocalSort(value);if(directory)navigation.change("sort",value);};
  const [localView, setLocalView] = useState<View>("list");
  const view=directory ? navigation.view : localView;
  const setView=(value:View)=>{setLocalView(value); if(directory)navigation.change("view",value);};
  const [localPage, setLocalPage] = useState(directory?.query.page ?? 0);
  const page=directory?.query.page ?? localPage;
  const setPage = (value:number) => {setLocalPage(value);if(directory && value!==0)navigation.change("page",value);};
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [, setNonce] = useState(0);
  const tokens = useOwnedTokens(sites.map((s) => s.slug));
  const manageable = (slug: string): boolean => manage && Boolean(permissions[slug]?.canDelete);
  const canEdit = (slug: string): boolean => Boolean(permissions[slug]?.canEditContent);
  const { toast, copyLink, fork, remove, deleteRequest, confirmDelete, cancelDelete } = useSiteActions(tokens, onMutated);

  const known = filter === FILTER_ALL || filter === FILTER_UNFILED || state.folders.some((f) => f.id === filter);
  const active = known ? filter : FILTER_ALL;
  const activeFolder = state.folders.find((f) => f.id === active) ?? null;

  const localCounts = useMemo(() => countsByFolder(sites, state), [sites, state]);
  const counts = directory?.counts ?? localCounts;
  const inFolder = useMemo(() => filterByFolder(sites, state, active), [sites, state, active]);
  const shown = useMemo(() => {
    const list = [...filterBySearch(inFolder, query)];
    if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, locale));
    return list;
  }, [inFolder, query, sort, locale]);
  const total = directory?.total ?? shown.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageItems = directory ? sites : shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const {permissions,failed:permissionErrors,retry:retryPermissions} = usePermissionsForSites(directory ? [] : pageItems.map(s=>s.slug),tokens, directory?.permissions);

  const firstEditable = pageItems.find(s => canEdit(s.slug));
  const startUpload = (s: SiteSummary) => setUpload({ slug: s.slug, title: s.title, kind: s.kind, token: tokens[s.slug], canOfficial: Boolean(permissions[s.slug]?.canManageSharing) });
  const report = useCallback((r: ShelfOutcome): ShelfOutcome => {
    if (r.outcome === "storage") setHint(t(STORAGE_HINT));
    else if (r.outcome === "server") setHint(t("The change was not saved to your account: {error}", { error: r.error }));
    if (r.outcome === "ok" && directory) onMutated?.();
    return r;
  }, [t, directory, onMutated]);

  const addFolder = async (name: string, slug?: string): Promise<void> => {
    const r = report(await shelf.create(name, slug));
    if (r.outcome === "refused") {
      setHint(name.trim() ? t("At most {n} folders", { n: MAX_FOLDERS }) : t("A folder name cannot be empty"));
      return;
    }
    if (r.outcome !== "ok") return;
    setHint(null);
    if (r.id) setFilter(r.id);
  };

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
      {upload && <VersionUpload key={upload.slug} target={upload} onClose={() => setUpload(null)} onPublished={() => { learn("update"); onMutated?.(); router.refresh(); }} />}
      <button type="button" className="mobile-folders" aria-expanded={railOpen} aria-controls="folder-rail" onClick={() => setRailOpen((v) => !v)}>
        {t("Folders")} · {activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")} ▾
      </button>
      <div className={`work-layout${railOpen ? " folders-open" : ""}`}>
        {rail}
        <section className="work-content" aria-busy={navigation.pending}>
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
          {updateIntent && <div className="update-intent"><span>{t("Choose an artifact, then use its ⋯ menu to upload a new version.")}</span><button className="update-intent-dismiss" onClick={() => learn("update")}>{t("Got it")}</button></div>}
          {updateIntent && firstEditable && view === "list" && <Coachmark key={firstEditable.slug} name="update" selector='[data-update-hint="true"] .row-more' text={t("Use ⋯ → Upload new version for the artifact you want to update.")} />}
          <div className="folder-heading">
            <h2>{activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")}</h2>
            <span aria-live="polite">· {total}</span>
          </div>
          {hint && <p className="folder-note" role="status">{hint}</p>}

          {pageItems.length === 0 ? empty : view === "grid" ? (
            <div className="result-grid">{pageItems.map((s) => <ArtifactCard key={s.slug} site={s} actions={permissions[s.slug]?.canReadSource ? <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly>
              <SiteDownload slug={s.slug} editToken={tokens[s.slug]} />
              {canEdit(s.slug) && <button type="button" role="menuitem" className="menu-item" onClick={() => startUpload(s)}>{t("Upload new version")}</button>}
            </MoreMenu> : undefined} />)}</div>
          ) : (
            <div className="site-list my-sites-list">
              <div className="list-header"><span>{t("Site")}</span><span className="row-views">{t("Total opens")}</span><span className="row-visibility">{t("Who can open")}</span><span className="row-versions">{t("Versions")}</span><span className="row-date">{t("Updated")}</span><span /></div>
              {pageItems.map((s) => (
                <div className="site-row" key={s.slug} data-slug={s.slug} data-update-hint={s.slug === firstEditable?.slug || undefined}>
                  <div className="site-name">
                    <SiteLink slug={s.slug} href={`/s/${s.slug}`} className="mini" aria-hidden="true" tabIndex={-1}>
                      {s.kind === "document" ? <ArtifactCover site={s} /> : <ProgressivePreview key={`${s.slug}:${s.updatedAt}`} site={s} src={`/api/preview/${s.slug}?thumb=1`} />}
                    </SiteLink>
                    <div>
                      <strong><SiteLink slug={s.slug} href={`/s/${s.slug}`}>{s.title}</SiteLink></strong>
                      <small>{kindLabel(s.kind, t)}{s.takenDownAt ? ` · ${t("Taken down")}` : ""}</small>
                    </div>
                  </div>
                  <span className="row-views" data-label={t("Total opens")} title={t("All recorded opens, including your own and collaborators. New opens by the same reader within 30 minutes are combined across links; older records keep their original counting rules.")}>{s.totalViews == null ? "—" : s.totalViews.toLocaleString(locale)}</span>
                  <span className="row-visibility"><VisibilityCell site={s} t={t} /></span>
                  <SiteVersionCell key={`${s.slug}:${s.officialVersionId}:${s.versionCount}`} site={s} canManage={Boolean(permissions[s.slug]?.canManageSharing)} token={tokens[s.slug]} onMutated={onMutated} />
                  <span className="row-date">{relTime(s.updatedAt, t, locale)}</span>
                  <span className="row-menu-wrap">
                    <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly buttonClassName="row-more" buttonContent="⋯">
                      {!permissions[s.slug] ? <button className="menu-item" role="menuitem" disabled={!permissionErrors.includes(s.slug)} onClick={retryPermissions}>{t(permissionErrors.includes(s.slug) ? "Try again" : "Loading…")}</button> : <>
                      <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}`}>{t("Open")}</SiteLink>
                      <button type="button" role="menuitem" className="menu-item" onClick={() => void copyLink(s.slug)}>{t("Copy link")}</button>
                      {permissions[s.slug]?.canReadSource && <SiteDownload slug={s.slug} editToken={tokens[s.slug]} />}
                      {canEdit(s.slug) && s.kind !== "document" && <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}/edit`}>{t("Edit")}</SiteLink>}
                      {canEdit(s.slug) && <button type="button" role="menuitem" className="menu-item" onClick={() => startUpload(s)}>{t("Upload new version")}</button>}
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
                      </>}
                    </MoreMenu>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="list-end">
            <span>{countText(t, total, "{n} site", "{n} sites")}</span>
            {pages > 1 && (
              <div className="pager">
                <button type="button" className="quiet" disabled={current === 0} onClick={() => directory ? navigation.change("page",current-1) : setPage(current-1)} aria-label={t("Previous")}>‹</button>
                <span className="pager-current" aria-current="page">{current + 1}</span>
                <span>/ {pages}</span>
                <button type="button" className="quiet" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label={t("Next")}>›</button>
              </div>
            )}
          </div>
        </section>
      </div>
      {deleteRequest && <ConfirmDialog title={t("Delete \"{title}\"?", { title: deleteRequest.title })}
        body={t("This site will no longer be accessible. Its files are retained temporarily according to the server's retention policy.")}
        confirmLabel={t("Delete site")} danger onConfirm={confirmDelete} onClose={cancelDelete} />}
      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}
