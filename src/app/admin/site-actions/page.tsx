"use client";

import { useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import ReasonDialog from "@/components/admin/reason-dialog";
import type { Site } from "@/lib/types";

type KnownSite = Pick<Site, "id" | "slug" | "title" | "ownerId" | "deletedAt" | "purgedAt" | "takenDownAt">;
type Action = "assign" | "take-down" | "restore" | "delete" | "undelete";
const labels: Record<Action, string> = {
  assign: "Assign owner", "take-down": "Take down", restore: "Restore access", delete: "Delete site", undelete: "Restore deleted site",
};

export default function AdminSiteActionsPage() {
  const t = useT();
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [site, setSite] = useState<KnownSite | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function act(value: string, email?: string) {
    if (!site || !action) return;
    const endpoint = `/api/admin/sites/${encodeURIComponent(site.slug)}`;
    if (action === "assign") {
      const data = await adminFetch<{ ownerId: string }>(`${endpoint}/owner`, { method: "POST", body: { email, reason: value, expectedSiteId: site.id } });
      setSite({ ...site, ownerId: data.ownerId });
    } else {
      const body = action === "undelete" ? { deleted: false, reason: value }
        : action === "delete" ? { reason: value }
          : { takenDown: action === "take-down", reason: value };
      const data = await adminFetch<{ site: KnownSite }>(endpoint, { method: action === "delete" ? "DELETE" : "PATCH", body: { ...body, expectedSiteId: site.id } });
      setSite(data.site);
    }
    setNotice(t("Site action completed."));
  }

  const actions: Action[] = !site || site.purgedAt ? [] : site.deletedAt ? ["undelete"]
    : [site.takenDownAt ? "restore" : "take-down", "delete"];
  if (site && !site.ownerId && !site.deletedAt && !site.purgedAt) actions.unshift("assign");

  return <div className="admin-known-site">
    <p className="drawer-note">{t("Enter an exact site address, slug or ID to handle a report. This form does not browse or search other sites.")}</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(""); setNotice(""); setSite(null);
      try {
        const data = await adminFetch<{ site: KnownSite }>("/api/admin/site-lookup", { method: "POST", body: { reference, reason } });
        setSite(data.site);
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      finally { setBusy(false); }
    }}>
      <label>{t("Site address, slug or ID")}<input required maxLength={2048} value={reference} disabled={busy} onChange={event => { setReference(event.target.value); setSite(null); setNotice(""); }} /></label>
      <label>{t("Management reason")}<input required maxLength={500} value={reason} disabled={busy} onChange={event => { setReason(event.target.value); setSite(null); }} /></label>
      <button className="btn solid" disabled={busy || !reference.trim() || !reason.trim()}>{t("Load known site")}</button>
    </form>
    {error && <p className="drawer-error" role="alert">{t(error)}</p>}
    {notice && <p role="status">{notice}</p>}
    {site && <section className="admin-known-result" aria-label={t("Known site")}>
      <h2>{site.title}</h2><p><code>{site.slug}</code> · <code>{site.id}</code></p>
      <p>{t(site.purgedAt ? "Files permanently removed" : site.deletedAt ? "Deleted" : site.takenDownAt ? "Taken down" : "Active site")}</p>
      <p className="drawer-note">{t("Keep this address or ID for later recovery. No deleted-site catalog is available.")}</p>
      <div className="admin-actions-row">
        {actions.map(key => <button key={key} type="button" className={`btn${key === "delete" || key === "take-down" ? " danger" : ""}`} onClick={() => setAction(key)}>{t(labels[key])}</button>)}
      </div>
    </section>}
    <ReasonDialog open={action !== null} title={action ? t(labels[action]) : ""}
      body={action === "assign" ? t("Enter the verified email of an active account. Only an unowned site can be assigned.")
        : action === "delete" ? t("This removes the site for everyone. Files remain recoverable only during the retention window.")
          : t("This changes access to the known site. The action and your reason are recorded.")}
      reasonRequired={action === "assign" || action === "take-down" || action === "delete"}
      emailRequired={action === "assign"}
      confirmLabel={action ? t(labels[action]) : ""} danger={action === "delete" || action === "take-down"}
      onConfirm={act} onClose={() => setAction(null)} />
  </div>;
}
