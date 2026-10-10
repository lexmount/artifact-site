"use client";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import TenantFormDialog from "@/components/admin/tenant-form-dialog";

type Member = { user_id: string; display_name: string | null; email: string | null; role: string; disabled_at: number | null; is_default: boolean | number; site_count: number | string };
export default function TenantMembers({ tenantId, disabled = false }: { tenantId: string; disabled?: boolean }) {
  const t = useT();
  const [members, setMembers] = useState<Member[] | null>(null), [error, setError] = useState(""), [status, setStatus] = useState("");
  const [email, setEmail] = useState(""), [role, setRole] = useState("member"), [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<Member | null>(null);
  const [q, setQ] = useState(""), [offset, setOffset] = useState(0);
  const endpoint = `/api/tenants/${encodeURIComponent(tenantId)}/members`;
  const load = useCallback(async () => { const data = await adminFetch<{ members: Member[] }>(endpoint); setMembers(data.members); setOffset(0); }, [endpoint]);
  useEffect(() => { let alive = true; adminFetch<{ members: Member[] }>(endpoint).then(data => { if (alive) setMembers(data.members); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [endpoint]);
  const admins = members?.filter(m => m.role === "admin" && !m.disabled_at).length ?? 0;
  function blocked(m: Member) {
    if (disabled) return t("Enable this tenant before changing members.");
    if (m.role === "admin" && !m.disabled_at && admins <= 1) return t("Assign another active administrator first.");
    if (Number(m.site_count)) return t("Transfer owned artifacts before removing this member.");
    if (m.is_default) return t("Change this user's default publishing tenant first.");
    return "";
  }
  async function save(body: unknown) { await adminFetch(endpoint, { method: "PUT", body }); await load(); setStatus(t("Saved")); }
  async function act(body: unknown) { setBusy(true); setError(""); setStatus(""); try { await save(body); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } finally { setBusy(false); } }
  const filtered = members?.filter(m => `${m.display_name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return <section className="tenant-members">
    {disabled && <p className="admin-warnings">{t("Enable this tenant before changing members.")}</p>}
    <form className="tenant-member-add" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await save({ email: email.trim(), role }); setEmail(""); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } finally { setBusy(false); } }}>
      <input type="email" required aria-label={t("Existing user email")} placeholder={t("Existing user email")} value={email} disabled={busy || disabled} onChange={e => setEmail(e.target.value)}/>
      <select aria-label={t("Tenant role")} value={role} disabled={busy || disabled} onChange={e => setRole(e.target.value)}><option value="member">{t("Tenant member")}</option><option value="admin">{t("Tenant administrator")}</option></select>
      <button className="btn solid" disabled={busy || disabled || !email.trim()}>{t("Add member")}</button>
    </form>
    {error && <p className="drawer-error" role="alert">{t(error)} <button className="btn sm" onClick={() => load().then(() => setError("")).catch(e => setError(e.message))}>{t("Retry")}</button></p>}
    <p role="status" className="tenant-status">{status}</p>
    {!members && !error && <div className="tenant-skeleton" aria-label={t("Loading…")} aria-busy="true"/>}
    {members && <>
      {members.length > 10 && <input className="tenant-member-search" type="search" aria-label={t("Search members")} placeholder={t("Search members")} value={q} onChange={e => { setQ(e.target.value); setOffset(0); }}/ >}
      <div className="admin-tablewrap"><table className="admin-table tenant-table"><thead><tr><th>{t("User")}</th><th>{t("Tenant role")}</th><th>{t("Actions")}</th></tr></thead><tbody>
        {filtered?.slice(offset, offset + 25).map(m => { const reason = blocked(m); return <tr key={m.user_id}><td>{m.display_name || m.email || m.user_id}<div className="admin-slug">{m.email}</div>{m.disabled_at && <span className="admin-pill off">{t("Disabled")}</span>}</td><td><select aria-label={t("Role for {name}", { name: m.display_name || m.email || m.user_id })} value={m.role} disabled={busy || disabled || Boolean(m.disabled_at) || (m.role === "admin" && admins <= 1)} onChange={e => void act({ userId: m.user_id, role: e.target.value })}><option value="member">{t("Tenant member")}</option><option value="admin">{t("Tenant administrator")}</option></select>{m.role === "admin" && !m.disabled_at && admins <= 1 && <div className="admin-slug">{t("Last active administrator")}</div>}</td><td><button className="btn sm" disabled={busy || Boolean(reason)} onClick={() => setRemove(m)}>{t("Remove")}</button>{reason && <div className="admin-slug tenant-block-reason">{reason}</div>}</td></tr>; })}
        {!filtered?.length && <tr><td colSpan={3} className="empty">{t("No members match.")}</td></tr>}
      </tbody></table></div>
      {(filtered?.length ?? 0) > 25 && <div className="admin-pager"><button className="btn sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>{t("Previous")}</button><span>{offset + 1}–{Math.min(offset + 25, filtered!.length)} / {filtered!.length}</span><button className="btn sm" disabled={offset + 25 >= filtered!.length} onClick={() => setOffset(offset + 25)}>{t("Next")}</button></div>}
    </>}
    <p className="drawer-note">{t("Adding members does not change their default publishing tenant.")}<br/>{t("Keep at least one active administrator.")}</p>
    {remove && <TenantFormDialog title={t("Remove member")} confirmLabel={t("Remove")} danger onClose={() => setRemove(null)} onSubmit={() => save({ userId: remove.user_id, role: null })}><p>{remove.display_name || remove.email}</p><p>{t("This removes membership and personal artifact grants in this tenant. Rejoining will not restore those grants.")}</p></TenantFormDialog>}
  </section>;
}
