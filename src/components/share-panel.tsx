"use client";
import DocumentSharingSettings from "@/components/sharing/document-settings";
import SharingMore from "@/components/sharing/sharing-more";
import SharingHelp from "@/components/sharing/sharing-help";
import { useDocumentSharing } from "@/components/sharing/use-document-sharing";
import { accessAudience, MAIN_ACCESS_LABELS } from "@/components/sharing/main-sharing-model";
import { appPath } from "@/lib/app-path";
import { menuPosition } from "@/lib/menu-position";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, ChevronRight, Copy, Eye, Link2, Loader2, Maximize2, Minimize2, Share2, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import AuthorizationPanel from "@/components/authorization-panel";
import ShareLinks from "@/components/share-links";
import ShareViews from "@/components/share-views";
import { track } from "@/lib/analytics";
import { useAuth } from "@/lib/use-auth";
import { emptySharing, sharingResource } from "@/lib/sharing-cache";
import type { SharingState } from "@/lib/sharing-policy";
import type { Visibility } from "@/lib/types";

type SharePanelProps = {
  slug: string;
  visibility: Visibility;
  onOpenChange?: (open: boolean) => void;
  entry?: "main" | "views";
  /** A directory menu launches the same card without rendering another trigger. */
  anchor?: HTMLElement;
  onClose?: () => void;
};
export default function SharePanel(props: SharePanelProps) {
  const auth = useAuth();
  const identity = auth.user?.id ?? "anonymous";
  return <SharePanelContent key={`${props.slug}:${identity}`} {...props} identity={identity} authLoading={auth.loading}/>;
}
function SharePanelContent({ slug, visibility: initialVisibility, onOpenChange, entry = "main", anchor: externalAnchor, onClose, identity, authLoading }: SharePanelProps & { identity: string; authLoading: boolean }) {
  const t = useT(), router = useRouter();
  const [open, setOpen] = useState(Boolean(externalAnchor));
  const [tab, setTab] = useState<"main" | "links" | "views" | "members">("main");
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<"follow" | "stop" | "private" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [url, setUrl] = useState(() => externalAnchor ? `${window.location.origin}${appPath(`/s/${slug}`)}` : "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const authorizationState = useRef({ editing: false, busy: false });
  const onAuthorizationState = useCallback((editing: boolean, busy: boolean) => { authorizationState.current = { editing, busy }; }, []);
  const resource = useMemo(() => sharingResource(identity, slug), [identity, slug]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, () => emptySharing);
  const { sharing } = snapshot;
  const main = useDocumentSharing(slug, open && entry === "main" && !authLoading);
  const { data, busy } = main;
  const visibility = sharing?.visibility ?? initialVisibility;
  const ready = !!sharing && !!data && !main.unavailable && !snapshot.sharingError;
  const linkDirty = useRef(false);
  const canLeave = () => !dialogRef.current?.querySelector("dialog[open]") && !busy && !authorizationState.current.busy && (!(linkDirty.current || authorizationState.current.editing) || window.confirm(t("Discard unsaved sharing changes? Saved settings will stay unchanged.")));
  const close = () => { if (canLeave()) { linkDirty.current = false; setOpen(false); onClose?.(); } };
  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return;
    const previous = externalAnchor ?? document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current, trigger = externalAnchor ?? triggerRef.current;
    let anchor = trigger?.getBoundingClientRect();
    dialog?.showModal();
    // Keep the main card attached to its trigger even as the toolbar wraps or the card grows.
    const place = () => {
      if (!dialog || !trigger || !anchor) return;
      if (trigger.isConnected) anchor = trigger.getBoundingClientRect();
      const { width, height } = dialog.getBoundingClientRect();
      if (externalAnchor) {
        // A filtered row may disappear after saving; retain its last visible anchor.
        const viewport = window.visualViewport;
        const position = menuPosition(anchor, width, height, { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight });
        dialog.style.setProperty("--sharing-top", `${position.top}px`);
        dialog.style.setProperty("--sharing-right", `${innerWidth - position.left - width}px`);
        return;
      }
      const right = Math.min(Math.max(12, window.innerWidth - anchor.right), Math.max(12, window.innerWidth - width - 12));
      dialog.style.setProperty("--sharing-top", `${Math.max(12, anchor.bottom + 8)}px`);
      dialog.style.setProperty("--sharing-right", `${right}px`);
    };
    place();
    dialog?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place), toolbar = trigger?.closest("header");
    if (dialog) observer.observe(dialog);
    if (trigger) observer.observe(trigger);
    if (toolbar) observer.observe(toolbar);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    toolbar?.addEventListener("transitionend", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      toolbar?.removeEventListener("transitionend", place);
      dialog?.close(); previous?.focus({ preventScroll: true });
    };
  }, [open, externalAnchor]);
  const lastTab = useRef(tab);
  useEffect(() => {
    if (open && lastTab.current !== tab) dialogRef.current?.querySelector<HTMLElement>("h2")?.focus();
    lastTab.current = tab;
  }, [open, tab]);
  useEffect(() => {
    if (authLoading || entry !== "main") return;
    const timer = window.setTimeout(() => { void resource.load(); }, 400);
    return () => window.clearTimeout(timer);
  }, [authLoading, entry, resource, snapshot.resetVersion]);
  useEffect(() => {
    if (open && entry === "main" && !authLoading) void resource.load();
  }, [open, entry, authLoading, resource, snapshot.resetVersion]);
  useEffect(() => {
    if (entry !== "main") return;
    const refresh = () => { if (!authLoading && !busy) void resource.load(true); };
    window.addEventListener("focus", refresh);
    window.addEventListener("artifact:shares-changed", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("artifact:shares-changed", refresh); };
  }, [entry, authLoading, resource, busy]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  function navigate(next: typeof tab) {
    if (!canLeave()) return false;
    linkDirty.current = false; setTab(next); setAction(null); setCopyNotice(null); setCopyFailed(false);
    if (next === "main") { void main.load(); void resource.load(true); }
    return true;
  }

  function saved(state: SharingState) {
    if (sharing) resource.update({
      sharing: { ...sharing, mainAudience: state.policy.audience, visibility: state.policy.audience === "public" ? "public" : state.policy.audience === "anyone" ? "unlisted" : "private" },
    });
    setNotice(t("Sharing settings updated"));
    void resource.load(true);
    router.refresh();
    window.dispatchEvent(new Event("artifact:shares-changed"));
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(data?.policy.audience === "passcode" && data.passcode ? `${url}\n${t("Passcode")}: ${data.passcode}` : url);
      track("share_link_copy", { share_type: "canonical" });
      setCopyFailed(false);
      setCopyNotice(t(data?.policy.audience === "private" ? "Link copied · only authorized people can open it" : "Link copied"));
    } catch { setCopyFailed(true); setCopyNotice(t("Automatic copy failed. Select and copy the address below.")); }
  }
  const title = t(tab === "main" ? "Share artifact" : tab === "members" ? "Permission settings" : tab === "views" ? "View history" : "Independent sharing links");
  const openLinks = () => { navigate("links"); };
  return <>
    {!externalAnchor && <button ref={triggerRef} role={entry === "views" ? "menuitem" : undefined} className={entry === "views" ? "menu-item" : "btn primary"} data-analytics-button={entry === "main" ? "share" : undefined} aria-haspopup="dialog" aria-expanded={open}
      onMouseEnter={() => { if (entry === "main" && !authLoading) void resource.load(); }} onFocus={() => { if (entry === "main" && !authLoading) void resource.load(); }}
      onClick={() => { setUrl(`${window.location.origin}${appPath(`/s/${slug}`)}`); setTab(entry); setExpanded(false); setAction(null); setNotice(null); setCopyNotice(null); setCopyFailed(false); setOpen(true); }}>
      {entry === "views" ? <Eye size={14}/> : <Share2 size={14}/>} {t(entry === "views" ? "View history" : "Sharing")}
    </button>}
    {open && createPortal(<dialog ref={dialogRef} className={`sharing-dialog ${tab === "main" ? "is-main" : "is-advanced"} ${externalAnchor ? "is-directory" : ""} ${expanded && tab !== "main" ? "is-expanded" : ""}`} aria-label={title}
      onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}>
      <header className="sharing-dialog-head">
        <div>{tab !== "main" && entry !== "views" && <button className="btn sm ghost" onClick={() => navigate("main")}><ArrowLeft size={14}/>{t("Back to sharing")}</button>}
          <div className="sharing-dialog-title"><h2 tabIndex={-1}>{title}</h2>
            {tab === "main" && (data?.source === "folder" || data?.source === "all") && <SharingHelp label={title}>{t(data.source === "folder"
              ? "Using the sharing settings for folder “{name}”. Shared changes sync to this artifact. Changes made here apply independently."
              : "Using the creator's all-sites sharing settings. Shared changes sync to this artifact. Changes made here apply independently.", { name: data.sourceName ?? "" })}</SharingHelp>}
          </div></div>
        <div className="share-window-actions">
          {tab === "main" && <SharingMore data={data} disabled={!ready || busy} onLinks={openLinks} onMembers={sharing?.canManageMembers ? () => { navigate("members"); } : undefined} onFollow={() => setAction("follow")} onStop={() => setAction("stop")}/>}
          {tab !== "main" && <button className="btn sm ghost" aria-label={t(expanded ? "Collapse" : "Expand")} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>}
          <button className="btn sm ghost" aria-label={t("Close")} disabled={busy} onClick={close}><X size={18}/></button>
        </div>
      </header>
      <div className="sharing-dialog-body">
        {tab !== "views" && snapshot.sharingError && <div className="sharing-fetch-error" role="alert"><span>{t("Could not refresh access. Retry before changing settings.")}</span><button className="btn sm" disabled={snapshot.sharingPending} onClick={() => void resource.load(true)}>{t("Try again")}</button></div>}
        {tab === "main" && <>
          <div className="sharing-configuration">
            <DocumentSharingSettings controller={main} preserveDiscussionVisibility={snapshot.comments?.readerAccess !== true || snapshot.comments.mainPolicy === "members"} disabled={!sharing || snapshot.sharingError} action={action} onActionChange={setAction} onSaved={saved} onUpdating={() => { setNotice(null); setCopyNotice(null); }}/>
            <div className={`sharing-status${busy ? " is-updating" : notice ? " is-updated" : ""}`} role="status" aria-live="polite">
              {busy ? <><Loader2 size={15} className="spin"/>{t("Updating permissions…")}</> : notice ? <><CheckCircle2 size={15}/>{notice}</> : null}
            </div>
          </div>
        </>}
        {tab === "members" && sharing?.siteId && <fieldset className="sharing-subpanel" disabled={snapshot.sharingError}>
          <AuthorizationPanel resource={{ type: "site", id: sharing.siteId }} inline onSaved={() => { setNotice(t("Sharing settings updated")); resource.update({}); void resource.load(true); void main.load(); window.dispatchEvent(new CustomEvent("artifact:shares-changed", { detail: { slug } })); }} onStateChange={onAuthorizationState}/>
        </fieldset>}
        {tab === "views" && <ShareViews slug={slug}/>}
        {tab === "links" && sharing && <fieldset className="sharing-subpanel" disabled={snapshot.sharingError}>
          <p className="sharing-description">{t("Each link has its own access and comment settings. Main link settings do not override them.")}</p>
          <ShareLinks slug={slug} visibility={visibility} onDirtyChange={value => { linkDirty.current = value; }} onRequestPrivate={() => { if (navigate("main")) setAction("private"); }}/>
          {data && <p className="sharing-description"><Link2 size={13}/> {t("Main link access")}: {t(MAIN_ACCESS_LABELS[accessAudience(data.policy)])}</p>}
        </fieldset>}
      </div>
      {tab === "main" && <footer className="sharing-copy">
        <div className="sharing-copy-row">
          <div className="sharing-links-help">
            <button className="sharing-links-entry" disabled={!ready || busy} onClick={openLinks}><span>{t("Independent sharing links")}{data && data.links > 0 ? ` (${data.links})` : ""}</span><ChevronRight size={15}/></button>
            <SharingHelp label={t("Independent sharing links")}>{t("Set access and expiry for each link. Comments are separate for each link.")}</SharingHelp>
          </div>
          <button className="btn solid sharing-copy-button" disabled={busy || !url || !ready} onClick={() => void copy()}><Copy size={15}/>{t(data?.policy.audience === "passcode" ? "Copy link and passcode" : "Copy link")}</button>
        </div>
        {copyNotice && <p role="status">{copyNotice}</p>}
        {copyFailed && <input className="sharing-copy-fallback" aria-label={t("Artifact link")} value={data?.policy.audience === "passcode" && data.passcode ? `${url} ${t("Passcode")}: ${data.passcode}` : url} readOnly onFocus={event => event.currentTarget.select()}/>}
      </footer>}
    </dialog>, document.body)}
  </>;
}
