"use client";

// Sites: search, filter by state, take down / restore, delete / undelete.
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import { adminFetch, formatBytes, formatWhen } from "@/components/admin/format";
import ReasonDialog from "@/components/admin/reason-dialog";
import MoreMenu from "@/components/more-menu";
import type { AdminSiteRow, AdminSiteState } from "@/lib/types";

type Row = Omit<AdminSiteRow, "editToken" | "claimToken" | "anonOwnerId"> & { anonymous: boolean };
type Act = { kind: "assign" | "takeDown" | "restore" | "delete" | "undelete"; site: Row };
const PAGE = 50;

export default function AdminSitesPage() {
  return <Suspense fallback={null}><SitesView /></Suspense>;
}

function SitesView() {
  const t = useT();
  const locale = useLocale();
  const search = useSearchParams();
  const [q, setQ] = useState("");
  const [state, setState] = useState<AdminSiteState>("live");
  const [anonymousOnly, setAnonymousOnly] = useState(search.get("anonymous") === "1");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ sites: Row[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [act, setAct] = useState<Act | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ q, state, limit: String(PAGE), offset: String(offset) });
    if (anonymousOnly) params.set("anonymous", "1");
    adminFetch<{ sites: Row[]; total: number }>(`/api/admin/sites?${params}`).then(setData).catch((e: Error) => setError(e.message));
  }, [q, state, anonymousOnly, offset]);
  useEffect(() => { load(); }, [load]);

  const STATES: { id: AdminSiteState; label: string }[] = [
    { id: "live", label: "Live" }, { id: "taken_down", label: "Taken down" }, { id: "deleted", label: "Deleted" },
  ];

  const dialog = act && {
    assign: {
      title: t("Assign owner for “{title}”", { title: act.site.title }),
      body: t("Enter the verified email of an existing account. This gives that account full control of this unowned site and records the assignment in the audit log."),
      reasonRequired: true, confirm: t("Assign owner"), danger: false,
      run: (email: string) => adminFetch(`/api/admin/sites/${act.site.slug}/owner`, { method: "POST", body: { email } }),
    },
    takeDown: {
      title: t("Take down “{title}”?", { title: act.site.title }),
      body: t("Visitors will see “This content has been removed by an administrator”. Share links stop working. The owner can still open it and save a copy; nothing is deleted, and you can restore it at any time."),
      reasonRequired: true, confirm: t("Take down"), danger: true,
      run: (reason: string) => adminFetch(`/api/admin/sites/${act.site.slug}`, { method: "PATCH", body: { takenDown: true, reason } }),
    },
    restore: {
      title: t("Restore “{title}”?", { title: act.site.title }),
      body: t("The site is served again to everyone its sharing settings allow."),
      reasonRequired: false, confirm: t("Restore"), danger: false,
      run: (reason: string) => adminFetch(`/api/admin/sites/${act.site.slug}`, { method: "PATCH", body: { takenDown: false, reason: reason || undefined } }),
    },
    delete: {
      title: t("Delete “{title}”?", { title: act.site.title }),
      body: t("The site disappears for everyone, including its owner. Its files are kept for the retention window, so it can be restored from the “Deleted” view until then."),
      reasonRequired: true, confirm: t("Delete"), danger: true,
      run: (reason: string) => adminFetch(`/api/admin/sites/${act.site.slug}`, { method: "DELETE", body: { reason } }),
    },
    undelete: {
      title: t("Restore deleted site “{title}”?", { title: act.site.title }),
      body: t("The site comes back at its old address with every version intact."),
      reasonRequired: false, confirm: t("Restore"), danger: false,
      run: (reason: string) => adminFetch(`/api/admin/sites/${act.site.slug}`, { method: "PATCH", body: { deleted: false, reason: reason || undefined } }),
    },
  }[act.kind];

  return (
    <>
      <div className="admin-toolbar">
        <label className="searchbox admin-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder={t("Search title, address or owner e-mail")} value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} aria-label={t("Search sites")} />
        </label>
        <div className="hm-tabs admin-states" role="tablist" aria-label={t("Site state")}>
          {STATES.map((s) => (
            <button key={s.id} type="button" role="tab" className="hm-tab" aria-selected={state === s.id} onClick={() => { setOffset(0); setState(s.id); }}>{t(s.label)}</button>
          ))}
        </div>
        <label className="admin-check">
          <input type="checkbox" checked={anonymousOnly} onChange={(e) => { setOffset(0); setAnonymousOnly(e.target.checked); }} /> {t("Anonymous only")}
        </label>
        {data && <span className="admin-count">{t("{n} sites", { n: String(data.total) })}</span>}
      </div>
      {error && <p className="drawer-error" role="alert">{error}</p>}
      {!data && !error && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
      {data && (
        <div className="admin-tablewrap">
          <table className="admin-table">
            <thead>
              <tr><th>{t("Title")}</th><th>{t("Owner")}</th><th>{t("Kind")}</th><th>{t("Visibility")}</th><th className="num">{t("Versions")}</th><th className="num">{t("Size")}</th><th>{t("Updated")}</th><th></th></tr>
            </thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="admin-site-title">
                      {s.deletedAt ? <span>{s.title}</span> : <Link href={`/s/${s.slug}`} target="_blank" rel="noreferrer">{s.title} <ExternalLink size={11} aria-hidden="true" /></Link>}
                      {s.takenDownAt && <span className="admin-pill off" title={s.takenDownReason ?? undefined}>{t("Taken down")}</span>}
                      {s.deletedAt && <span className="admin-pill off">{s.purgedAt ? t("Purged") : t("Deleted")}</span>}
                    </div>
                    <code className="admin-slug">/s/{s.slug}</code>
                  </td>
                  <td>{s.anonymous ? <span className="admin-pill">{t("Anonymous")}</span> : <code>{s.ownerEmail ?? s.ownerName ?? s.ownerId}</code>}</td>
                  <td>{s.kind === "single" ? t("Single file") : s.kind === "document" ? t("Document") : t("Folder")}</td>
                  <td>{t(s.visibility[0].toUpperCase() + s.visibility.slice(1))}</td>
                  <td className="num">{s.versionCount}</td>
                  <td className="num">{formatBytes(s.byteTotal)}</td>
                  <td>{formatWhen(s.updatedAt, locale)}</td>
                  <td className="actions">
                    {/* Take down / delete are not icons in the row: they sit behind "···", named in words, as the design draws it. */}
                    {!(s.deletedAt && s.purgedAt) && (
                      <MoreMenu label={t("Actions")} iconOnly>
                        {s.deletedAt
                          ? <button type="button" role="menuitem" className="menu-item" onClick={() => setAct({ kind: "undelete", site: s })}>{t("Restore")}</button>
                          : (
                            <>
                              <Link role="menuitem" className="menu-item" href={`/s/${s.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" /> {t("Open")}</Link>
                              {s.takenDownAt
                                ? <button type="button" role="menuitem" className="menu-item" onClick={() => setAct({ kind: "restore", site: s })}>{t("Restore")}</button>
                                : <button type="button" role="menuitem" className="menu-item danger" onClick={() => setAct({ kind: "takeDown", site: s })}>{t("Take down")}</button>}
                              {!s.ownerId && <button type="button" role="menuitem" className="menu-item" onClick={() => setAct({ kind: "assign", site: s })}>{t("Assign owner")}</button>}
                              <button type="button" role="menuitem" className="menu-item danger" onClick={() => setAct({ kind: "delete", site: s })}>{t("Delete")}</button>
                            </>
                          )}
                      </MoreMenu>
                    )}
                  </td>
                </tr>
              ))}
              {data.sites.length === 0 && <tr><td colSpan={8} className="empty">{t("No sites match.")}</td></tr>}
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
        open={act != null}
        title={dialog?.title ?? ""}
        body={dialog?.body ?? ""}
        reasonRequired={dialog?.reasonRequired ?? false}
        inputLabel={act?.kind === "assign" ? t("Recipient email") : undefined}
        inputType={act?.kind === "assign" ? "email" : undefined}
        reasonHint={t("e.g. Phishing page reported by a user")}
        confirmLabel={dialog?.confirm ?? ""}
        danger={dialog?.danger ?? false}
        onConfirm={async (reason) => { if (!dialog) return; await dialog.run(reason); load(); }}
        onClose={() => setAct(null)}
      />
    </>
  );
}
