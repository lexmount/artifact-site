"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2 } from "lucide-react";
import { useT, useLocale } from "@/components/locale-provider";
import { siteFetch } from "@/lib/share-context";
import { managementReasonHeaders } from "@/lib/management-reason";
import { downloadSite } from "@/lib/download";
import { relTime } from "@/lib/rel-time";
import type { VersionInfo } from "@/lib/types";

/** One download flow across personal, editor and administrative surfaces. */
export default function SiteDownload({ slug, editToken, versionId, management = false, menuItem = true, onOpenChange }: {
  slug: string;
  editToken?: string | null;
  /** A history row or editor pins its saved snapshot; lists default to current. */
  versionId?: string;
  management?: boolean;
  menuItem?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState(versionId ?? "");
  const [done, setDone] = useState(false);
  const headers: Record<string, string> = {
    ...(editToken ? { "x-edit-token": editToken } : {}),
    ...(management ? managementReasonHeaders(reason) : {}),
  };
  const ready = !busy && (!management || reason.trim().length > 0);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  async function loadVersions() {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const res = await siteFetch(`/api/sites/${encodeURIComponent(slug)}/versions`, { headers, cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("Failed to load"));
      setVersions(data.versions);
    } catch (e) { setError(e instanceof Error ? e.message : t("Failed to load")); }
    finally { setBusy(false); }
  }

  return <>
    <button data-analytics-button="download" type="button" role={menuItem ? "menuitem" : undefined} className={menuItem ? "menu-item" : "btn sm ghost"}
      onClick={() => { setError(null); setReason(""); setVersions(null); setSelected(versionId ?? ""); setDone(false); setOpen(true); }}>
      <Download size={14} aria-hidden="true" /> {t(versionId ? "Download this version (ZIP)" : "Download (ZIP)")}
    </button>
    {open && typeof document !== "undefined" && createPortal(
      <dialog ref={dialog} className="admin-dialog" aria-labelledby={titleId} onClose={() => setOpen(false)} onCancel={(e) => { if (busy) e.preventDefault(); }}>
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true); setError(null); setDone(false);
          try { await downloadSite(slug, selected || undefined, headers); setDone(true); }
          catch (err) { setError(err instanceof Error ? err.message : t("Failed to download")); }
          finally { setBusy(false); }
        }}>
          <h2 id={titleId}>{t("Download (ZIP)")}</h2>
          <p>{t("Includes all files in the saved version. Documents include the original file in original/. Unsaved edits are not included.")}</p>
          {management && <label><span>{t("Reason (required)")}</span>
            <textarea required maxLength={500} rows={3} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
          </label>}
          {management && <p>{t("Administrative downloads are recorded in the audit log.")}</p>}
          {versionId ? <p>{t("Downloads the saved version selected here.")}</p> : <>
            <label><span>{t("Version")}</span>
              <select value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setDone(false); }}>
                <option value="">{t("Current version")}</option>
                {versions?.map((v, i) => <option key={v.id} value={v.id}>
                  v{versions.length - i} · {relTime(v.createdAt, t, locale)}{v.current ? ` · ${t("Current")}` : ""}
                </option>)}
              </select>
            </label>
            {!versions && <button type="button" className="btn sm ghost" disabled={!ready} onClick={() => void loadVersions()}>{t("Choose a historical version")}</button>}
          </>}
          {error && <p className="drawer-error" role="alert">{error}</p>}
          {done && <p role="status">{t("Download started")}</p>}
          <div className="admin-dialog-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>{t("Close")}</button>
            <button type="submit" className="btn solid" disabled={!ready}>
              {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}{t("Download (ZIP)")}
            </button>
          </div>
        </form>
      </dialog>, document.body)}
  </>;
}
