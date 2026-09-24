"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";

/** Mount only while requested. Native modal focus isolation; failed actions stay retryable. */
export default function ConfirmDialog({ title, body, confirmLabel, danger = false, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement;
    el.showModal(); cancel.current?.focus();
    return () => { el.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="action-confirmation" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    onClose={() => {
      const el = dialog.current;
      if (!el || el.open) return;
      // Native close watchers can bypass cancel. Keep an in-flight failure visible.
      if (running.current) el.showModal();
      else onClose();
    }}
    onCancel={event => { event.preventDefault(); if (!running.current) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (running.current) return;
      running.current = true; setBusy(true); setError(null);
      try { await onConfirm(); onClose(); }
      catch (err) { setError(err instanceof Error ? err.message : t("Something went wrong")); }
      finally { running.current = false; setBusy(false); }
    }}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-body`}>{body}</p>
      {error && <p className="drawer-error" role="alert">{error}</p>}
      <div className="action-confirmation-buttons">
        <button ref={cancel} type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" className={`btn ${danger ? "danger" : "solid"}`} disabled={busy} aria-busy={busy}>
          {busy && <Loader2 size={14} className="spin" aria-hidden="true" />} {confirmLabel}
        </button>
      </div>
    </form>
  </dialog>;
}
