"use client";
import { useEffect, useState } from "react";
import { useLocale, useT } from "@/components/locale-provider";
import { adminFetch, formatWhen } from "@/components/admin/format";

type Status = { revision: string; updatedAt: number };
export function PreviewKeySettings() {
  const t = useT(), locale = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    adminFetch<Status>("/api/admin/preview-key").then(setStatus).catch((e: Error) => setError(e.message));
  }, []);
  async function rotate() {
    if (!status) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      setStatus(await adminFetch<Status>("/api/admin/preview-key", { method: "POST", body: { revision: status.revision } }));
      setConfirm(false); setSaved(true);
    } catch (e) {
      setError((e as Error).message);
      // A concurrent rotation uses 409. Refresh the revision before another explicit attempt.
      try { setStatus(await adminFetch<Status>("/api/admin/preview-key")); } catch { /* keep the actionable error */ }
      setConfirm(false);
    } finally { setBusy(false); }
  }
  return <section className="admin-setting" aria-labelledby="preview-key-heading">
    <h2 id="preview-key-heading">{t("Preview access key")}</h2>
    <p className="drawer-note">{t("Generated automatically and shared by all instances. The secret is never displayed.")}</p>
    {status && <p>{t("Last generated")}: {formatWhen(status.updatedAt, locale)}</p>}
    <p className="drawer-note">{t("Rotation immediately invalidates existing preview credentials. Viewers can refresh to continue; share links and login sessions stay valid.")}</p>
    {confirm ? <div className="admin-actions-row">
      <button type="button" className="btn solid" disabled={busy} onClick={rotate}>{t("Confirm rotation")}</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>{t("Cancel")}</button>
    </div> : <button type="button" className="btn" disabled={!status || busy} onClick={() => { setConfirm(true); setSaved(false); }}>{t("Rotate preview key")}</button>}
    {saved && <p role="status" className="drawer-note">{t("Preview key rotated. All instances now use the new key.")}</p>}
    {error && <p role="alert" className="drawer-error">{error}</p>}
  </section>;
}
