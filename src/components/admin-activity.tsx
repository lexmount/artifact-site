"use client";

// "Administrator activity" — a drawer on the site page, for its owner: every time an administrator
// took the site down, restored it, or opened it while it was not public. The list is the owner's
// own view of the administration log (GET /api/sites/<slug>/admin-activity), so the platform's
// promise that staff access is always on the record is something the owner can check, not take
// on trust. Same drawer shape and mount as the version history.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, ShieldCheck, X } from "lucide-react";
import { drawerHost } from "@/components/version-history";
import { useLocale, useT } from "@/components/locale-provider";
import type { AdminAction } from "@/lib/types";

interface Entry { id: string; action: AdminAction; at: number; reason: string | null }

const LABEL: Partial<Record<AdminAction, string>> = {
  "site.view": "An administrator opened this site",
  "site.take_down": "Taken down by an administrator",
  "site.restore": "Restored by an administrator",
  "site.delete": "Deleted by an administrator",
  "site.undelete": "Deleted site restored by an administrator",
};

export default function AdminActivity({ slug, onOpenChange }: { slug: string; onOpenChange?: (open: boolean) => void }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState<{ limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/admin-activity`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Failed to load"));
      setEntries(data.entries as Entry[]);
      setTruncated(data.truncated ? { limit: Number(data.limit) } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load"));
    }
  }, [slug, t]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false); }, [open, onOpenChange]);

  const host = drawerHost(typeof document === "undefined" ? null : document);
  const when = (ts: number) => new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(true); setEntries(null); void load(); }}
        title={t("Every administrator action on this site, including each time one opened it while it was not public")}>
        <ShieldCheck size={14} aria-hidden="true" /> {t("Administrator activity")}
      </button>
      {open && host && createPortal(
        <div className="drawer-scrim" role="presentation" onClick={() => setOpen(false)}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={t("Administrator activity")} onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head">
              <b>{t("Administrator activity")}</b>
              <button type="button" className="btn sm ghost" onClick={() => setOpen(false)} aria-label={t("Close")}><X size={14} /></button>
            </header>
            <div className="drawer-body">
              <p className="drawer-note">{t("Administrators of this server can open any site to handle a report. Every such opening, and every take-down or restore, is recorded here for you.")}</p>
              {!entries && !error && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
              {error && <p className="drawer-error" role="alert">{error}</p>}
              {entries && entries.length === 0 && <p className="drawer-note admin-activity-empty">{t("No administrator has touched this site.")}</p>}
              {entries && entries.length > 0 && (
                <ol className="admin-activity">
                  {entries.map((e) => (
                    <li key={e.id} className={`admin-activity-row is-${e.action.replace(".", "-")}`}>
                      <b>{t(LABEL[e.action] ?? e.action)}</b>
                      <span>{when(e.at)}</span>
                      {e.reason && e.action !== "site.view" && <em>{e.reason}</em>}
                    </li>
                  ))}
                </ol>
              )}
              {truncated && <p className="drawer-note">{t("Showing the latest {n} entries; older ones are not listed.", { n: String(truncated.limit) })}</p>}
            </div>
          </aside>
        </div>,
        host,
      )}
    </>
  );
}
