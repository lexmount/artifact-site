"use client";
import { AUDIENCE_LABELS } from "@/lib/sharing-policy";
import DocumentSharingSettings from "@/components/sharing/document-settings";
import { appPath, appFetch } from "@/lib/app-path";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronRight, Copy, Eye, Info, Link2, LockKeyhole, Globe, UserPlus, Maximize2, Minimize2, Share2, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import AuthorizationPanel from "@/components/authorization-panel";
import ShareLinks from "@/components/share-links";
import ShareViews from "@/components/share-views";
import { track } from "@/lib/analytics";
import { useAuth } from "@/lib/use-auth";
import { emptySharing, sharingResource, type CommentSettings } from "@/lib/sharing-cache";
import type { Visibility } from "@/lib/types";

export const ACCESS_LABEL: Record<Visibility, string> = {
  private: "Authorized people only", unlisted: "Anyone with the link", public: "Public (listed in Home — Discover sites)",
};
const ACCESS_HINT: Record<Visibility, string> = {
  private: "Add members or change access before sharing with more people.",
  unlisted: "Excluded from Explore and search results for unrelated people.",
  public: "Shown in Explore and discoverable through search.",
};
type Settings = CommentSettings;

/** Copy is read-only. Main access and independent links have separate explicit mutations. */
type SharePanelProps = { slug: string; visibility: Visibility; onOpenChange?: (open: boolean) => void; entry?: "main" | "views" };
export default function SharePanel(props: SharePanelProps) {
  const auth = useAuth();
  const identity = auth.user?.id ?? "anonymous";
  return <SharePanelContent key={`${props.slug}:${identity}`} {...props} identity={identity} authLoading={auth.loading}/>;
}
function SharePanelContent({ slug, visibility: initialVisibility, onOpenChange, entry = "main", identity, authLoading }: SharePanelProps & { identity: string; authLoading: boolean }) {
  const t = useT(), router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"main" | "links" | "views" | "members">("main");
  const [expanded, setExpanded] = useState(false);
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const helpTip = useRef<HTMLSpanElement>(null);
  const authorizationState = useRef({ editing: false, busy: false });
  const onAuthorizationState = useCallback((editing: boolean, busy: boolean) => { authorizationState.current = { editing, busy }; }, []);
  const resource = useMemo(() => sharingResource(identity, slug), [identity, slug]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, () => emptySharing);
  const { sharing, comments: settings } = snapshot;
  const visibility = sharing?.visibility ?? initialVisibility;
  const siteId = sharing?.siteId ?? "";
  const ready = !!sharing;
  const [selection, setSelection] = useState<Visibility | null>(null);
  const draft = selection ?? visibility;
  const [addMember, setAddMember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!helpOpen || !open || tab !== "main") return;
    const place = () => {
      const tip = helpTip.current, trigger = helpTrigger.current, dialog = dialogRef.current;
      if (!tip || !trigger || !dialog) return;
      const bounds = dialog.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8), right = Math.min(window.innerWidth - 8, bounds.right - 8);
      const top = Math.max(8, bounds.top + 8), bottom = Math.min(window.innerHeight - 8, bounds.bottom - 8);
      tip.style.width = `${Math.min(280, right - left)}px`;
      tip.style.maxHeight = `${bottom - top}px`;
      const size = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(left, Math.min(anchor.left + anchor.width / 2 - size.width / 2, right - size.width))}px`;
      const above = anchor.top - size.height - 8;
      tip.style.top = `${Math.max(top, Math.min(above >= top ? above : anchor.bottom + 8, bottom - size.height))}px`;
      tip.style.visibility = "visible";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [helpOpen, open, tab]);
  const lastTab = useRef(tab);
  useEffect(() => {
    if (open && lastTab.current !== tab) {
      const target = tab === "members" && addMember ? ".authorization-form select" : "h2";
      dialogRef.current?.querySelector<HTMLElement>(target)?.focus();
    }
    lastTab.current = tab;
  }, [open, tab, addMember]);
  const mainState = useRef({editing:false,busy:false});
  const [mainBlocked, setMainBlocked] = useState(false);
  const onMainState = useCallback((editing:boolean,busy:boolean,unavailable:boolean) => { mainState.current={editing,busy}; setMainBlocked(editing || busy || unavailable); },[]);
  const linkDirty = useRef(false);
  const accessPending = selection !== null;
  const busyRef = useRef(false);
  const canLeave = () => !dialogRef.current?.querySelector("dialog[open]") && !busy && !mainState.current.busy && !authorizationState.current.busy && (!(mainState.current.editing || linkDirty.current || authorizationState.current.editing) || window.confirm(t("Discard unsaved sharing changes? Saved settings will stay unchanged.")));
  const close = () => { if (canLeave()) { setSelection(null); linkDirty.current = false; setOpen(false); } };

  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[aria-label="' + t("Close") + '"]')?.focus();
    return () => { dialog?.close(); previous?.focus(); };
  }, [open, t]);
  useEffect(() => {
    if (authLoading || entry !== "main") return;
    // Defer below the viewer's initial work. Hover/focus and opening can start it sooner.
    const timer = window.setTimeout(() => { void resource.load(); }, 400);
    return () => window.clearTimeout(timer);
  }, [authLoading, entry, resource, snapshot.resetVersion]);
  useEffect(() => {
    if (!open || entry !== "main" || authLoading) return;
    void resource.load();
  }, [open, entry, authLoading, resource, snapshot.resetVersion]);
  useEffect(() => {
    if (entry !== "main") return;
    const refresh = () => { if (!authLoading && !busyRef.current) void resource.load(true); };
    window.addEventListener("focus", refresh);
    window.addEventListener("artifact:shares-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("artifact:shares-changed", refresh);
    };
  }, [entry, authLoading, resource]);
  useEffect(() => {
    if (!accessPending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [accessPending]);

  function navigate(next: typeof tab) {
    if (!canLeave()) return false;
    setSelection(null); linkDirty.current = false; setTab(next); setAddMember(false); setNotice(null); setError(null);
    return true;
  }
  async function saveAccess(next: Visibility) {
    if (busyRef.current || !sharing || snapshot.sharingError || next === visibility) return;
    const commit = resource.captureMutation();
    busyRef.current = true; setBusy(true); setError(null); setNotice(null); setSelection(next);
    try {
      const response = await appFetch(`/api/sites/${slug}/sharing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: next }) });
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) resource.clear(); throw new Error((await response.json()).error ?? t("Failed to save")); }
      if (!commit({ sharing: { ...sharing, visibility: next } })) return; setNotice(t("Access updated")); router.refresh();
      void resource.load();
      window.dispatchEvent(new Event("artifact:shares-changed"));
    } catch (cause) { setError(t("Could not update access. Please try again.") + " " + (cause instanceof Error ? cause.message : t("Request failed"))); }
    finally { setSelection(null); busyRef.current = false; setBusy(false); }
  }
  async function saveComments(mainPolicy: Settings["mainPolicy"]) {
    if (!settings || busyRef.current || snapshot.sharingError || snapshot.commentsError) return;
    const commit = resource.captureMutation();
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const response = await appFetch(`/api/sites/${slug}/comment-settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainPolicy }) });
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) resource.clear(); throw new Error((await response.json()).error ?? t("Failed to save")); }
      if (!commit({ comments: await response.json() })) return; setNotice(t("Comment settings saved"));
      void resource.load();
      window.dispatchEvent(new Event("artifact:shares-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Request failed")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url); track("share_link_copy", { share_type: "canonical" }); setNotice(t(visibility === "private" ? "Link copied · only authorized people can open it" : "Link copied")); }
    catch { setNotice(t("Automatic copy failed. Select and copy the address below.")); }
  }
  return <>
    <button role={entry === "views" ? "menuitem" : undefined} className={entry === "views" ? "menu-item" : "btn primary"} data-analytics-button={entry === "main" ? "share" : undefined} aria-haspopup="dialog" aria-expanded={open} onMouseEnter={() => { if (entry === "main" && !authLoading) void resource.load(); }} onFocus={() => { if (entry === "main" && !authLoading) void resource.load(); }} onClick={() => { setUrl(`${window.location.origin}${appPath(`/s/${slug}`)}`); setTab(entry); setExpanded(false); setSelection(null); setHelpOpen(false); setError(null); setNotice(null); setOpen(true); }}>{entry === "views" ? <Eye size={14}/> : <Share2 size={14}/>} {t(entry === "views" ? "View history" : "Sharing")}</button>
    {open && createPortal(<dialog ref={dialogRef} className={`sharing-dialog ${tab === "main" ? "is-main" : "is-advanced"} ${expanded && tab !== "main" ? "is-expanded" : ""}`} aria-label={t(tab === "main" ? "Share artifact" : tab === "members" ? "Members and collaborators" : tab === "views" ? "View history" : "Advanced sharing")}
      onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}>
      <header className="sharing-dialog-head">
        <div>{tab !== "main" && entry !== "views" && <button className="btn sm ghost" onClick={() => navigate("main")}><ArrowLeft size={14}/>{t("Back to sharing")}</button>}
          <h2 tabIndex={-1}>{t(tab === "main" ? "Share artifact" : tab === "members" ? "Members and collaborators" : tab === "views" ? "View history" : "Advanced sharing")}</h2></div>
        <div className="share-window-actions">{tab !== "main" && <button className="btn sm ghost" aria-label={t(expanded ? "Collapse" : "Expand")} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>}<button className="btn sm ghost" aria-label={t("Close")} onClick={close}><X size={18}/></button></div>
      </header>
      {tab === "links" && <div className="drawer-tabs" role="tablist" aria-label={t("Advanced sharing")}><button role="tab" aria-selected="true">{t("Share links")}</button></div>}
      <div className="sharing-dialog-body">
        {error && <p className="share-error" role="alert">{error}</p>}
        {notice && <p className="sharing-notice" role="status">{notice}</p>}
        {tab !== "views" && (snapshot.sharingError || snapshot.commentsError) && <div className="sharing-fetch-error" role="alert"><span>{t(snapshot.sharingError ? "Could not refresh access. Retry before changing settings." : "Could not load comment settings.")}</span><button className="btn sm" disabled={snapshot.sharingError ? snapshot.sharingPending : snapshot.commentsPending} onClick={() => void resource.load(true)}>{t("Try again")}</button></div>}
        {tab === "main" && <>
          <section className="sharing-members sharing-section">
            <div className="sharing-members-head"><h3>{t("Members and collaborators")}</h3>
              {sharing?.canManageMembers && <button className="sharing-manage" onClick={() => navigate("members")} disabled={snapshot.sharingError}>
                <span className="sharing-avatars" aria-label={t("Directly authorized members")}>
                  {sharing.members.map(member => <span className="sharing-avatar" key={member.id} title={member.name ?? t("Member")}>{Array.from(member.name ?? "?")[0]}</span>)}
                  {sharing.moreMembers && <span className="sharing-avatar" aria-hidden="true">…</span>}
                </span><span>{t("Manage members")}</span><ChevronRight size={14}/>
              </button>}
            </div>
            <button className="sharing-navigation sharing-add" disabled={!sharing?.canManageMembers || snapshot.sharingError} onClick={() => { if (navigate("members")) setAddMember(true); }}><span><UserPlus size={17}/>{t("Add members")}</span><ChevronRight size={17}/></button>
          </section>
          {identity !== "anonymous" ? <DocumentSharingSettings slug={slug} disabled={!ready || snapshot.sharingError} onStateChange={onMainState} onSaved={() => { setNotice(t("Access updated")); void resource.load(true); router.refresh(); }}/> : <>
          <section className="sharing-section sharing-access">
            <h3>{t("Link sharing")}</h3>
            {ready ? <>
              <div className="sharing-audience"><span className="sharing-audience-icon" aria-hidden="true">{draft === "private" ? <LockKeyhole size={19}/> : draft === "public" ? <Globe size={19}/> : <Link2 size={19}/>}</span><div>
                <span className="sharing-audience-label" aria-hidden="true">{t(ACCESS_LABEL[draft])}<ChevronDown size={15}/></span>
                <p id="main-access-hint">{t(ACCESS_HINT[draft])}</p>
              </div>
                <select id="main-access" aria-label={t("Who can access")} aria-describedby="main-access-hint" value={draft} disabled={busy || snapshot.sharingError} onChange={event => void saveAccess(event.target.value as Visibility)}>
                  {(["private", "unlisted", "public"] as const).map(value => <option key={value} value={value}>{t(ACCESS_LABEL[value])}</option>)}
                </select>
              </div>
              {accessPending && <p role="status">{t("Saving access…")}</p>}
            </> : <div className="sharing-skeleton sharing-audience-skeleton" role="status" aria-label={t("Loading sharing settings")}><span/><span/></div>}
            {settings && ready ? <div className="sharing-comment-settings">
              {settings.readerAccess ? <>
                <div className="sharing-toggle-row"><label htmlFor="main-comments">{t("Allow comments")}</label><input id="main-comments" type="checkbox" role="switch" checked={settings.mainPolicy !== "off"} disabled={busy || snapshot.sharingError || snapshot.commentsError} onChange={event => void saveComments(event.target.checked ? "login" : "off")}/></div>
                <p>{t(settings.mainPolicy === "off" ? "New comments and replies are paused. Existing discussions remain readable." : "Readers can see comments. Sign in to post.")}</p>
              </> : <>
                <div className="sharing-legacy-row"><label htmlFor="legacy-comments">{t("Comment permissions")}</label>
                  <select id="legacy-comments" value={settings.mainPolicy} disabled={busy || snapshot.sharingError || snapshot.commentsError} onChange={event => void saveComments(event.target.value as Settings["mainPolicy"])}>
                    <option value="login">{t("Signed-in readers")}</option><option value="members">{t("Site members")}</option><option value="off">{t("Off")}</option>
                  </select></div>
                <details className="sharing-comment-help"><summary>{t("About comment permissions")}</summary><p>{t("This existing artifact keeps its original discussion visibility.")}</p></details>
              </>}
            </div> : !snapshot.commentsUnavailable && <div className="sharing-skeleton sharing-comments-skeleton" role="status" aria-label={t("Loading comment settings")}><span/></div>}
          </section>
          </>}
            <div className="sharing-advanced-entry">
              <div className="sharing-advanced-label"><b id={`${helpId}-label`}>{t("Advanced sharing")}</b><span className="sharing-help" onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}><button ref={helpTrigger} type="button" className="btn sm ghost" aria-label={t("About advanced sharing")} aria-describedby={helpOpen ? helpId : undefined} onFocus={() => setHelpOpen(true)} onBlur={() => setHelpOpen(false)} onClick={() => setHelpOpen(true)} onKeyDown={event => { if (event.key === "Escape" && helpOpen) { event.preventDefault(); event.stopPropagation(); setHelpOpen(false); } }}><Info size={14}/></button></span></div>
              <small id={`${helpId}-description`}>{t("Manage / create advanced share links")}</small>
              <button className="sharing-navigation" aria-labelledby={`${helpId}-label ${helpId}-description`} disabled={!ready || snapshot.sharingError} onClick={() => navigate("links")}><ChevronRight size={17}/></button>
            </div>
          </>}
          {tab === "members" && siteId && <fieldset className="sharing-subpanel" disabled={snapshot.sharingError}><AuthorizationPanel resource={{ type: "site", id: siteId }} inline initialAdd={addMember} onSaved={() => { resource.update({}); void resource.load(true); }} onStateChange={onAuthorizationState}/></fieldset>}
          {tab === "views" && <ShareViews slug={slug}/>}
          {tab === "links" && ready && <fieldset className="sharing-subpanel" disabled={snapshot.sharingError}>
            <ShareLinks slug={slug} visibility={visibility} onDirtyChange={value => { linkDirty.current = value; }} onRequestPrivate={() => { if (canLeave()) { linkDirty.current = false; setTab("main"); void saveAccess("private"); } }}/>
            <p className="sharing-description"><Link2 size={13}/> {t("Main link access")}: {t(sharing?.mainAudience ? AUDIENCE_LABELS[sharing.mainAudience] : ACCESS_LABEL[visibility])}</p>
          </fieldset>}
      </div>
      {tab === "main" && <footer className="sharing-copy">
        <div className="sharing-copy-row"><input id="main-link" aria-label={t("Artifact link")} value={url} readOnly onFocus={event => event.currentTarget.select()}/>
          <button className="btn solid" disabled={busy || mainBlocked || !url || !ready || snapshot.sharingError} onClick={() => void copy()}><Copy size={15}/>{t("Copy link")}</button></div>
      </footer>}
      {helpOpen && tab === "main" && <span ref={helpTip} id={helpId} role="tooltip" className="sharing-tooltip">{t("Advanced links can specify audiences and expiry. Comments and replies are isolated by link.")}</span>}
    </dialog>, document.body)}
  </>;
}
