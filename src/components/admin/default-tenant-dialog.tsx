"use client";
import { useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "./format";
import TenantFormDialog from "./tenant-form-dialog";
import type { TenantRow } from "./tenant-types";
export default function DefaultTenantDialog({ user, tenants, onClose, onSaved }: {
  user: { id: string; displayName: string | null; email: string | null; tenantId: string | null; disabledAt: number | null; memberships: { id: string; name: string }[] };
  tenants: TenantRow[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const t = useT(), [target, setTarget] = useState(user.tenantId ?? "");
  const current = tenants.find(row => row.id === user.tenantId);
  const selected = tenants.find(row => row.id === target);
  const active = tenants.filter(row => !row.disabledAt && row.id !== "anonymous");
  const joined = user.memberships.some(m => m.id === target);
  return <TenantFormDialog title={t("Change default publishing tenant")} confirmLabel={t("Save tenant changes")} onClose={onClose} disabled={!selected || Boolean(selected.disabledAt) || target === "anonymous" || (target === user.tenantId && joined)} onSubmit={async () => {
    await adminFetch(`/api/admin/users/${encodeURIComponent(user.id)}/tenant`, { method: "PATCH", body: { tenantId: target } }); await onSaved();
  }}>
    <p>{user.displayName} · {user.email}</p>
    {user.disabledAt != null && <p className="tenant-notice">{t("This account will remain disabled. Sign-in and revoked credentials will not be restored.")}</p>}
    <label>{t("Current default tenant")}<input disabled value={current?.name ?? t("Not set")}/></label>
    <label>{t("New default publishing tenant")}<select autoFocus required value={target} onChange={e => setTarget(e.target.value)}><option value="">{t("Select a tenant")}</option>{current?.disabledAt && <option disabled value={current.id}>{current.name} · {t("Disabled")}</option>}{active.map(row => <option key={row.id} value={row.id}>{row.name} · {row.slug}</option>)}</select></label>
    {selected && !joined && <p>{t("This user will join {name} as a member.", { name: selected.name })}</p>}
    {selected && joined && <p>{t("The existing role in the selected tenant will be preserved.")}</p>}
    <p className="tenant-notice">{t("Previous tenant memberships, roles and historical artifacts remain unchanged.")}</p>
    <p>{t("New artifacts without an explicit tenant will be published here.")}</p>
    {!active.length && <p>{t("Create or enable a tenant before changing the default.")}</p>}
  </TenantFormDialog>;
}
