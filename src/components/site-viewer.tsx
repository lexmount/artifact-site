"use client";
import { siteFetch as fetch } from "@/lib/share-context";
import { useSitePermissions } from "@/lib/site-permissions";


import SiteDownload from "@/components/site-download";

// Viewer chrome for /s/[slug]: the site runs FULL-SCREEN in a sandboxed iframe, and the chrome
// (inline-editable title · meta · copy-link · save-as-new-site · version history · sharing · edit · device toggle ·
// open-in-new) floats over it, revealed on demand. The iframe never gets allow-same-origin — the
// served HTML already carries its own sandbox CSP.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import VisibilityChip from "@/components/visibility-chip";
import Link from "next/link";
import type { Visibility } from "@/lib/types";
import { Pencil, ExternalLink, ArrowLeft, Monitor, Tablet, Smartphone, Copy, FileUp, Loader2, Share2, ChevronDown, ChevronUp, Lock, MousePointer2, MousePointerClick } from "lucide-react";
import { Dwell, hoverArmsReveal, leaveSchedulesHide, modeAutoHides, barModeStore } from "@/lib/bar-mode";
import VersionHistory, { drawerHost } from "@/components/version-history";
import AdminActivity from "@/components/admin-activity";
import SharePanel from "@/components/share-panel";
import type { SitePermissions } from "@/lib/authz";
import AuthButton from "@/components/auth-button";
import LockedAction from "@/components/locked-action";
import MoreMenu from "@/components/more-menu";
import LoginGate, { type GateAction } from "@/components/login-gate";
import { useStoredToken, rememberEditToken } from "@/lib/edit-token";
import { ARTIFACT_REFRESH_EVENT } from "@/components/site-version-watcher";
import { useLocale, useT } from "@/components/locale-provider";
import { loginHref } from "@/lib/use-auth";
import { countText, formatDate } from "@/lib/i18n";

type Device = "desktop" | "tablet" | "mobile";
const DEVICES: { id: Device; label: string; icon: typeof Monitor }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "mobile", label: "Mobile", icon: Smartphone },
];

/** Wait a moment after the pointer leaves the action bar before hiding it — a bar that flickers at every hand twitch is worse than none. */
const HIDE_DELAY = 700;
/** Keep the action bar visible for a moment on landing: after going full-screen it is the only entry point, and the user has to learn where it lives. */
const INTRO_HOLD = 2600;

/**
 * Revealing the action bar on hover only holds for a real mouse.
 *
 * A tap on a touch screen synthesizes a whole run of mouse events: pointerenter → mousedown → mouseup → click. The old
 * implementation hung the reveal on enter, so a single tap first opened the bar, and the click right behind it already
 * read "open" and closed it again — on a phone the bar flashed and shrank back, requiring a second tap. Worse, once
 * expanded `.fs-hotzone` becomes display:none, so that click gets re-dispatched to whatever element slid in underneath,
 * which could turn the title straight into the rename input.
 *
 * The check has to live at the hover entry point and must not be pushed into revealBar: the handle (.fs-handle) also
 * calls revealBar on touch screens, and a blanket check there would kill the only entry point touch users have.
 */
export function isHoverPointer(pointerType: string): boolean {
  return pointerType === "mouse";
}

/**
 * The single criterion for auto-hide. An open drawer (version history / sharing settings) must also block it: drawers
 * are rendered by components inside the action bar, and as soon as focus lands on non-focusable text inside a drawer
 * (a version timestamp, the "No versions yet." line), or on the target=_blank "Preview this version" link,
 * onBlurCapture would wipe focusHeld and schedule a hide.
 */
export function shouldAutoHideBar(hold: { focusHeld: boolean; drawerOpen: boolean }): boolean {
  return !hold.focusHeld && !hold.drawerOpen;
}

/**
 * How drawer open/close affects the action bar. Only the "none → some / some → none" transitions move the bar: child
 * components report a false once on mount, and taking every report at face value would immediately schedule a 700ms
 * hide, cutting off the 2.6s intro hold on landing.
 */
