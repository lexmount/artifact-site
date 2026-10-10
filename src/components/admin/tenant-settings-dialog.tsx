"use client";
import { useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "./format";
import TenantFormDialog from "./tenant-form-dialog";
import type { TenantRow } from "./tenant-types";
export default function TenantSettingsDialog({ tenant, mode, onClose, onSaved }: { tenant: TenantRow; mode: "name" | "status"; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT(), [name, setName] = useState(tenant.name);
  const label = mode === "name" ? t("Rename tenant") : t(tenant.disabledAt ? "Enable tenant" : "Disable tenant");
  return <TenantFormDialog title={label} confirmLabel={mode === "name" ? t("Save tenant changes") : label} danger={mode === "status" && !tenant.disabledAt} onClose={onClose} disabled={mode === "name" && !name.trim()} onSubmit={async () => {
    await adminFetch(`/api/tenants/${encodeURIComponent(tenant.id)}`, { method: "PATCH", body: mode === "name" ? { name: name.trim() } : { disabled: !tenant.disabledAt } }); await onSaved();
  }}>
    {mode === "name" ? <><label>{t("Tenant name")}<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)}/></label><label>{t("English identifier")}<input value={tenant.slug} disabled/></label><p>{t("The identifier cannot be changed.")}</p></> : <><p>{tenant.name} · {tenant.slug}</p><p>{t(tenant.disabledAt ? "Members will regain access to this tenant and its artifacts." : "Disabling this tenant blocks access to its artifacts and publishing into it. Memberships, roles and files are retained.")}</p>{!tenant.disabledAt && <p>{t("Affected: {users} default publishing accounts and {sites} artifacts. Default tenants will not be changed automatically.", { users: tenant.defaultUserCount ?? 0, sites: tenant.siteCount ?? 0 })}</p>}</>}
  </TenantFormDialog>;
}
