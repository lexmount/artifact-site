"use client";

// The one confirmation shape every administrative act uses: what will happen, an optional or
// required reason (it goes into admin_log — and, for a disabled account, onto the person's next
// sign-in attempt), cancel / confirm. A native <dialog>: focus trapping, Escape and the backdrop
// come for free, and the page underneath is inert while it is open.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";

export default function ReasonDialog({ open, title, body, reasonRequired = false, reasonHint, emailRequired = false, confirmLabel, danger = false, onConfirm, onClose }: {
  open: boolean;
  title: string;
  body: string;
  reasonRequired?: boolean;
  reasonHint?: string;
  emailRequired?: boolean;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (reason: string, email?: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) { setReason(""); setEmail(""); setError(null); el.showModal(); }
    else if (!open && el.open) el.close();
  }, [open]);

  const canConfirm = !busy && (!reasonRequired || reason.trim().length > 0) && (!emailRequired || email.trim().length > 0);

  return (
    <dialog ref={ref} className="admin-dialog" onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault(); }}>
      <form
        method="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canConfirm) return;
          setBusy(true); setError(null);
          try { await onConfirm(reason.trim(), emailRequired ? email.trim() : undefined); onClose(); }
          catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          finally { setBusy(false); }
        }}
      >
        <h2>{title}</h2>
        <p>{body}</p>
        {emailRequired && <label><span>{t("Recipient email")}</span><input type="email" required value={email} onChange={e => setEmail(e.target.value)} maxLength={254} autoFocus /></label>}
        <label>
          <span>{reasonRequired ? t("Reason (required)") : t("Reason (optional)")}</span>
          <textarea required={reasonRequired} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder={reasonHint} autoFocus={!emailRequired} />
        </label>
        {error && <p className="drawer-error" role="alert">{error}</p>}
        <div className="admin-dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
          <button type="submit" className={`btn ${danger ? "danger" : "solid"}`} disabled={!canConfirm}>
            {busy && <Loader2 size={14} className="spin" aria-hidden="true" />} {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
