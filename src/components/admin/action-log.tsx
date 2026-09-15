"use client";

// admin_log rows as a table: who did what to which target, and why.
import { useLocale, useT } from "@/components/locale-provider";
import { formatWhen } from "@/components/admin/format";
import type { AdminLogEntry } from "@/lib/types";

const ACTION_LABELS: Record<AdminLogEntry["action"], string> = {
  "user.disable": "Disabled account",
  "user.enable": "Re-enabled account",
  "site.assign_owner": "Assigned site owner",
  "site.take_down": "Took site down",
  "site.restore": "Restored site",
  "site.delete": "Deleted site",
  "site.undelete": "Restored deleted site",
  "site.view": "Opened a non-public site",
  "maintenance.purge_deleted": "Purged deleted sites",
  "maintenance.sweep_uploads": "Swept upload sessions",
  "maintenance.reconcile": "Reconciled storage",
  "maintenance.expire_anonymous": "Expired anonymous sites",
  "maintenance.prune_audit": "Pruned expired audit logs",
  "maintenance.backfill_text": "Backfilled search text",
  "settings.update": "Changed settings",
};

export default function ActionLog({ entries, emptyText }: { entries: AdminLogEntry[]; emptyText: string }) {
  const t = useT();
  const locale = useLocale();
  if (entries.length === 0) return <p className="drawer-note">{emptyText}</p>;
  return (
    <div className="admin-tablewrap">
      <table className="admin-table">
        <thead>
          <tr><th>{t("When")}</th><th>{t("Action")}</th><th>{t("Target")}</th><th>{t("By")}</th><th>{t("Reason")}</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="num">{formatWhen(e.createdAt, locale)}</td>
              <td>{t(ACTION_LABELS[e.action] ?? e.action)}</td>
              <td><code>{e.targetId}</code></td>
              <td>{e.actorKind === "token" ? t("API token") : e.actorKind === "system" ? t("Automatic") : <code>{e.actorUserId}</code>}</td>
              <td>{e.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