export function drawerHoldEffect(before: number, after: number): "reveal" | "hide" | null {
  if ((before > 0) === (after > 0)) return null;
  return after > 0 ? "reveal" : "hide";
}

export default function SiteViewer(props: {
  visibility: Visibility;
  permissions: SitePermissions;
  slug: string; title: string; kind: "single" | "folder" | "document"; versionCount: number; published?: boolean;
  /** Non-null when an administrator took the site down: this viewer can still see it (owner, collaborator, admin) and is told why. */
  takenDownReason?: string | null;
  /** For the anonymous creator: when this unclaimed site will be removed. Null when owned, or when expiry is off. */
  expiresAt?: number | null;
  canSignIn?: boolean;
}) {
  const { slug, kind, published } = props;
  const permissions = useSitePermissions(slug, props.permissions)!;
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const [device, setDevice] = useState<Device>("desktop");
  const [title, setTitle] = useState(props.title);
  const [versionCount, setVersionCount] = useState(props.versionCount);
  const [frameKey, setFrameKey] = useState(0); // bump to reload the preview after a rollback

  // Someone landed a new version while this page was open (see site-version-watcher): swap the
  // artifact frame in place. Deliberately NOT a page reload — the reader may be mid-conversation
  // with the assistant that produced this very change.
  useEffect(() => {
    const onRefresh = () => setFrameKey((k) => k + 1);
    window.addEventListener(ARTIFACT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ARTIFACT_REFRESH_EVENT, onRefresh);
  }, []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const [forking, setForking] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const docInput = useRef<HTMLInputElement | null>(null);
  // A local anonymous receipt is submitted to the server; it never enables UI actions by itself.
  const editToken = useStoredToken(slug);

  const [gate, setGate] = useState<GateAction | null>(null);

  // Document sites have no edit semantics (the wrapper page is generated, the original is binary), so the entry point is not drawn at all; the server refuses too (editSite).
  const canDownload = Boolean(permissions.canReadSource);
  const mayEdit = kind !== "document" && permissions.canEditContent;

  const titleInput = useRef<HTMLInputElement | null>(null);
  // Seed the toast from the ?published flag; the effect below auto-clears whatever is shown.
  // The first sentence the user reads after publishing. On a private deployment it has to tell the truth: right now
  // only you can open this address, anyone else gets a 404 — letting people believe "published means shareable" is
  // the easiest misunderstanding this change could create.
  const [toast, setToast] = useState<string | null>(
    published
      ? (props.visibility === "private"
          ? t("Published · Only you can open it for now. Create a share link under Sharing settings before sending it to others")
          : t("Published · Copy the link under Sharing settings"))
      : null,
  );

  // ── Floating action bar ─────────────────────────────────────────────────────
  // Once full-screen, the iframe fills the viewport and the action bar can only float above it. The easiest way to
  // get this wrong: as soon as the mouse enters the iframe, the parent page stops receiving mousemove/mouseover
  // entirely (the child document swallows every event), so "show when the mouse reaches the top" cannot be built by
  // watching the mouse position on document. The fix is to always keep a strip of the parent page's own element
  // (.fs-chrome, only a dozen or so pixels tall when collapsed) on top of the iframe: a pointer moving up out of the
  // iframe is guaranteed to hit it first, so pointerenter fires normally on the parent; hiding likewise relies on its
  // pointerleave, never on any coordinate math.
  // (Only pointerType==="mouse" counts; touch goes through the hotzone/handle click below — see isHoverPointer.)
  // The hotzone is deliberately thin because it steals clicks from the same-height top strip of the artifact — the
  // artifact's own top bar must not be rendered unusable.
  const [barOpen, setBarOpen] = useState(true);
  /** Reveal-mode preference, living in localStorage. The server snapshot is always the default (manual); after hydration it switches to whatever this browser remembers. */
  const barMode = useSyncExternalStore(barModeStore.subscribe, barModeStore.getSnapshot, barModeStore.getServerSnapshot);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  /** While focus rests inside the action bar (keyboard users), every auto-hide must yield. */
  const focusHeld = useRef(false);
  /** The drawers currently open. Drawers are already portaled to body; this is the second safety net: the bar collapsing must not take them along. */
  const openDrawers = useRef<Set<string>>(new Set());

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);
  const scheduleHide = useCallback((delay: number = HIDE_DELAY) => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (!shouldAutoHideBar({ focusHeld: focusHeld.current, drawerOpen: openDrawers.current.size > 0 })) return;
      setBarOpen(false);
    }, delay);
  }, [cancelHide]);
  const revealBar = useCallback(() => { cancelHide(); setBarOpen(true); }, [cancelHide]);
  /** The hover dwell timer: reveal only once it fires, and void it if the pointer leaves midway — this is the dividing line between "passing through to click a tab" and "wanting the action bar".
   *  Built in an effect and used only inside event handlers (the ref is never touched during render); revealBar depends only on the stable cancelHide, so it is built once for the whole lifetime. */
  const dwell = useRef<Dwell | null>(null);
  useEffect(() => {
    const d = new Dwell(revealBar);
    dwell.current = d;
    return () => { d.cancel(); dwell.current = null; };
  }, [revealBar]);
  // Whenever the mode changes, any running dwell timer is voided — not only when this page flips the switch, but also
  // when another tab changes the preference (storage event). Otherwise a timer started under "auto" would still fire
  // and reveal after switching to "manual". Only dwell is cleared, not hideTimer: this effect also runs when hydration
  // swaps the default preference for the real one, and clearing hideTimer there would kill the intro-hold hide too.
  useEffect(() => { dwell.current?.cancel(); }, [barMode]);
  const switchBarMode = useCallback(() => {
    barModeStore.set(barMode === "auto" ? "manual" : "auto");
    // The switch was just clicked, so the bar has to stay put: clear any pending auto-hide (the dwell timer is voided by the effect above as the mode changes).
    cancelHide();
  }, [barMode, cancelHide]);
  /** Explicit collapse (clicking the handle) — bypasses focusHeld, otherwise focus still sitting on the handle after the click would keep the bar open forever. */
  const collapseBar = useCallback(() => { cancelHide(); setBarOpen(false); }, [cancelHide]);

  const setDrawerOpen = useCallback((id: string, open: boolean) => {
    const drawers = openDrawers.current;
    const before = drawers.size;
    if (open) drawers.add(id); else drawers.delete(id);
    const effect = drawerHoldEffect(before, drawers.size);
    if (effect === "reveal") revealBar();
    else if (effect === "hide" && modeAutoHides(barMode)) scheduleHide(); // manual mode: the bar stays after the drawer closes
  }, [revealBar, scheduleHide, barMode]);
  const onDownloadOpen = useCallback((open: boolean) => setDrawerOpen("download", open), [setDrawerOpen]);
  const onHistoryOpen = useCallback((open: boolean) => setDrawerOpen("history", open), [setDrawerOpen]);
  const onSharingOpen = useCallback((open: boolean) => setDrawerOpen("sharing", open), [setDrawerOpen]);
  const onMenuOpen = useCallback((open: boolean) => setDrawerOpen("menu", open), [setDrawerOpen]);
  const onActivityOpen = useCallback((open: boolean) => setDrawerOpen("activity", open), [setDrawerOpen]);

  useEffect(() => { scheduleHide(INTRO_HOLD); return cancelHide; }, [scheduleHide, cancelHide]);

  // The action bar wraps (.controls folds onto a second row on narrow screens), so its height is not a constant; its
  // measured height drives two things at once: the bar sliding itself in, and the artifact being pushed down by
  // exactly that much (see --fs-bar-h in globals.css).
  // The variable is set on .fs-viewer rather than .fs-chrome: the stage and the bar are siblings, and CSS variables
  // only inherit downward, never sideways — set on the bar, the stage could not read it.
  // A top offset is used deliberately instead of transform: transform creates a containing block for position:fixed
  // descendants, so any full-screen overlay would be trapped inside the action bar's box. The drawers are now
  // portaled to body and no longer its descendants, but the constraint stays — the next overlay written directly
  // inside the bar should not trip over this again.
  useEffect(() => {
    const bar = barRef.current, viewer = viewerRef.current;
    if (!bar || !viewer) return;
    const sync = () => viewer.style.setProperty("--fs-bar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(bar);
    // ResizeObserver callbacks are tied to the rendering step and are not delivered while the page is hidden; a
    // resize listener is added as a fallback for the most common path (a width change), so the bar does not end up
    // half-collapsed on the frame right before returning to the foreground.
    window.addEventListener("resize", sync);
    return () => { ro.disconnect(); window.removeEventListener("resize", sync); };
  }, []);

  // Collapse the bar when the user clicks into the artifact. Focus moving into the iframe is the only "the user is
  // interacting with the artifact" signal the parent page can observe — pointer events never reach here. Switching
  // tabs also takes this path, and collapsing is equally harmless there.
  useEffect(() => {
    const onBlur = () => { if (document.activeElement === frameRef.current) collapseBar(); };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [collapseBar]);

  function flash(msg: string) { setToast(msg); }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (editing) titleInput.current?.select();
  }, [editing]);

  function openGate(action: GateAction) {
    setGate(action);
  }

  // Rename — inline title edit committed via PATCH /api/sites/<slug>.
  async function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) { setDraft(title); return; }
    try {
      const res = await fetch(`/api/sites/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) },
        body: JSON.stringify({ title: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Rename failed"));
      setTitle(data.title);
      setDraft(data.title);
      flash(t("Renamed"));
      router.refresh();
    } catch (e) {
      setDraft(title);
      flash(e instanceof Error ? e.message : t("Rename failed"));
    }
  }

  // Upload new version (document sites only) — re-upload the whole file to POST /versions: a new immutable version
  // lands under the same slug, and the share link stays unchanged. This is the only update path for document sites
  // (there is no /edit); without this button, a web user's only way to update would be "open a new site and swap the link".
  async function replaceDocumentFile(file: File | null) {
    if (!file || replacing) return;
    setReplacing(true);
    try {
      const fd = new FormData();
      fd.set("mode", "file");
      fd.set("file", file, file.name);
      const res = await fetch(`/api/sites/${slug}/versions`, {
        method: "POST",
        body: fd,
        headers: editToken ? { "x-edit-token": editToken } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Uploading the new version failed"));
      setVersionCount((n) => n + 1);
      setFrameKey((k) => k + 1); // reload the preview: the new version is current now
      flash(t("New version published · The share link is unchanged"));
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Uploading the new version failed"));
    } finally {
      setReplacing(false);
      if (docInput.current) docInput.current.value = ""; // allow re-picking the same filename
    }
  }

  // Save as new site — POST /fork then jump to the new independent site.
  async function fork() {
    if (forking) return;
    setForking(true);
    try {
      const res = await fetch(`/api/sites/${slug}/fork`, { method: "POST", headers:editToken ? {"x-edit-token":editToken} : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Save as new site failed"));
      // We own the fork: remember its fresh edit token so we can edit the new copy.
      if (data.editToken) rememberEditToken(data.slug, data.editToken);
      flash(t("Saved as a new site"));
      router.push(`/s/${data.slug}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Save as new site failed"));
      setForking(false);
    }
  }

  function onRolledBack() {
    setFrameKey((k) => k + 1); // reload the iframe to show the new current version
    setVersionCount((n) => n + 1);
    flash(t("Rolled back · A new version was created"));
    router.refresh();
  }

  const portalHost = drawerHost(typeof document === "undefined" ? null : document);

  return (
    <div className="fs-viewer" ref={viewerRef} data-device={device} data-bar={barOpen ? "open" : "closed"} data-bar-mode={barMode}>
      <div className="fs-stage-wrap">
        {props.takenDownReason != null && (
          <div className="fs-notice" role="status">
            <b>{t("Taken down by an administrator.")}</b>{" "}
            {props.takenDownReason ? t("Reason: {reason}.", { reason: props.takenDownReason }) : t("No reason was given.")}{" "}
            {t("Visitors see a removal notice. You can still open the site and save it as a new one; nothing here can be changed until it is restored.")}
          </div>
        )}
        {props.expiresAt != null && (
          <div className="fs-notice info" role="status">
            <b>{t("Published without an account.")}</b>{" "}
            {t("This site will be removed on {date}. Sign in from the browser that created it to keep it.", { date: formatDate(props.expiresAt, locale) })}{" "}
            {props.canSignIn && <a href={loginHref()}>{t("Sign in to keep it")}</a>}
          </div>
        )}
        <div className="fs-stage">
          <iframe
            key={frameKey}
            ref={frameRef}
            className="fs-frame"
            src={`/api/preview/${slug}/?r=${frameKey}`}
            title={title}
            sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads"
            allow="fullscreen"
          />
        </div>
      </div>

      {/* Top floating layer: when collapsed, only a thin hotzone + a persistent handle remain; when expanded, it is the full action bar as before. */}
      <div
        ref={chromeRef}
        className={`fs-chrome${barOpen ? " is-open" : ""}`}
        // Hover open/close only trusts a real mouse — the enter synthesized by a tap fights its own click, see isHoverPointer.
        // And it only reveals in "auto" mode, after the pointer has dwelled for HOVER_DWELL_MS: a cursor crossing the top
        // edge on its way to a browser tab triggers leave before the timer fires, the timer is voided, and the bar stays put
        // (see lib/bar-mode.ts).
        onPointerEnter={(e) => { if (hoverArmsReveal(barMode, isHoverPointer(e.pointerType))) dwell.current?.arm(); }}
        onPointerLeave={(e) => { dwell.current?.cancel(); if (leaveSchedulesHide(barMode, isHoverPointer(e.pointerType))) scheduleHide(); }}
      >
        {/* Devices without hover (touch screens) never get the hover reveal; tapping the hotzone/handle is their only toggle. */}
        <div className="fs-hotzone" aria-hidden="true" onClick={() => (barOpen ? collapseBar() : revealBar())} />

        {/* The accessibility trade-off of the collapsed state: this header is opacity:0 + pointer-events:none
            when collapsed, but deliberately gets neither inert nor aria-hidden.
            · inert would disable the keyboard as well, and "Tab in and it auto-expands" is the only way keyboard
              users can enter this whole chrome (after going full-screen there is nothing else focusable on the
              page); adding it would lock keyboard users out.
            · aria-hidden over content that is still focusable is an ARIA violation in itself (focus would land in
              a subtree that "does not exist"), and it would make Back, Copy link and Edit — the only entry points
              — completely invisible to screen-reader users.
            So the collapsed state is treated as "visually collapsed, semantically still present", with two additions:
            the banner landmark gets a name, so screen-reader users browsing linearly know where they are; and
            onClickCapture expands the bar as well — assistive-technology activation goes through click on the
            element, bypassing pointer-events hit testing, so the action would take effect anyway; expanding just
            keeps the UI from being stuck in "the button is invisible but was already pressed". The real entry point
            for pointer-based assistive technology is the persistent .fs-handle, which carries
            aria-expanded/aria-controls and is on screen at all times. */}
        <header
          id="fs-bar"
          ref={barRef}
          className="app-header fs-bar"
          aria-label={t("Site action bar")}
          onClickCapture={revealBar}
          onFocusCapture={() => { focusHeld.current = true; revealBar(); }}
          onBlurCapture={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return; // focus is just moving within the bar
            focusHeld.current = false;
            if (modeAutoHides(barMode)) scheduleHide(); // manual mode: the bar stays even after focus leaves
          }}
        >
          {/* The frosted glass is its own layer: backdrop-filter also creates a containing block for position:fixed
              descendants; keeping it on this purely decorative layer keeps the ancestor chain of the drawers/login gate clean. */}
          <div className="fs-bar-glass" aria-hidden="true" />
          <Link className="brand" href="/" aria-label={t("Back to sites")}>
            <span aria-hidden="true"><ArrowLeft size={15} /></span>
            <b>artifact-site</b>
          </Link>
          <div className="header-mid">
            <div className="header-title-edit">
              {!permissions.canRename ? (
                <span className="header-title" title={title}>{title}</span>
              ) : editing ? (
                <input
                  ref={titleInput}
                  className="title-input"
                  value={draft}
                  maxLength={120}
                  aria-label={t("Site title")}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") { setDraft(title); setEditing(false); } }}
                />
              ) : (
                <button type="button" className="header-title as-title" title={t("Click to rename")} onClick={() => { setDraft(title); setEditing(true); }}>
                  {title}<Pencil size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="viewer-meta">
              <span className="kind-chip">{kind === "single" ? t("Single file") : kind === "document" ? t("Document") : t("Folder")}</span>
              <VisibilityChip visibility={props.visibility} />
              <span className="dot" aria-hidden="true" />
              <span>{countText(t, versionCount, "{n} version", "{n} versions")}</span>
            </div>
          </div>
          <div className="controls">
            {/* A single sentence shown only on private sites, right where the share button is: when someone is
                about to send the thing to others, their eyes and hands are in this area. Not shown on public
                sites — there the address in the URL bar can be sent as is. */}
            {props.visibility === "private" && (
              <span className="share-hint" role="note">
                <Lock size={12} aria-hidden="true" />
                {t("Private site: others cannot open this address directly. Get a share link from Sharing settings")}
              </span>
            )}
            {/* Device preview stays on the bar: flipping widths while reading is a first-class act, not a setting. */}
            <div className="segmented device-switch" role="group" aria-label={t("Preview device")}>
              {DEVICES.map((d) => {
                const Icon = d.icon;
                return (
                  <button key={d.id} type="button" aria-pressed={device === d.id} aria-label={t(d.label)} title={t(d.label)} onClick={() => setDevice(d.id)}>
                    <Icon size={15} />
                  </button>
                );
              })}
            </div>
            {/* The bar carries the two things an owner does most — edit and share — as the design draws them:
                an outline button and a black one, then everything else behind "···". */}
            {mayEdit && <Link className="btn" href={`/s/${slug}/edit`}><Pencil size={14} aria-hidden="true" /> {t("Edit")}</Link>}
            {!mayEdit && permissions.needsLogin && kind !== "document" && (
              <LockedAction label={t("Edit")} icon={<Pencil size={14} />} hint={t("Sign in required")} onOpen={() => openGate("edit")} />
            )}
            {kind === "document" && permissions.canEditContent && (
              <button type="button" className="btn" onClick={() => docInput.current?.click()} disabled={replacing}
                title={t("Re-upload the whole document: a new version is published at the same link, and earlier versions can be rolled back")}>
                {replacing ? <Loader2 size={14} className="spin" /> : <FileUp size={14} aria-hidden="true" />} {t("Upload new version")}
              </button>
            )}
            {permissions.canManageSharing && <SharePanel slug={slug} onOpenChange={onSharingOpen} canManageAdmins={permissions.canManageAdmins} />}
            {!permissions.canManageSharing && permissions.needsLogin && (
              <LockedAction label={t("Sharing settings")} icon={<Share2 size={14} />} hint={t("Sign in required")} onOpen={() => openGate("share")} />
            )}
            {/* The hidden file input stays mounted here, not inside the menu: the "Upload new version" row opens it
                and the menu closes on that click, which would unmount an input that lives in the menu. */}
            {kind === "document" && permissions.canEditContent && (
              <input ref={docInput} type="file" accept=".pdf,.pptx,.ppt,.docx,.doc" hidden
                onChange={(e) => replaceDocumentFile(e.target.files?.[0] ?? null)} />
            )}
            {/* Secondary actions fold into one "···" menu so the bar keeps its width for the title: the device
                preview, the bare artifact, history, forking, the reveal-mode switch. */}
            <MoreMenu label={t("More")} iconOnly onOpenChange={onMenuOpen}>
              {/* Named, not a bare external-link arrow: in almost every product that arrow reads as "share", and
                  on a private site the address it opens is exactly the one others cannot use. */}
              <a
                role="menuitem"
                className="menu-item"
                href={`/api/preview/${slug}/`}
                target="_blank"
                rel="noreferrer"
                title={props.visibility === "private"
                  ? t("Open the artifact itself in a new window (without this action bar). This is not a share link — use Sharing settings to show it to others.")
                  : t("Open the artifact itself in a new window, without this action bar.")}
              >
                <ExternalLink size={14} aria-hidden="true" /> {t("Open in new window")}
              </a>
              {/* Reading history needs no identity — the versions API is open, and only rollback is gated. */}
              {canDownload && <SiteDownload slug={slug} editToken={editToken} onOpenChange={onDownloadOpen} />}
              <VersionHistory variant="menu-item" canDownload={canDownload} slug={slug} editToken={editToken} onRolledBack={onRolledBack} onOpenChange={onHistoryOpen} />
              <button type="button" role="menuitem" className="menu-item" onClick={fork} disabled={forking || !permissions.canReadSource} title={t("Copy into a separate new site")}>
                {forking ? <Loader2 size={14} className="spin" /> : <Copy size={14} aria-hidden="true" />} {t("Save as new site")}
              </button>
              {/* The owner's view of the administration log: what staff did to this site, and when. */}
              {permissions.canManageSharing && <AdminActivity slug={slug} onOpenChange={onActivityOpen} />}
              <span className="menu-sep" role="separator" />
              {/* Reveal-mode switch. Each state writes "what it is now, what clicking will change it to" into its title:
                  the "mouse + click" icon = manual (opens only when the handle is clicked), the "mouse" icon = automatic
                  (opens when the mouse rests on the top edge). */}
              <button
                type="button"
                role="menuitem"
                className="menu-item fs-mode"
                data-bar-mode={barMode}
                onClick={switchBarMode}
                aria-label={barMode === "auto" ? t("Action bar: opens automatically. Click to switch to manual") : t("Action bar: opens manually. Click to switch to automatic")}
                title={barMode === "auto"
                  ? t("Action bar: automatic. Rest the mouse on the top edge for 0.2 s to open it; it hides again when the mouse leaves. Click to switch to manual (opens/closes only when you click the handle).")
                  : t("Action bar: manual. Opens/closes only when you click the handle above; moving the mouse across the top edge does nothing. Click to switch to automatic (opens after the mouse rests on the top edge for 0.2 s).")}
              >
                {barMode === "auto" ? <MousePointer2 size={14} aria-hidden="true" /> : <MousePointerClick size={14} aria-hidden="true" />}
                {barMode === "auto" ? t("Action bar: automatic") : t("Action bar: manual")}
              </button>
            </MoreMenu>
            {/* Identity is always pinned to the far right, separated from the site actions by a divider: it belongs to
                "who you are", not to "what this site can do". */}
            <span className="controls-sep" aria-hidden="true" />
            <AuthButton variant="avatar" />
          </div>
        </header>

        {/* Persistent handle: touch screens have no hover, and keyboard/mouse users also need a visible "there is
            something here". It hangs off the bottom edge of the action bar, which puts it right at the top of the
            screen when collapsed. */}
        <button
          type="button"
          className="fs-handle"
          aria-expanded={barOpen}
          aria-controls="fs-bar"
          aria-label={barOpen ? t("Hide action bar") : t("Show action bar")}
          title={barOpen ? t("Hide action bar") : t("Show action bar")}
          onClick={() => (barOpen ? collapseBar() : revealBar())}
        >
          {barOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
      </div>

      {/* The login gate is portaled to body as well: the CSS says it (z-index 80) sits above the drawers (70), but
          `.fs-viewer` is position:fixed and therefore a stacking context of its own — an 80 left inside it cannot
          beat a 70 already mounted on body, and that ordering would be meaningless. */}
      {gate && portalHost && createPortal(
        <LoginGate
          action={gate}
          returnTo={gate === "edit" ? `/s/${slug}/edit` : `/s/${slug}`}
          onClose={() => setGate(null)}
        />,
        portalHost,
      )}

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
