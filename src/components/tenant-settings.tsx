"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import AppShell from "@/components/app-shell";
import { useT } from "@/components/locale-provider";
import TenantDetail from "@/components/admin/tenant-detail";
import { adminFetch } from "@/components/admin/format";
import type { TenantRow } from "@/components/admin/tenant-types";

export default function TenantSettings() {
  const t = useT();
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    adminFetch<{ tenants: TenantRow[] }>("/api/tenants").then(data => {
      if (!alive) return;
      const managed = data.tenants.filter(x => x.id !== "anonymous" && ["admin", "platform-admin"].includes(x.role));
      setTenants(managed);
      setSelected(managed.find(x => x.id === "init")?.id ?? managed[0]?.id ?? "");
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  return <AppShell><div className="tenant-settings">
    <div className="work-title"><h1>{t("Tenant settings")}</h1></div>
    {error && <p className="drawer-error" role="alert">{t(error)}</p>}
    {!tenants && !error && <p>{t("Loading…")}</p>}
    {tenants?.length === 0 && <p>{t("Tenant settings are available to administrators.")} <Link href="/me/sharing">{t("Sharing preferences")}</Link></p>}
    {tenants && tenants.length > 1 && <label className="tenant-manager-picker">{t("Tenant")}<select value={selected} onChange={e => setSelected(e.target.value)}>{tenants.map(x => <option key={x.id} value={x.id}>{x.name}{x.disabledAt ? ` (${t("Disabled")})` : ""}</option>)}</select></label>}
    {selected && <TenantDetail key={selected} tenantId={selected} account/>}
  </div></AppShell>;
}
