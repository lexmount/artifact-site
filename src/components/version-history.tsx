"use client";

// Version history — a right-side drawer reachable from the viewer/editor. Lazily loads
// GET /api/sites/<slug>/versions on open and renders the immutable timeline (newest first).
// Each row: "Preview this version" (opens /api/preview/<slug>/?v=<id> read-only) + "Roll back to this version"
// (confirm → POST /rollback → reload the list and let the parent refresh its preview).
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { History, X, Eye, RotateCcw, Loader2 } from "lucide-react";
import type { VersionInfo } from "@/lib/types";
import { type Translator, formatDate, type Locale, countText } from "@/lib/i18n";
import { useLocale, useT } from "@/components/locale-provider";

const SOURCE_LABEL: Record<VersionInfo["source"], string> = { upload: "Uploaded", edit: "Edited", fork: "Forked", rollback: "Rolled back", build: "Built" };

function relTime(ts: number, t: Translator, locale: Locale = "en"): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t("Just now");
  const m = Math.round(s / 60);
  if (m < 60) return t("{n} minutes ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n} hours ago", { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return t("{n} days ago", { n: d });
  return formatDate(ts, locale);
}

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

export default function VersionHistory({ slug, editToken, onRolledBack, onOpenChange, variant = "button" }: {
  slug: string; editToken?: string | null; onRolledBack?: () => void;
  /** "menu-item" renders the trigger as a row of the viewer's More menu instead of a bar button. */
  variant?: "button" | "menu-item";
  /** While the drawer is open the parent must stop auto-collapsing the action bar, or closing the drawer reveals the bar is already gone. */
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/versions`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to load"));
      setVersions(data.versions as VersionInfo[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load"));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

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
    if (version.current || rolling) return;
    if (!window.confirm(t("Roll back to this version? A new version is added at the top of the history; neither the history nor the current content is lost."))) return;
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
                    <span className="ver-num">v{total - i}</span>
                    <span className="kind-chip">{t(SOURCE_LABEL[v.source] ?? v.source)}</span>
                    {v.current && <span className="ver-current-pill">{t("Current")}</span>}
                  </div>
                  <div className="ver-row-meta">
                    <span>{relTime(v.createdAt, t, locale)}</span>
                    <span className="dot" aria-hidden="true" />
                    <span>{countText(t, v.fileCount, "{n} file", "{n} files")}</span>
                  </div>
                  <div className="ver-row-actions">
                    <a className="btn sm ghost" href={`/api/preview/${slug}/?v=${v.id}`} target="_blank" rel="noreferrer">
                      <Eye size={13} /> {t("Preview this version")}
                    </a>
                    {/* title goes on the outer span rather than the button: a disabled button
                        dispatches no hover events, so the native tooltip would never appear — and
                        "why can't I click this" is precisely the question that most needs answering
                        here. */}
                    <span title={v.current ? t("This is already the current version") : undefined}>
                      <button type="button" className="btn sm" disabled={v.current || rolling === v.id} onClick={() => rollback(v)}>
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
