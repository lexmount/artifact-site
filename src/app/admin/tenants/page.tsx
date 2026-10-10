"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import MoreMenu from "@/components/more-menu";
import TenantCreateDialog from "@/components/admin/tenant-create-dialog";
import TenantSettingsDialog from "@/components/admin/tenant-settings-dialog";
import { systemTenant, type TenantRow } from "@/components/admin/tenant-types";

export default function AdminTenantsPage() {
  const t = useT();
  const [rows, setRows] = useState<TenantRow[] | null>(null), [error, setError] = useState("");
  const [q, setQ] = useState(""), [state, setState] = useState("all"), [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<{ tenant: TenantRow; mode: "name" | "status" } | null>(null);
  const [status, setStatus] = useState("");
  const load = useCallback(async () => { const data = await adminFetch<{ tenants: TenantRow[] }>("/api/tenants"); setRows(data.tenants); setError(""); }, []);
  useEffect(() => { let alive = true; adminFetch<{ tenants: TenantRow[] }>("/api/tenants").then(data => { if (alive) setRows(data.tenants); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  const filtered = rows?.filter(row => `${row.name} ${row.slug}`.toLowerCase().includes(q.toLowerCase()) && (state === "all" || Boolean(row.disabledAt) === (state === "disabled")));
  return <>
    <div className="admin-toolbar tenant-toolbar">
      <label className="searchbox admin-search"><Search size={16}/><input type="search" aria-label={t("Search tenants")} placeholder={t("Search tenant name or identifier")} value={q} onChange={e => setQ(e.target.value)}/></label>
      <label className="admin-select"><select aria-label={t("Status")} value={state} onChange={e => setState(e.target.value)}><option value="all">{t("All statuses")}</option><option value="active">{t("Enabled")}</option><option value="disabled">{t("Disabled")}</option></select></label>
      <button className="btn solid tenant-create" onClick={() => setCreate(true)}><Plus size={16}/>{t("Create tenant")}</button>
    </div>
    {error && <p role="alert" className="drawer-error">{t(error)} <button className="btn sm" onClick={() => load().catch(e => setError(e.message))}>{t("Retry")}</button></p>}
    <p role="status" className="tenant-status">{status}</p>
    {!rows && !error && <div className="tenant-skeleton" aria-label={t("Loading…")} aria-busy="true"/>}
    {filtered && <><div className="admin-tablewrap"><table className="admin-table tenant-table"><thead><tr><th>{t("Tenant")}</th><th>{t("English identifier")}</th><th>{t("Status")}</th><th>{t("Actions")}</th></tr></thead><tbody>
      {filtered.map(row => <tr key={row.id}><td>{row.name} {systemTenant(row.id) && <span className="admin-pill">{t("System tenant")}</span>}</td><td><code>{row.slug}</code></td><td><span className={`admin-pill ${row.disabledAt ? "off" : "ok"}`}>{t(row.disabledAt ? "Disabled" : "Enabled")}</span></td><td className="actions">{row.id !== "anonymous" && <Link className="btn sm" href={`/admin/tenants/${encodeURIComponent(row.id)}`}>{t("Members")}</Link>} {row.id !== "anonymous" && <MoreMenu label={t("Actions for {name}", { name: row.name })} iconOnly><button className="menu-item" role="menuitem" onClick={() => setEdit({ tenant: row, mode: "name" })}>{t("Rename")}</button>{(!systemTenant(row.id) || Boolean(row.disabledAt)) && <button className="menu-item" role="menuitem" onClick={() => setEdit({ tenant: row, mode: "status" })}>{t(row.disabledAt ? "Enable tenant" : "Disable tenant")}</button>}</MoreMenu>}</td></tr>)}
      {!filtered.length && <tr><td colSpan={4} className="empty">{t("No tenants match.")}</td></tr>}
    </tbody></table></div><p className="drawer-note">{t("{n} tenants", { n: filtered.length })}</p></>}
    {create && <TenantCreateDialog onClose={() => setCreate(false)} onCreated={async () => { await load(); setStatus(t("Tenant created")); }}/ >}
    {edit && <TenantSettingsDialog {...edit} onClose={() => setEdit(null)} onSaved={async () => { await load(); setStatus(t("Saved")); }}/ >}
  </>;
}
