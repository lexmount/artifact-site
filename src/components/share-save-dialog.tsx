"use client";

import { useEffect, useId, useRef } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";

export interface ShareSettingChange { label: string; before: string; after: string }

export default function ShareSaveDialog({ label, changes, expiryChanged, busy, error, onConfirm, onClose, title, note, confirmLabel }: {
  title?: string;
  note?: string;
  confirmLabel?: string;
  label: string;
  changes: ShareSettingChange[];
  expiryChanged: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return (
    <dialog ref={ref} className="admin-dialog share-confirm" aria-labelledby={id} aria-describedby={`${id}-note`}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={event => event.stopPropagation()}>
      <div className="share-confirm-head">
        <h2 id={id}>{title ?? t("Confirm sharing changes")}</h2>
        <p>{label}</p>
      </div>
      <dl className="share-confirm-changes">
        {changes.map(change => (
          <div key={change.label}>
            <dt>{change.label}</dt>
            <dd><span>{change.before}</span><ArrowRight size={14} aria-hidden="true" /><strong>{change.after}</strong></dd>
          </div>
        ))}
      </dl>
      <div className="share-confirm-note" id={`${id}-note`}>
        {note ? <p>{note}</p> : <>
        <p>{t("The existing link will use these new settings. Some previous visitors may lose access or need to verify their identity again.")}</p>
        <p>{t("To keep the original audience's access unchanged, create a separate link instead.")}</p>
        {expiryChanged && <p>{t("The new expiry starts when you save.")}</p>}
        </>}
      </div>
      {error && <p className="share-error" role="alert">{error}</p>}
      <div className="admin-dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose} autoFocus>{t(title ? "Cancel" : "Continue editing")}</button>
        <button type="button" className="btn solid" disabled={busy} onClick={onConfirm}>
          {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}{busy ? t("Saving…") : confirmLabel ?? t("Confirm and save")}
        </button>
      </div>
    </dialog>
  );
}
