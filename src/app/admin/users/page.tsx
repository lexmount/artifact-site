"use client";

// Users: every account with its live site count and stored bytes; disable / re-enable.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import MoreMenu from "@/components/more-menu";
import { useLocale, useT } from "@/components/locale-provider";
import { adminFetch, formatBytes, formatWhen } from "@/components/admin/format";
import ReasonDialog from "@/components/admin/reason-dialog";
import type { AdminUserRow } from "@/lib/types";

type Row = Omit<AdminUserRow, "providerSubject"> & { isAdmin: boolean };
type Sort = "recent" | "storage" | "sites";
const PAGE = 50;

export default function AdminUsersPage() {
  const t = useT();
  const locale = useLocale();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [disabledOnly, setDisabledOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ users: Row[]; total: number; quota: { sites: number; bytes: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Row | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ q, sort, limit: String(PAGE), offset: String(offset) });
    if (disabledOnly) params.set("disabled", "1");
    adminFetch<{ users: Row[]; total: number; quota: { sites: number; bytes: number } }>(`/api/admin/users?${params}`).then(setData).catch((e: Error) => setError(e.message));
  }, [q, sort, disabledOnly, offset]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="admin-toolbar">
        <label className="searchbox admin-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder={t("Search e-mail or name")} value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} aria-label={t("Search users")} />
        </label>
        <label className="admin-select">
          <span>{t("Sort")}</span>
          <select value={sort} onChange={(e) => { setOffset(0); setSort(e.target.value as Sort); }}>
            <option value="recent">{t("Recently active")}</option>
            <option value="storage">{t("Most storage")}</option>
            <option value="sites">{t("Most sites")}</option>
          </select>
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={disabledOnly} onChange={(e) => { setOffset(0); setDisabledOnly(e.target.checked); }} /> {t("Disabled only")}
        </label>
        {data && <span className="admin-count">{t("{n} accounts", { n: String(data.total) })}</span>}
      </div>
      {error && <p className="drawer-error" role="alert">{error}</p>}
      {!data && !error && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
      {data && (
        <div className="admin-tablewrap">
          <table className="admin-table">
            <thead>
              <tr><th>{t("User")}</th><th>{t("E-mail")}</th><th className="num">{t("Sites")}</th><th className="num">{t("Storage")}</th><th>{t("Last sign-in")}</th><th>{t("Status")}</th><th></th></tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.disabledAt ? "is-disabled" : undefined}>
                  <td>{u.displayName ?? "—"}</td>
                  <td><code>{u.email ?? "—"}</code>{u.email && !u.emailVerified && <span className="admin-pill warn">{t("unverified")}</span>}</td>
                  <td className={`num${data.quota.sites && u.siteCount >= data.quota.sites ? " at-cap" : ""}`}>{u.siteCount}{data.quota.sites ? ` / ${data.quota.sites}` : ""}</td>
                  <td className={`num${data.quota.bytes && u.byteTotal >= data.quota.bytes ? " at-cap" : ""}`}>{formatBytes(u.byteTotal)}{data.quota.bytes ? ` / ${formatBytes(data.quota.bytes)}` : ""}</td>
                  <td>{formatWhen(u.lastLoginAt, locale)}</td>
                  <td>{u.disabledAt
                    ? <span className="admin-pill off" title={u.disabledReason ?? undefined}>{t("Disabled")}{u.disabledReason ? ` · ${u.disabledReason}` : ""}</span>
                    : <span className="admin-pill ok">{t("Active account")}</span>}</td>
                  <td className="actions">
                    {u.isAdmin
                      ? <span className="admin-pill" title={t("Listed in ARTIFACT_ADMIN_EMAILS; remove the address there first.")}>{t("Administrator")}</span>
                      : (
                        <MoreMenu label={t("Actions")} iconOnly>
                          <button type="button" role="menuitem" className={`menu-item${u.disabledAt ? "" : " danger"}`} onClick={() => setTarget(u)}>
                            {u.disabledAt ? t("Re-enable") : t("Disable")}
                          </button>
                        </MoreMenu>
                      )}
                  </td>
                </tr>
              ))}
              {data.users.length === 0 && <tr><td colSpan={7} className="empty">{t("No accounts match.")}</td></tr>}
            </tbody>
          </table>
          {data.total > PAGE && (
            <div className="admin-pager">
              <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("Previous")}</button>
              <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} / {data.total}</span>
              <button type="button" className="btn sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t("Next")}</button>
            </div>
          )}
        </div>
      )}
      <ReasonDialog
        open={target != null}
        title={target?.disabledAt ? t("Re-enable {who}?", { who: target?.email ?? target?.displayName ?? "" }) : t("Disable {who}?", { who: target?.email ?? target?.displayName ?? "" })}
        body={target?.disabledAt
          ? t("They will be able to sign in again. Their sites were never affected.")
          : t("Sign-in will be refused from now on and every session and agent token is revoked immediately. Their sites stay online; take them down separately if the content is the problem. The reason is shown to them on their next sign-in attempt.")}
        reasonRequired={!target?.disabledAt}
        reasonHint={t("e.g. Publishing spam sites")}
        confirmLabel={target?.disabledAt ? t("Re-enable") : t("Disable")}
        danger={!target?.disabledAt}
        onConfirm={async (reason) => {
          if (!target) return;
          await adminFetch(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: "PATCH", body: { disabled: !target.disabledAt, reason: reason || undefined } });
          load();
        }}
        onClose={() => setTarget(null)}
      />
    </>
  );
}
