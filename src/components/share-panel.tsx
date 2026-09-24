"use client";
import AuthorizationPanel from "@/components/authorization-panel";
import { track } from "@/lib/analytics";
// The drawer edits site visibility, role bindings and independent share links.
// Server permission flags control the entry point; each API rechecks authority.
// Private visibility does not revoke role grants or existing share links.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Globe, Maximize2, Minimize2, Link2, Loader2, Lock, Share2, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { drawerHost } from "@/components/version-history";
import ShareSaveDialog from "@/components/share-save-dialog";
import ShareLinks from "@/components/share-links";
import ShareViews from "@/components/share-views";
import PrivateShareEducation from "@/components/private-share-education";
import QuickShareOptions from "@/components/quick-share-options";
import { errorText, readShares, reusableQuickShare, VISIBILITY_LABEL } from "@/components/share-model";
import type { Visibility } from "@/lib/types";
import { recordShareLinkCreated } from "@/lib/share-education";



/** Writes are cookie-authenticated, so the server checks Origin exactly on each one. */
const writeHeaders = () => ({ "content-type": "application/json", origin: window.location.origin });

export default function SharePanel({ slug, visibility: initialVisibility, onOpenChange }: {
  slug: string;
  visibility: Visibility;
  /** While the drawer is open the parent must stop auto-collapsing the action bar — see the drawerHost comment in version-history. */
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [educationOpen, setEducationOpen] = useState(false);
  const [educationDismissed, setEducationDismissed] = useState(false);
  const [quickBusy, setQuickBusy] = useState<"public" | "login" | null>(null);
  const quickBusyRef = useRef(false);
  const [quickCopied, setQuickCopied] = useState<"public" | "login" | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickManualUrl, setQuickManualUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const quickDialogRef = useRef<HTMLDialogElement>(null);
  const quickButtonRef = useRef<HTMLButtonElement>(null);
  const [siteDraft, setSiteDraft] = useState<{visibility: Visibility} | null>(null);
  const siteDirtyRef = useRef(false);
  const [confirmSite, setConfirmSite] = useState(false);
  const [siteSaving, setSiteSaving] = useState(false);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);
  const canLeave = useCallback(() => {
    if (dialogRef.current?.querySelector("dialog[open]")) return false;
    if ((dirtyRef.current || siteDirtyRef.current) && !window.confirm(t("Discard unsaved sharing changes? Saved settings will stay unchanged."))) return false;
    siteDirtyRef.current = false; setSiteDraft(null); return true;
  }, [t]);
  const close = useCallback(() => { if (canLeave()) setOpen(false); }, [canLeave]);
  // Links, site membership and external visit data are separate peer tasks.
  const [tab, setTab] = useState<"links" | "site" | "views">("links");
  // Starts true: the drawer only mounts its body when open, and the first thing it does is fetch.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [siteId,setSiteId] = useState("");

  const openAdvanced = useCallback((nextTab: "links" | "site" | "views") => {
    setError(null);
    setLoading(true);
    setEducationDismissed(true);
    setEducationOpen(false);
    setQuickOpen(false);
    setTab(nextTab);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]',
    ) ?? []).filter(el => el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (dialogRef.current?.querySelector("dialog[open]")) return;
      if (e.key === "Escape") close();
      if (e.key !== "Tab") return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    // Every setState happens in an async continuation, never synchronously in the effect body —
    // the latter is what react-hooks/set-state-in-effect flags, since it forces a second render
    // pass before paint. `alive` drops results from a drawer the user already closed.
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`/api/sites/${slug}/sharing`, { cache: "no-store" });
        if (!response.ok) throw new Error("Sharing settings unavailable");
        const s = await response.json();
        if (!alive) return;
        if (s.visibility) setVisibility(s.visibility);
        setSiteId(s.siteId ?? "");
      } catch {
        if (alive) setError(t("Failed to load sharing settings"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, slug, t]);

  // Tell the parent the drawer is open. Report a close on unmount too, so the parent never keeps the "a drawer is open" lock forever.
  useEffect(() => {
    onOpenChange?.(open || quickOpen || educationOpen);
    return () => onOpenChange?.(false);
  }, [open, quickOpen, educationOpen, onOpenChange]);

  useLayoutEffect(() => {
    if (!quickOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = quickDialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const position = () => {
      const anchor = quickButtonRef.current?.getBoundingClientRect();
      const panel = quickDialogRef.current;
      if (!anchor || !panel) return;
      const margin = 12;
      const width = Math.min(620, window.innerWidth - margin * 2);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(anchor.bottom + 8, window.innerHeight - panel.offsetHeight - margin))}px`;
    };
    position();
    // Start at the primary task, with Close as a fallback while a copy request is pending.
    const initialFocus = dialog.querySelector<HTMLElement>(".share-quick-options button:not(:disabled)")
      ?? dialog.querySelector<HTMLElement>("button[aria-label]");
    initialFocus?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      dialog.close();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      previous?.focus();
    };
  }, [quickOpen]);

  async function createQuickLink(policy: "public" | "login"): Promise<void> {
    if (quickBusyRef.current) return;
    quickBusyRef.current = true;
    setQuickBusy(policy); setQuickError(null); setQuickManualUrl(null);
    try {
      const listResponse = await fetch(`/api/sites/${slug}/shares`, { cache: "no-store" });
      const listBody: unknown = await listResponse.json().catch(() => ({}));
      if (!listResponse.ok) throw new Error(errorText(listBody, t("Failed to load share links")));
      const reusable = reusableQuickShare(readShares(listBody), policy, Date.now());
      let url = reusable?.url ?? null;
      if (!url) {
        const res = await fetch(`/api/sites/${slug}/shares`, {
          method: "POST", headers: writeHeaders(),
          body: JSON.stringify({ policy, mode: policy === "login" ? "comment" : "view", expiresInDays: 30 }),
        });
        const body = await res.json().catch(() => ({})) as { url?: string; error?: string };
        if (!res.ok || !body.url) throw new Error(body.error ?? t("Failed to create"));
        url = body.url;
        recordShareLinkCreated();
      }
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        setQuickManualUrl(url);
        return;
      }
      setQuickCopied(policy);
      window.setTimeout(() => setQuickCopied(current => current === policy ? null : current), 1800);
    } catch (error) { setQuickError(error instanceof Error ? error.message : t("Failed to create")); }
    finally { quickBusyRef.current = false; setQuickBusy(null); }
  }

  function stageSite(want: {visibility: Visibility}) {
    const changed = want.visibility !== visibility;
    siteDirtyRef.current = changed;
    setSiteDraft(changed ? want : null);
    setNotice(null);
  }
  async function saveSite() {
    if (!siteDraft || siteSaving) return;
    setError(null); setSiteSaving(true);
    try {
      const res = await fetch(`/api/sites/${slug}/sharing`, {method: "PUT", headers: writeHeaders(), body: JSON.stringify(siteDraft)});
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? t("Failed to save"));
      setVisibility(siteDraft.visibility);
      siteDirtyRef.current = false; setSiteDraft(null); setConfirmSite(false);
      setNotice(t("Sharing settings saved"));
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : t("Failed to save")); }
    finally { setSiteSaving(false); }
  }
  function goPrivate() {
    if (!canLeave()) return;
    setTab("site"); stageSite({visibility: "private"});
  }
  useEffect(() => {
    if (!open || !siteDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, siteDraft]);

  // Copy /s/<slug> — the canonical link, i.e. the one governed by the visibility scope directly above
  // this panel. Success or failure, the notice does the talking: the clipboard throws outright in an
  // insecure context, in which case the address is shown so people can take it themselves.
  async function copyCanonical(): Promise<void> {
    const url = `${window.location.origin}/s/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      track("share_link_copy", { share_type: "canonical" });
      setNotice(visibility === "private"
        ? t("Site address copied. Access follows site membership and visibility; use Share links to share with another audience.")
        : t("Link copied · {scope}", { scope: t(VISIBILITY_LABEL[visibility]) }));
    } catch {
      setNotice(url);
    }
  }

  // Same as Version history: the drawer must escape `.fs-bar`, or it turns transparent and click-through the moment the action bar collapses.
  const host = drawerHost(typeof document === "undefined" ? null : document);

  return (
    <>
      <button ref={quickButtonRef} className="btn primary" data-analytics-button="share" aria-haspopup="dialog" aria-expanded={quickOpen || open} onClick={() => { setEducationDismissed(true); setEducationOpen(false); setQuickOpen(value => !value); }}><Share2 size={14} /> {t("Sharing")}</button>
      {visibility === "private" && !educationDismissed && <PrivateShareEducation slug={slug} anchor={quickButtonRef} onCreate={() => openAdvanced("links")} onOpenChange={setEducationOpen} />}
      {quickOpen && host && createPortal(
          <dialog ref={quickDialogRef} className="share-quick" aria-label={t("Sharing")}
            onCancel={(event) => { event.preventDefault(); setQuickOpen(false); }}
            onMouseDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
                // Do not let the backdrop's default mousedown steal the restored trigger focus.
                event.preventDefault();
                setQuickOpen(false);
              }
            }}>
            <header className="share-quick-head"><div><b>{t("Sharing")}</b><span>{t("Quick sharing")}</span></div><button type="button" className="btn sm ghost" aria-label={t("Close")} onClick={() => setQuickOpen(false)}><X size={14} /></button></header>
            <QuickShareOptions busy={quickBusy} copied={quickCopied} onCopy={createQuickLink} />
            {visibility === "private" && <p className="share-quick-private"><Lock size={13} /> {t("This private site stays private at its site address. A quick link grants separate access to whoever receives it.")}</p>}
            {quickError && <p className="share-error" role="alert">{quickError}</p>}
            {quickManualUrl && <div className="share-quick-manual" role="status"><span>{t("The link is ready, but automatic copy failed. Copy it manually:")}</span><input readOnly value={quickManualUrl} onFocus={(event) => event.currentTarget.select()} aria-label={t("Share link")} /></div>}
            <footer className="share-quick-foot"><div><b>{t("Need more sharing settings?")}</b><span>{t("Create a custom link or adjust site permissions.")}</span></div><button type="button" className="btn primary sm" onClick={() => openAdvanced("links")}>{t("New share link")}</button><button type="button" className="btn sm" onClick={() => openAdvanced("site")}>{t("Permission settings")}</button></footer>
          </dialog>, host,
      )}
      {open && host && createPortal(
        <div className="drawer-scrim" data-expanded={expanded} role="presentation" onClick={close}>
          <aside ref={dialogRef} className="drawer share-drawer" role="dialog" aria-modal="true" aria-label={t("Sharing")} onClick={(e) => e.stopPropagation()}>
            {confirmSite && siteDraft && <ShareSaveDialog label={t("The site itself")} changes={[
              ...(siteDraft.visibility !== visibility ? [{label: t("Visibility"), before: t(VISIBILITY_LABEL[visibility]), after: t(VISIBILITY_LABEL[siteDraft.visibility])}] : []),
            ]} expiryChanged={false} busy={siteSaving} error={error}
              note={t("This changes access through the site address for existing visitors. Separate share links keep their own access rules.")}
              onConfirm={() => void saveSite()} onClose={() => setConfirmSite(false)} />}
            <header className="drawer-head">
              <b>{t("Sharing")}</b>
              <div className="share-window-actions">
                <button type="button" className="btn sm ghost" aria-label={t(expanded ? "Collapse window" : "Expand window")} title={t(expanded ? "Collapse window" : "Expand window")} aria-pressed={expanded} onClick={() => setExpanded(v => !v)}>
                  {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
                </button>
                <button className="btn sm ghost" onClick={close} aria-label={t("Close")}><X size={14} /></button>
              </div>
            </header>
            <div className="drawer-tabs" role="tablist" aria-label={t("Sharing")}>
              <button type="button" role="tab" aria-selected={tab === "links"} onClick={() => { if (tab !== "links" && canLeave()) {setTab("links"); setNotice(null); setError(null); } }}>{t("Share links")}</button>
              <button type="button" role="tab" aria-selected={tab === "site"} onClick={() => { if (tab !== "site" && canLeave()) {setTab("site"); setNotice(null); setError(null); } }}>{t("People and the site")}</button>
              <button type="button" role="tab" aria-selected={tab === "views"} onClick={() => { if (tab !== "views" && canLeave()) {setTab("views"); setNotice(null); setError(null); } }}>{t("View history")}</button>
            </div>
            <div className="drawer-body share-body">
              {loading && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
              {error && <p className="drawer-error" role="alert">{error}</p>}
              {notice && <p className="share-warn" role="status">{notice}</p>}

              {tab === "links" && <ShareLinks slug={slug} visibility={visibility} onRequestPrivate={goPrivate} onDirtyChange={onDirtyChange} />}

              {tab === "views" && <ShareViews slug={slug} />}

              {tab === "site" && (
                <>
                  {siteId && <AuthorizationPanel resource={{type:"site",id:siteId}} />}

                  {/* Site visibility is separate from grants and share links. */}
                  <section className="share-sec">
                    <h3 className="share-sec-title">{t("The site itself")}</h3>

                    <div className="share-row">
                      <span className="share-row-icon" aria-hidden="true">
                        {visibility === "private" ? <Lock size={16} /> : <Globe size={16} />}
                      </span>
                      <div className="share-row-text">
                        <label htmlFor="share-visibility">{t("Who can open /s/{slug}", { slug })}</label>
                        <p>
                          {visibility === "private"
                            ? t("The site address is private. Authorized members retain access; share links have separate access rules.")
                            : t("Anyone with this address can open it right now.")}
                        </p>
                      </div>
                      <select
                        disabled={siteSaving || loading} id="share-visibility" value={siteDraft?.visibility ?? visibility}
                        onChange={(e) => stageSite({ visibility: e.target.value as Visibility })}
                      >
                        <option value="public">{t(VISIBILITY_LABEL.public)}</option>
                        <option value="unlisted">{t(VISIBILITY_LABEL.unlisted)}</option>
                        <option value="private">{t(VISIBILITY_LABEL.private)}</option>
                      </select>
                    </div>

                    <div className="share-settings-footer">
                      <span className="share-hint">{t(siteDraft ? "Unsaved changes" : "Takes effect after saving.")}</span>
                      <div className="share-link-actions">
                        <button className="btn sm" disabled={!siteDraft || siteSaving} onClick={() => {setSiteDraft(null); siteDirtyRef.current = false;}}>{t("Discard changes")}</button>
                        <button className="btn sm solid" disabled={!siteDraft || siteSaving} onClick={() => {setError(null); setConfirmSite(true);}}>{t("Save changes")}</button>
                      </div>
                    </div>
                  </section>
                </>
              )}
            </div>

            {/* Footer — the one and only copy control. It sits directly under the visibility scope, so
                the scope is in view while copying; that is precisely why it was taken off the action
                bar: copying there, you cannot see what you are sending out. */}
            {tab === "site" && <footer className="share-foot">
              <button className="btn" onClick={() => void copyCanonical()}>
                <Link2 size={14} /> {t("Copy site address")}
              </button>
              <span className="share-foot-scope">{t(VISIBILITY_LABEL[visibility])}</span>
            </footer>}
          </aside>
        </div>,
        host,
      )}
    </>
  );
}
