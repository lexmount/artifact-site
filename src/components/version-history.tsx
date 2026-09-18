"use client";
import { useSitePermissions } from "@/lib/site-permissions";
import { siteFetch as fetch } from "@/lib/share-context";


import SiteDownload from "@/components/site-download";

// Version history — a right-side drawer reachable from the viewer/editor. Lazily loads
// GET /api/sites/<slug>/versions on open and renders the immutable timeline (newest first).
// Each row: "Preview this version" (opens /s/<slug>?version=<id> read-only) + "Roll back to this version"
// (confirm → POST /rollback → reload the list and let the parent refresh its preview).
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, X, Eye, RotateCcw, Loader2 } from "lucide-react";
import type { VersionInfo } from "@/lib/types";
import { countText } from "@/lib/i18n";
import { OFFICIAL_CHANGED } from "@/components/official-version";
import { relTime } from "@/lib/rel-time";
import { useLocale, useT } from "@/components/locale-provider";

const SOURCE_LABEL: Record<VersionInfo["source"], string> = { upload: "Uploaded", edit: "Edited", fork: "Forked", rollback: "Rolled back", build: "Built" };

/**
 * Where the drawer mounts. It must be document.body, not rendered in place: the full-screen viewer
 * page puts this component inside `.fs-bar`, and a collapsed `.fs-bar` is `opacity: 0;
 * pointer-events: none` — the scrim and drawer, being its descendants, go dark and click-through
 * with it, and what the user sees is "the drawer vanished on its own" while the component's open is
 * still true. Mounted on body, the drawer is no longer at the mercy of the action bar; stacking is
 * still right too: `.drawer-scrim` is fixed + z-index:70, while `.fs-viewer` (position:fixed,
 * z-index:auto) is layer 0 in the root stacking context, so the scrim still covers it.
 * SSR has no document — return null and the caller skips this frame; the drawer starts closed, so no
 * first-paint content is lost.
 */
export function drawerHost(doc?: { body?: HTMLElement | null } | null): HTMLElement | null {
  return doc?.body ?? null;
}

export default function VersionHistory({ slug, editToken, onBeforeRollback, onRolledBack, onOpenChange, canDownload = false, variant = "button" }: {
  canDownload?: boolean;
  slug: string; editToken?: string | null; onRolledBack?: () => void; onBeforeRollback?: () => boolean;
  /** "menu-item" renders the trigger as a row of the viewer's More menu instead of a bar button. */
  variant?: "button" | "menu-item";
  /** While the drawer is open the parent must stop auto-collapsing the action bar, or closing the drawer reveals the bar is already gone. */
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const permissions = useSitePermissions(slug);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [officialRevision, setOfficialRevision] = useState<number>();
  const [canManageOfficial, setCanManageOfficial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/versions`, { cache: "no-store", headers: editToken ? { "x-edit-token": editToken } : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to load"));
      setVersions(data.versions as VersionInfo[]);
      setOfficialRevision(data.officialRevision);
      setCanManageOfficial(!!data.canManageOfficial);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load"));
    } finally {
      setLoading(false);
    }
  }, [slug, t, editToken]);

  useEffect(() => { if (!open) return; const refresh = () => { void load(); }; window.addEventListener(OFFICIAL_CHANGED, refresh); const timer = canManageOfficial ? setInterval(refresh, 10000) : undefined; return () => { clearInterval(timer); window.removeEventListener(OFFICIAL_CHANGED, refresh); }; }, [open, load, canManageOfficial]);

  async function designate(version: VersionInfo) {
    setRolling(version.id);
    try {
      const res = await fetch(`/api/sites/${slug}/official`, { method: version.official ? "DELETE" : "PUT", headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) }, body: JSON.stringify({ versionId: version.id, expectedRevision: officialRevision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.dispatchEvent(new Event(OFFICIAL_CHANGED));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("Could not change the official version")); }
    finally { setRolling(null); }
  }

  function openDrawer() {
    setOpen(true);
    void load();
  }

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Tell the parent the drawer is open. Report a close on unmount too, so the parent never keeps the "a drawer is open" lock forever.
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  async function rollback(version: VersionInfo) {
    if (!permissions?.canRollback || version.current || rolling) return;
    if (!window.confirm(t("Roll back to this version? A new version is added at the top of the history; neither the history nor the current content is lost."))) return;
    if (onBeforeRollback && !onBeforeRollback()) return;
    setRolling(version.id);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) },
        body: JSON.stringify({ versionId: version.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to roll back"));
      await load();
      onRolledBack?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to roll back"));
    } finally {
      setRolling(null);
    }
  }

  const total = versions?.length ?? 0;
  const host = drawerHost(typeof document === "undefined" ? null : document);

  return (
    <>
      {variant === "menu-item" ? (
        <button type="button" role="menuitem" className="menu-item" onClick={openDrawer}>
          <History size={14} aria-hidden="true" /> {t("Version history")}
        </button>
      ) : (
        <button type="button" className="btn sm ghost" onClick={openDrawer}>
          <History size={14} /> {t("Version history")}
        </button>
      )}

      {open && host && createPortal(
        <div className="drawer-scrim" role="presentation" onClick={() => setOpen(false)}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={t("Version history")} onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head">
              <b>{t("Version history")}</b>
              <button type="button" className="btn sm ghost" onClick={() => setOpen(false)} aria-label={t("Close")}>
                <X size={14} />
              </button>
            </header>
            <div className="drawer-body">
              {loading && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
              {error && <p className="drawer-error" role="alert">{error}</p>}
              {versions?.map((v, i) => (
                <div key={v.id} className={`ver-row${v.current ? " is-current" : ""}`}>
                  <div className="ver-row-head">
                    <span className="ver-num">v{v.number ?? total - i}</span>
                    <span className="kind-chip">{t(SOURCE_LABEL[v.source] ?? v.source)}</span>
                    {v.official && <span className="official-pill">{t("Official version")}</span>}
                    {v.current && <span className="ver-current-pill">{t("Current")}</span>}
                  </div>
                  <div className="ver-row-meta">
                    <span>{relTime(v.createdAt, t, locale)}</span>
                    <span className="dot" aria-hidden="true" />
                    <span>{countText(t, v.fileCount, "{n} file", "{n} files")}</span>
                  </div>
                  <div className="ver-row-actions">
                    {canDownload && <SiteDownload slug={slug} versionId={v.id} editToken={editToken} menuItem={false} />}
                    {canManageOfficial && <button type="button" className="btn sm" disabled={rolling !== null} onClick={() => void designate(v)}>{t(v.official ? "Remove official designation" : "Set as official version")}</button>}
                    <a className="btn sm ghost" href={`/s/${slug}?version=${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer">
                      <Eye size={13} /> {t("Preview this version")}
                    </a>
                    {/* title goes on the outer span rather than the button: a disabled button
                        dispatches no hover events, so the native tooltip would never appear — and
                        "why can't I click this" is precisely the question that most needs answering
                        here. */}
                    <span title={v.current ? t("This is already the current version") : undefined}>
                      <button type="button" className="btn sm" disabled={!permissions?.canRollback || v.current || rolling === v.id} onClick={() => rollback(v)}>
                        {rolling === v.id ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} {t("Roll back to this version")}
                      </button>
                    </span>
                  </div>
                </div>
              ))}
              {versions && versions.length === 0 && <p className="drawer-note">{t("No versions yet.")}</p>}
            </div>
          </aside>
        </div>,
        host,
      )}
    </>
  );
}
