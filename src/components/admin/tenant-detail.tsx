"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";
import DefaultSharingSettings from "@/components/sharing/default-settings";
import TenantMembers from "@/components/tenant-members";
import { adminFetch } from "./format";
import { systemTenant, type TenantRow } from "./tenant-types";
import TenantSettingsDialog from "./tenant-settings-dialog";
export default function TenantDetail({ tenantId, account = false }: { tenantId: string; account?: boolean }) {
  const t = useT();
  const [tenant, setTenant] = useState<TenantRow | null>(null), [error, setError] = useState("");
  const [tab, setTab] = useState("settings"), [edit, setEdit] = useState<"name" | "status" | null>(null);
  const load = useCallback(async () => {
    const data = await adminFetch<{ tenants: TenantRow[] }>("/api/tenants");
    const row = data.tenants.find(r => r.id === tenantId && (!account || ["admin", "platform-admin"].includes(r.role)));
    if (!row || row.id === "anonymous") throw new Error("Tenant not found");
    setTenant(row);
  }, [tenantId, account]);
  useEffect(() => {
    let alive = true;
    adminFetch<{ tenants: TenantRow[] }>("/api/tenants").then(data => {
      if (!alive) return;
      const row = data.tenants.find(r => r.id === tenantId && r.id !== "anonymous" && (!account || ["admin", "platform-admin"].includes(r.role)));
      if (row) setTenant(row); else setError("Tenant not found");
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [tenantId, account]);
  return <>
    <Link className="quiet tenant-back" href={account ? "/me" : "/admin/tenants"}>← {t(account ? "My sites" : "Back to tenants")}</Link>
    {error && <p className="drawer-error" role="alert">{t(error)}</p>}
    {!tenant && !error && <div className="tenant-skeleton" aria-label={t("Loading…")} aria-busy="true"/>}
    {tenant && <><div className="tenant-detail-title"><h2>{tenant.name}</h2><code>{tenant.slug}</code> {tenant.disabledAt && <span className="admin-pill off">{t("Disabled")}</span>}</div>
      <div className="hm-tabs" role="tablist" aria-label={t("Tenant details")}><button className="hm-tab" role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")}>{t("Members")}</button><button className="hm-tab" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>{t("Settings")}</button></div>
      {tab === "members" ? <TenantMembers key={`${tenant.id}-${tenant.disabledAt}`} tenantId={tenant.id} disabled={Boolean(tenant.disabledAt)}/> : <div className="tenant-settings-sections"><section className="admin-settings"><h2>{t("Basic settings")}</h2>
        <div className="tenant-setting"><div><strong>{t("Tenant name")}</strong><p>{tenant.name}</p></div><button className="btn" onClick={() => setEdit("name")}>{t("Rename")}</button></div>
        <div className="tenant-setting"><div><strong>{t("English identifier")}</strong><p>{tenant.slug} · {t("The identifier cannot be changed.")}</p></div></div>
        <div className="tenant-setting"><div><strong>{t("Status")}</strong><p>{t(systemTenant(tenant.id) ? "System workspaces cannot be disabled" : tenant.disabledAt ? "Disabled" : "Enabled")}</p></div>{tenant.role === "platform-admin" && (!systemTenant(tenant.id) || Boolean(tenant.disabledAt)) && <button className="btn" onClick={() => setEdit("status")}>{t(tenant.disabledAt ? "Enable tenant" : "Disable tenant")}</button>}</div>
      </section><DefaultSharingSettings tenant tenantId={tenant.id}/></div>}
      {account && tab === "members" && <p><Link href="/authorization" className="btn">{t("Manage authorization")}</Link></p>}
      {edit && <TenantSettingsDialog tenant={tenant} mode={edit} onClose={() => setEdit(null)} onSaved={load}/>}
    </>}
  </>;
}
