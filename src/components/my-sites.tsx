"use client";
import { appPath } from "@/lib/app-path";
import type { DirectoryPage } from "@/lib/directory-query";
import { useDirectoryNavigation } from "@/lib/use-directory-navigation";
import { adminFetch } from "@/components/admin/format";
import { AUDIENCE_LABELS, type SharingState, type SharingPreview } from "@/lib/sharing-policy";
import ScopeSharingDialog, { SharingDialog } from "@/components/sharing/scope-dialog";
import { draggedSites, needsMoveConfirmation } from "@/lib/folder-move";
import SharingHelp from "@/components/sharing/sharing-help";
import BulkSharingDialog from "@/components/sharing/bulk-dialog";
import MoveSharingDialog from "@/components/sharing/move-dialog";
import { invalidateClientCaches } from "@/lib/client-cache";
import ArtifactCover from "@/components/artifact-cover";
import ProgressivePreview from "@/components/progressive-preview";

import VersionUpload, { type UploadTarget } from "@/components/version-upload";
import Coachmark from "@/components/coachmark";
import { hintKey, readHint } from "@/lib/coachmarks";
import { useLearnHint } from "@/lib/use-learn-hint";
import { useRouter } from "next/navigation";
import SiteDownload from "@/components/site-download";
import SharePanel from "@/components/share-panel";

// "My sites": a folder rail on the left (all / unfiled / the person's own folders, with counts),
// the tools row (title search, sort, list or grid), then the sites — as rows with a "…" menu, or
// as cards. Folder sharing is opt-in; confirmed moves preview main-address access changes.
import { usePermissionsForSites } from "@/lib/site-permissions";
import { siteFetch } from "@/lib/share-context";
import { useCallback, useEffect, useSyncExternalStore, useMemo, useRef, useState, type DragEvent, type SyntheticEvent } from "react";
import Link from "next/link";
import SiteLink from "@/components/site-link";
import { Folder, Globe, Lock, Link2, LayoutGrid, List, Search, Pencil, Trash2, PanelsTopLeft, Share2, ChevronDown, Inbox, ArrowUpRight, FileUp, Copy, FolderInput, Loader2, RefreshCw } from "lucide-react";
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
type SharingTarget = { site: SiteSummary; anchor: HTMLElement };

export function VisibilityCell({ site, t }: { site: SiteSummary; t: (k: string) => string }) {
  if (site.visibility === "private") return <><Lock size={15} aria-hidden="true" /> {t("Authorized people only")}</>;
  if (site.visibility === "unlisted") return <><Link2 size={15} aria-hidden="true" /> {t("Anyone with the link can access")}</>;
  return <><Globe size={15} aria-hidden="true" /> {t("Public")}</>;
}

