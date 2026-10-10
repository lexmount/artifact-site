"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "@/components/locale-provider";

/** Mounted only while open, so each operation starts with clean form and error state. */
export default function TenantFormDialog({ title, children, confirmLabel, onSubmit, onClose, disabled = false, danger = false }: {
  title: string; children: ReactNode; confirmLabel: string; onSubmit: () => Promise<void>; onClose: () => void; disabled?: boolean; danger?: boolean;
}) {
  const t = useT(), titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="admin-dialog tenant-dialog" aria-labelledby={titleId} onClose={onClose} onCancel={e => { if (busy) e.preventDefault(); }}>
    <form onSubmit={async e => {
      e.preventDefault(); if (busy || disabled) return;
      setBusy(true); setError("");
      try { await onSubmit(); onClose(); } catch (e) { setError(t(e instanceof Error ? e.message : "Request failed")); } finally { setBusy(false); }
    }}>
      <div className="tenant-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="quiet" aria-label={t("Close")} disabled={busy} onClick={onClose}><X size={18}/></button></div>
      <fieldset disabled={busy} className="tenant-fields">{children}</fieldset>
      {error && <p className="drawer-error" role="alert">{error}</p>}
      <div className="admin-dialog-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className={`btn ${danger ? "danger" : "solid"}`} disabled={busy || disabled}>{busy ? t("Saving…") : confirmLabel}</button></div>
    </form>
  </dialog>;
}