export function SharingStatus({ site }: { site: SiteSummary }) {
  const t = useT();
  const status = site.sharingStatus;
  if (!status) return null;
  const channels = [
    status.audience !== "private" ? t(AUDIENCE_LABELS[status.audience]) : null,
    status.members ? t("Authorized members") : null,
    status.links ? t("Active independent links") : null,
  ].filter(Boolean);
  return <span className="directory-sharing-status">
    <span className={`directory-sharing-status-badge${status.shared ? " is-shared" : ""}`}>
      {status.shared ? <Share2 size={12} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />}
      {t(site.takenDownAt ? "Taken down" : status.shared ? "Shared" : "Private")}
    </span>
    {channels.length > 0 && <small title={channels.join(" · ")}>{channels[0]}{channels.length > 1 ? t(" · +{n} more", {n:channels.length-1}) : ""}</small>}
  </span>;
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
  const [sharingTarget, setSharingTarget] = useState<SharingTarget | null>(null);
  const [sharingOpening, setSharingOpening] = useState<SharingTarget | null>(null);
  const [sharingError, setSharingError] = useState<SharingTarget | null>(null);
  const sharingExchange = useRef<AbortController | null>(null);
  useEffect(() => () => sharingExchange.current?.abort(), []);
  const folderHeading = useRef<HTMLHeadingElement>(null);
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
  const [scopeDialog, setScopeDialog] = useState<{folderId:string|null;deleting?:boolean}|null>(null);
  const [moveDialog,setMoveDialog] = useState<{slugs:string[];folderId:string|null;initialPreview?:SharingPreview}|null>(null);
  const [bulkSharing, setBulkSharing] = useState<string[] | null>(null);
  const restoreBulkFocus = useRef(false);
  useEffect(() => {
    if (bulkSharing || !restoreBulkFocus.current) return;
    // Both sharing dialogs must leave the top layer before focusing the directory.
    restoreBulkFocus.current = false;
    folderHeading.current?.focus({ preventScroll: true });
  }, [bulkSharing]);
  const [selectedSlugs,setSelectedSlugs] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const dragRef = useRef<string[]>([]);
  const dragImage = useRef<HTMLDivElement>(null);
  const [sharingVersion,setSharingVersion] = useState(0);
  useEffect(() => {
    const refresh = () => { setSharingVersion(version => version + 1); router.refresh(); };
    window.addEventListener("artifact:shares-changed", refresh);
    return () => window.removeEventListener("artifact:shares-changed", refresh);
  }, [router]);
  const [sharingSummary,setSharingSummary] = useState<{states:Record<string,SharingState>;sharedFolders:string[];allShared:boolean}>({states:{},sharedFolders:[],allShared:false});
  const sharingQuery = sites.map(s=>`slug=${encodeURIComponent(s.slug)}`).join("&");
  useEffect(()=>{if(shelf.mode!=="account")return;let alive=true;adminFetch<typeof sharingSummary>(`/api/me/sharing/summary?${sharingQuery}`).then(r=>{if(alive)setSharingSummary(r);}).catch(()=>{});return()=>{alive=false;};},[sharingQuery,shelf.mode,sharingVersion]);
  const refreshed = () => { setSharingVersion(v=>v+1); invalidateClientCaches(); void shelf.reload(); setSelectedSlugs([]); onMutated?.(); router.refresh(); };
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [, setNonce] = useState(0);
  const tokens = useOwnedTokens(sites.map((s) => s.slug));
  const manageable = (slug: string): boolean => manage && Boolean(permissions[slug]?.canDelete);
  const canEdit = (slug: string): boolean => Boolean(permissions[slug]?.canEditContent);
  const { toast, flash, copyLink, fork, remove, deleteRequest, confirmDelete, cancelDelete } = useSiteActions(tokens, onMutated);

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

  const selection = selectedSlugs.filter(slug => pageItems.some(site => site.slug === slug));
  const canShareSelection = shelf.mode === "account" && selection.every(slug => permissions[slug]?.canManageSharing);
  const firstEditable = pageItems.find(s => canEdit(s.slug));
  function openSharing(site: SiteSummary, item: HTMLElement) {
    const menu = item.closest('[role="menu"]');
    const anchor = menu && document.querySelector<HTMLElement>(`button[aria-controls="${CSS.escape(menu.id)}"]`);
    if (anchor) void prepareSharing({ site, anchor });
  }
  async function prepareSharing(target: SharingTarget) {
    if (sharingExchange.current) return;
    setSharingError(null);
    const token = tokens[target.site.slug];
    if (!token) { setSharingTarget(target); return; }
    const controller = new AbortController();
    sharingExchange.current = controller;
    setSharingOpening(target);
    try {
      // Listing only verifies the receipt. The card's cookie-authenticated requests need it exchanged first.
      const response = await siteFetch(`/api/sites/${target.site.slug}/permissions`, {
        method: "POST", headers: { "x-edit-token": token }, signal: controller.signal,
      });
      if (!response.ok || !(await response.json()).permissions?.canManageSharing) throw new Error("Sharing access unavailable");
      if (!controller.signal.aborted && target.anchor.isConnected) setSharingTarget(target);
    } catch {
      if (!controller.signal.aborted && target.anchor.isConnected) setSharingError(target);
    } finally {
      if (!controller.signal.aborted) {
        sharingExchange.current = null;
        setSharingOpening(null);
      }
    }
  }
  function closeSharing() {
    if (!sharingTarget?.anchor.isConnected) requestAnimationFrame(() => folderHeading.current?.focus({ preventScroll: true }));
    setSharingTarget(null);
  }
  const startUpload = (s: SiteSummary) => setUpload({ slug: s.slug, title: s.title, kind: s.kind, token: tokens[s.slug], canOfficial: Boolean(permissions[s.slug]?.canManageSharing) });
  const report = useCallback((r: ShelfOutcome): ShelfOutcome => {
    if (r.outcome === "storage") setHint(t(STORAGE_HINT));
    else if (r.outcome === "server") setHint(t("The change was not saved to your account: {error}", { error: r.error }));
    if (r.outcome === "ok" && directory) onMutated?.();
    return r;
  }, [t, directory, onMutated]);

  const addFolder = async (name: string, slug?: string): Promise<void> => {
    const r = report(await shelf.create(name, shelf.mode === "account" ? undefined : slug));
    if (r.outcome === "refused") {
      setHint(name.trim() ? t("At most {n} folders", { n: MAX_FOLDERS }) : t("A folder name cannot be empty"));
      return;
    }
    if (r.outcome !== "ok") return;
    setHint(null);
    if (r.id) { setFilter(r.id); if (slug && shelf.mode === "account") setMoveDialog({slugs:[slug],folderId:r.id}); }
  };

  function submitNew(e?: SyntheticEvent) {
    e?.preventDefault();
    const name = draft.trim();
    setCreating(false);
    setDraft("");
    if (name) void addFolder(name);
  }

  function startRename(folder: { id: string; name: string }) {
    setRenaming(folder);
    setRenameDraft(folder.name);
  }

  async function commitRename() {
    if (!renaming || !renameDraft.trim()) return;
    if (renameDraft.trim() !== renaming.name) {
      const result = await shelf.rename(renaming.id, renameDraft.trim());
      if (result.outcome === "server") throw new Error(t("The change was not saved to your account: {error}", { error: result.error }));
      if (result.outcome === "storage") throw new Error(t(STORAGE_HINT));
      if (result.outcome !== "ok") throw new Error(t("A folder name cannot be empty"));
      report(result);
    }
    setRenaming(null);
  }

  function removeFolder(folder: { id: string; name: string }) {
    if (shelf.mode === "account") { setScopeDialog({folderId:folder.id,deleting:true}); return; }
    const n = counts.byId[folder.id] ?? 0;
    const detail = n > 0 ? t("The {n} sites inside go back to \"Unfiled\"; the sites themselves are not deleted.", { n }) : t("Sites are not affected.");
    if (!window.confirm(t("Delete the folder \"{name}\"? {detail}", { name: folder.name, detail }))) return;
    void shelf.remove(folder.id).then((r) => { if (report(r).outcome === "ok") setFilter(FILTER_ALL); });
  }

  async function fileSites(slugs: string[], folderId: string | null) {
    if (movingRef.current || shelf.loading || moveDialog) return;
    const changed = slugs.filter(slug => folderOf(state, slug) !== folderId);
    if (!changed.length) return;
    movingRef.current = true;
    setMoving(true);
    setHint(null);
    try {
      if (shelf.mode === "account") {
        const body = { slugs: changed, folderId };
        const preview = await adminFetch<SharingPreview>("/api/me/sharing/move", { method: "POST", body });
        if (needsMoveConfirmation(preview)) {
          setMoveDialog({ ...body, initialPreview: preview });
          return;
        }
        // The server rechecks the digest, so concurrent sharing changes cannot slip into a plain move.
        await adminFetch("/api/me/sharing/move", { method: "POST", body: { ...body, confirmation: preview.confirmation } });
        refreshed();
      } else {
        for (const slug of changed) {
          const result = report(await shelf.assign(slug, folderId));
          if (result.outcome !== "ok") return;
        }
      }
      setHint(t("Moved to {name}", { name: state.folders.find(f => f.id === folderId)?.name ?? t("Unfiled") }));
    } catch (e) {
      setHint(t("Could not move artifacts. {error}", { error: t(e instanceof Error ? e.message : "Request failed") }));
    } finally { movingRef.current = false; setMoving(false); }
  }
  function moveSite(slug: string, value: string) {
    setNonce(n => n + 1);
    if (value === NEW_FOLDER) {
      const name = window.prompt(t("New folder name"));
      if (name?.trim()) void addFolder(name, slug);
      return;
    }
    void fileSites([slug], value === FILTER_UNFILED ? null : value);
  }
  function endDrag() { dragRef.current = []; setDragging([]); setDropTarget(null); }
  function startDrag(event: DragEvent, slug: string) {
    if (moving || shelf.loading || moveDialog || (event.target as HTMLElement).closest("button, input, select")) { event.preventDefault(); return; }
    const slugs = draggedSites(slug, selection);
    dragRef.current = slugs;
    setDragging(slugs);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-artifact-sites", "move");
    if (dragImage.current) {
      dragImage.current.textContent = t("{n} artifacts", { n: slugs.length });
      event.dataTransfer.setDragImage(dragImage.current, 16, 16);
    }
  }
  function dragOver(event: DragEvent<HTMLButtonElement>, id: string) {
    if (!dragRef.current.length || !event.dataTransfer.types.includes("application/x-artifact-sites") || moving) return;
    const target = id === FILTER_UNFILED ? null : id;
    if (dragRef.current.every(slug => folderOf(state, slug) === target)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(id);
  }
  function dragLeave(event: DragEvent<HTMLButtonElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
  }
  function drop(event: DragEvent<HTMLButtonElement>, id: string) {
    if (!dragRef.current.length || !event.dataTransfer.types.includes("application/x-artifact-sites")) return;
    event.preventDefault();
    const slugs = [...dragRef.current]; endDrag();
    void fileSites(slugs, id === FILTER_UNFILED ? null : id);
  }
  function selectionBox(site: SiteSummary) {
    return shelf.mode === "account" && <input className="scope-row-select" type="checkbox" disabled={moving} aria-label={t("Select {title}", { title: site.title })}
      checked={selection.includes(site.slug)} onChange={e => setSelectedSlugs(value => e.target.checked ? [...value, site.slug] : value.filter(slug => slug !== site.slug))}/>;
  }
  function folderPicker(site: SiteSummary) {
    return <label className="row-menu-move"><span><FolderInput size={14} aria-hidden="true" />{t("Move to folder")}</span>
      <select disabled={moving || shelf.loading} value={folderOf(state, site.slug) ?? FILTER_UNFILED} aria-label={t("Move \"{title}\" to a folder", { title: site.title })} onChange={e => moveSite(site.slug, e.target.value)}>
        <option value={FILTER_UNFILED}>{t("Unfiled")}</option>
        {state.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        <option value={NEW_FOLDER}>{t("+ New folder…")}</option>
      </select>
    </label>;
  }

  const rail = (
    <aside className={`folder-rail${railOpen ? " is-open" : ""}`} id="folder-rail" aria-label={t("Folders")}>
      <div className="rail-head">
        <span>{t("Folders")}</span>
        <button type="button" aria-label={t("New folder")} onClick={() => { setCreating(true); setDraft(""); }}>+</button>
      </div>
      <nav aria-label={t("Choose a folder")}>
        <button className="folder" type="button" aria-current={active === FILTER_ALL} onClick={() => { setFilter(FILTER_ALL); setPage(0); }}>
          <span className="folder-type-icon"><PanelsTopLeft size={18} aria-hidden="true" />{sharingSummary.allShared && <Link2 className="folder-share-badge" size={11} aria-label={t("Sharing enabled")} />}</span><span>{t("All sites")}</span><b>{counts.all}</b>
        </button>
        <button data-folder-id={FILTER_UNFILED} data-drop-active={dropTarget === FILTER_UNFILED || undefined} onDragOver={e => dragOver(e, FILTER_UNFILED)} onDragLeave={dragLeave} onDrop={e => drop(e, FILTER_UNFILED)} className="folder" type="button" aria-current={active === FILTER_UNFILED} onClick={() => { setFilter(FILTER_UNFILED); setPage(0); }}>
          <span className="folder-type-icon"><Inbox size={18} aria-hidden="true"/></span><span>{t("Unfiled")}</span><b>{counts.unfiled}</b>
        </button>
        {state.folders.length > 0 && <div className="folder-separator" />}
        {state.folders.map((f) => (
          <button data-folder-id={f.id} data-drop-active={dropTarget === f.id || undefined} onDragOver={e => dragOver(e, f.id)} onDragLeave={dragLeave} onDrop={e => drop(e, f.id)} key={f.id} className="folder" type="button" aria-current={active === f.id} onClick={() => { setFilter(f.id); setPage(0); }}
            onDoubleClick={() => startRename(f)} title={t("Double-click to rename")}>
            <span className="folder-type-icon"><Folder size={18} aria-hidden="true" />{sharingSummary.sharedFolders.includes(f.id) && <Link2 className="folder-share-badge" size={11} aria-label={t("Shared folder")} />}</span>
            <span>{f.name}</span><b>{counts.byId[f.id] ?? 0}</b>
          </button>
        ))}
      </nav>
      {creating ? (
        <form className="folder-form" onSubmit={submitNew}>
          <input className="folder-input" autoFocus value={draft} maxLength={40} placeholder={t("Folder name")} aria-label={t("New folder name")}
            onChange={(e) => setDraft(e.target.value)} onBlur={() => submitNew()} onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setDraft(""); } }} />
        </form>
      ) : (
        <button className="folder-add" type="button" onClick={() => { setCreating(true); setDraft(""); }}>＋ {t("New folder")}</button>
      )}
      <div className="folder-hint">{t("Drag artifacts into a folder to organize them.")}<SharingHelp label={t("Folders")}>{t(shelf.mode === "account" ? "Folders organise documents. Sharing a folder also changes the visibility of the documents inside." : "Folders are for organising. They never change who can open a site.")}</SharingHelp></div>
      {dropTarget && <p className="folder-drop-hint" role="status">{t("Move to {name}", { name: state.folders.find(f => f.id === dropTarget)?.name ?? t("Unfiled") })}</p>}
    </aside>
  );

  const sharingFilter = directory?.query.sharing ?? "all";
  const filteredSharing = sharingFilter !== "all";
  const empty = (
    <div className="empty">
      <h3>{filteredSharing ? t("No sites match this sharing filter") : query.trim() ? t("No site matches “{q}”", { q: query.trim() }) : active === FILTER_ALL ? t("You have no sites of your own yet") : t("This folder is still empty")}</h3>
      <p>
        {filteredSharing ? <button type="button" className="quiet" onClick={() => navigation.change("sharing", "all")}>{t("Show all sharing states")}</button> : query.trim()
          ? <button type="button" className="quiet" onClick={() => setQuery("")}>{t("Clear the search")}</button>
          : active === FILTER_ALL
            ? <Link href="/">{t("Upload something on the home page, and the first site is yours.")}</Link>
            : t("Use \"Move to folder\" in a site's menu to put it here.")}
      </p>
      {active === FILTER_ALL && oidcEnabled && !user && !query.trim() && (
        <p><a className="quiet" href={appPath(loginHref("/me"))}>{t("Sign in to recover sites from your other devices")}</a></p>
      )}
    </div>
  );

  return (
    <>
      {sharingTarget && <SharePanel key={sharingTarget.site.slug} slug={sharingTarget.site.slug} visibility={sharingTarget.site.visibility ?? "private"} anchor={sharingTarget.anchor} onClose={closeSharing}/>}
      {renaming && <SharingDialog className="folder-rename-dialog" title={t("Rename folder {name}", { name: renaming.name })} confirmLabel={t("Confirm changes")} disabled={!renameDraft.trim()} onClose={() => setRenaming(null)} onSubmit={commitRename}>
        <label className="folder-rename-field">{t("Folder name")}<input autoFocus className="folder-input" value={renameDraft} maxLength={40} onChange={e => setRenameDraft(e.target.value)} /></label>
      </SharingDialog>}
      {scopeDialog && <ScopeSharingDialog key={`${user?.id}:${scopeDialog.folderId}`} {...scopeDialog} onClose={()=>setScopeDialog(null)} onSaved={refreshed}/>}
      {bulkSharing && <BulkSharingDialog key={`${user?.id}:${bulkSharing.join(",")}`} slugs={bulkSharing} onClose={() => setBulkSharing(null)} onSaved={result => {
        restoreBulkFocus.current = true;
        setBulkSharing(null); refreshed();
        flash(result.pending || result.unchanged
          ? [result.updated ? countText(t, result.updated, "Updated sharing settings for {n} site", "Updated sharing settings for {n} sites") : "", result.unchanged ? t("{n} unchanged", { n: result.unchanged }) : ""].filter(Boolean).join(" · ")
          : countText(t, result.updated, "Updated sharing settings for {n} site", "Updated sharing settings for {n} sites"));
      }}/>}
      {moveDialog && <MoveSharingDialog key={`${user?.id}:${moveDialog.slugs.join(",")}`} initialPreview={moveDialog.initialPreview} slugs={moveDialog.slugs} folders={state.folders} initialFolderId={moveDialog.folderId} onClose={()=>setMoveDialog(null)} onSaved={refreshed}/>}
      {upload && <VersionUpload key={upload.slug} target={upload} onClose={() => setUpload(null)} onPublished={() => { learn("update"); onMutated?.(); router.refresh(); }} />}
      <button type="button" className="mobile-folders" aria-expanded={railOpen} aria-controls="folder-rail" onClick={() => setRailOpen((v) => !v)}>
        {t("Folders")} · {activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")} ▾
      </button>
      <div className={`work-layout my-sites-workspace${railOpen ? " folders-open" : ""}`}>
        {rail}
        <section className="work-content" aria-busy={navigation.pending || moving}>
          <div ref={dragImage} className="site-drag-image" aria-hidden="true"/>
          <div className="work-tools">
            <label className="searchbox">
              <Search size={16} aria-hidden="true" />
              <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder={t("Search site titles")} aria-label={t("Search my sites")} />
            </label>
            <span className="work-sort"><select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("Sort")}>
              <option value="updated">{t("Recently updated")}</option>
              <option value="title">{t("Title A–Z")}</option>
            </select><ChevronDown size={14} aria-hidden="true" /></span>
            <div className="view-switch">
              <button type="button" aria-label={t("List view")} aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} /></button>
              <button type="button" aria-label={t("Grid view")} aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={16} /></button>
            </div>
          </div>
          {directory?.sharingCounts && <div className="sharing-filters">
            <div className="sharing-filter-group" role="group" aria-label={t("Sharing status")}>
              {([ ["all", "All"], ["private", "Private"], ["shared", "Shared"] ] as const).map(([value, label]) =>
                <button type="button" key={value} aria-pressed={sharingFilter === value} onClick={() => { setSelectedSlugs([]); navigation.change("sharing", value); }}>
                  {t(label)} <span>{directory.sharingCounts![value]}</span>
                </button>)}
            </div>
            <SharingHelp label={t("Sharing status")}>{t("Shared means others currently have access, not that a link has been sent.")}</SharingHelp>
          </div>}
          {updateIntent && <div className="update-intent"><span>{t("Choose an artifact, then use its ⋯ menu to upload a new version.")}</span><button className="update-intent-dismiss" onClick={() => learn("update")}>{t("Got it")}</button></div>}
          {updateIntent && firstEditable && view === "list" && <Coachmark key={firstEditable.slug} name="update" selector='[data-update-hint="true"] .row-more' text={t("Use ⋯ → Upload new version for the artifact you want to update.")} />}
          <div className="folder-heading">
            <h2 ref={folderHeading} tabIndex={-1}>{activeFolder ? activeFolder.name : active === FILTER_UNFILED ? t("Unfiled") : t("All sites")}</h2>
            <span aria-live="polite">· {total}</span>
            {active === FILTER_ALL && shelf.mode === "account" && manage && <div className="folder-heading-actions"><button type="button" className={`folder-icon-action collection-share-action${sharingSummary.allShared ? " is-shared" : ""}`} aria-label={t("Share all sites")} title={t("Share all sites")} onClick={() => setScopeDialog({folderId:null})}><Share2 size={18}/></button></div>}
            {activeFolder && <div className="folder-heading-actions" role="group" aria-label={t("Folder actions")}>
              {shelf.mode === "account" && <button type="button" className={`folder-icon-action${sharingSummary.sharedFolders.includes(activeFolder.id) ? " is-shared" : ""}`} aria-label={t("Share folder")} title={t("Share folder")} onClick={() => setScopeDialog({folderId: activeFolder.id})}><Link2 size={18} /></button>}
              <button type="button" className="folder-icon-action" aria-label={t("Rename")} title={t("Rename")} onClick={() => startRename(activeFolder)}><Pencil size={18} /></button>
              <button type="button" className="folder-icon-action is-delete" aria-label={t("Delete folder")} title={t("Delete folder")} onClick={() => removeFolder(activeFolder)}><Trash2 size={18} /></button>
            </div>}
          </div>
          {selection.length > 0 && !canShareSelection && <p id="bulk-sharing-unavailable" className="scope-muted">{t("Select only sites whose sharing settings you can manage.")}</p>}
          {selection.length > 0 && <div className="scope-bulk-bar"><span>{t("{n} documents selected",{n:selection.length})}</span><button className="btn sm" aria-haspopup="dialog" disabled={moving || !canShareSelection} aria-describedby={!canShareSelection ? "bulk-sharing-unavailable" : undefined} onClick={() => setBulkSharing([...selection])}><Share2 size={14} aria-hidden="true"/>{t("Share")}</button><button className="btn sm" disabled={moving} onClick={()=>setMoveDialog({slugs:selection,folderId:activeFolder?.id??null})}>{t("Move documents")}</button><button className="quiet" onClick={()=>setSelectedSlugs([])}>{t("Cancel")}</button></div>}
          {moving && <p className="folder-note" role="status">{t("Moving artifacts…")}</p>}
          {hint && <p className="folder-note" role="status">{hint}</p>}
          {sharingOpening && <p className="folder-note directory-sharing-opening" role="status">{t("Opening sharing…")}</p>}
          {sharingError && <p className="folder-note directory-sharing-error" role="alert">{t("Could not open sharing. Try again.")} <button type="button" className="btn sm" onClick={() => void prepareSharing(sharingError)}>{t("Try again")}</button></p>}

          {pageItems.length === 0 ? empty : view === "grid" ? (
            <div className="result-grid">{pageItems.map(s => <div className={`site-card-wrap${selection.includes(s.slug) ? " is-selected" : ""}${dragging.includes(s.slug) ? " is-dragging" : ""}`}
              key={s.slug} data-slug={s.slug} draggable={!moving && !shelf.loading} onDragStart={e => startDrag(e, s.slug)} onDragEnd={endDrag}>
              <span className="site-card-select">{selectionBox(s)}</span>
              <ArtifactCard site={s} sharingStatus={<SharingStatus site={s}/>} actions={<MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly>
                {permissions[s.slug]?.canManageSharing && <button type="button" role="menuitem" className="menu-item" aria-haspopup="dialog" disabled={Boolean(sharingOpening)} onClick={event => openSharing(s, event.currentTarget)}><Share2 size={14} aria-hidden="true" />{t("Share")}</button>}
                <button type="button" role="menuitem" className="menu-item" onClick={() => void copyLink(s.slug)}><Link2 size={14} aria-hidden="true" />{t("Copy link")}</button>
                {permissions[s.slug]?.canReadSource && <SiteDownload slug={s.slug} editToken={tokens[s.slug]}/>}
                {canEdit(s.slug) && <button type="button" role="menuitem" className="menu-item" onClick={() => startUpload(s)}><FileUp size={14} aria-hidden="true" />{t("Upload new version")}</button>}
                {folderPicker(s)}
              </MoreMenu>}/>
            </div>)}</div>
          ) : (
            <div className={`site-list my-sites-list${directory?.sharingCounts ? " with-sharing-status" : ""}`}>
              <div className="list-header"><span>{t("Site")}</span><span className="row-views">{t("Total opens")}</span><span className="row-visibility">{t("Who can open")}</span>{directory?.sharingCounts && <span className="row-sharing">{t("Sharing status")}</span>}<span className="row-versions">{t("Versions")}</span><span className="row-date">{t("Updated")}</span><span /></div>
              {pageItems.map((s) => (
                <div className={`site-row${selection.includes(s.slug) ? " is-selected" : ""}${dragging.includes(s.slug) ? " is-dragging" : ""}`} draggable={!moving && !shelf.loading} onDragStart={e => startDrag(e, s.slug)} onDragEnd={endDrag} key={s.slug} data-slug={s.slug} data-update-hint={s.slug === firstEditable?.slug || undefined}>
                  <div className="site-name">
                    {selectionBox(s)}
                    <SiteLink slug={s.slug} href={`/s/${s.slug}`} className="mini" aria-hidden="true" tabIndex={-1}>
                      {s.kind === "document" ? <ArtifactCover site={s} /> : <ProgressivePreview key={`${s.slug}:${s.updatedAt}`} site={s} src={`/api/preview/${s.slug}?thumb=1`} />}
                    </SiteLink>
                    <div>
                      <strong><SiteLink slug={s.slug} href={`/s/${s.slug}`}>{s.title}</SiteLink></strong>
                      <small>{kindLabel(s.kind, t)}{s.takenDownAt ? ` · ${t("Taken down")}` : ""}</small>
                    </div>
                  </div>
                  <span className="row-views" data-label={t("Total opens")} title={t("All recorded opens, including your own and collaborators. New opens by the same reader within 30 minutes are combined across links; older records keep their original counting rules.")}>{s.totalViews == null ? "—" : s.totalViews.toLocaleString(locale)}</span>
                  <span className="row-visibility">
                    <span className="scope-row-audience" title={sharingSummary.states[s.slug] ? t(AUDIENCE_LABELS[sharingSummary.states[s.slug].policy.audience]) : undefined}>
                      {sharingSummary.states[s.slug] ? t(sharingSummary.states[s.slug].policy.audience === "public" ? "Public" : AUDIENCE_LABELS[sharingSummary.states[s.slug].policy.audience]) : <VisibilityCell site={s} t={t} />}
                    </span>
                    {sharingSummary.states[s.slug] && sharingSummary.states[s.slug].source !== "default" && <small className="scope-row-source" title={t(sharingSummary.states[s.slug].source === "folder" ? "Following folder" : sharingSummary.states[s.slug].source === "all" ? "Following my entire collection" : "Custom settings")}>
                      {t(sharingSummary.states[s.slug].source === "folder" ? "Following folder" : sharingSummary.states[s.slug].source === "all" ? "Following my entire collection" : "Custom settings")}
                    </small>}
                  </span>
                  {directory?.sharingCounts && <span className="row-sharing"><SharingStatus site={s} /></span>}
                  <SiteVersionCell key={`${s.slug}:${s.officialVersionId}:${s.versionCount}`} site={s} canManage={Boolean(permissions[s.slug]?.canManageSharing)} token={tokens[s.slug]} onMutated={onMutated} />
                  <span className="row-date">{relTime(s.updatedAt, t, locale)}</span>
                  <span className="row-menu-wrap">
                    <MoreMenu label={t("Actions for {title}", { title: s.title })} iconOnly buttonClassName="row-more" buttonContent="⋯">
                      {!permissions[s.slug] ? <button className="menu-item" role="menuitem" disabled={!permissionErrors.includes(s.slug)} onClick={retryPermissions}>{permissionErrors.includes(s.slug) ? <RefreshCw size={14} aria-hidden="true" /> : <Loader2 size={14} className="spin" aria-hidden="true" />}{t(permissionErrors.includes(s.slug) ? "Try again" : "Loading…")}</button> : <>
                      <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}`}><ArrowUpRight size={14} aria-hidden="true" />{t("Open")}</SiteLink>
                      {permissions[s.slug]?.canManageSharing && <button type="button" role="menuitem" className="menu-item" aria-haspopup="dialog" disabled={Boolean(sharingOpening)} onClick={event => openSharing(s, event.currentTarget)}><Share2 size={14} aria-hidden="true" />{t("Share")}</button>}
                      <button type="button" role="menuitem" className="menu-item" onClick={() => void copyLink(s.slug)}><Link2 size={14} aria-hidden="true" />{t("Copy link")}</button>
                      {permissions[s.slug]?.canReadSource && <SiteDownload slug={s.slug} editToken={tokens[s.slug]} />}
                      {canEdit(s.slug) && s.kind !== "document" && <SiteLink slug={s.slug} role="menuitem" className="menu-item" href={`/s/${s.slug}/edit`}><Pencil size={14} aria-hidden="true" />{t("Edit")}</SiteLink>}
                      {canEdit(s.slug) && <button type="button" role="menuitem" className="menu-item" onClick={() => startUpload(s)}><FileUp size={14} aria-hidden="true" />{t("Upload new version")}</button>}
                      <button type="button" role="menuitem" className="menu-item" disabled={!permissions[s.slug]?.canReadSource} onClick={() => void fork(s.slug)}><Copy size={14} aria-hidden="true" />{t("Save a copy")}</button>
                      {/* Not a menu item on purpose: choosing a folder keeps the menu open, so the row does not vanish under the pointer. */}
                      {folderPicker(s)}
                      {manageable(s.slug) && <button type="button" role="menuitem" className="menu-item danger" onClick={() => void remove(s.slug, s.title)}><Trash2 size={14} aria-hidden="true" />{t("Delete")}</button>}
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
