"use client";

// Overview: the four numbers an operator looks at first, what the process is running on, and
// the last things administrators did.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import { adminFetch, formatBytes, formatWhen } from "@/components/admin/format";
import ActionLog from "@/components/admin/action-log";
import type { AdminLogEntry, AdminOverview } from "@/lib/types";

interface Payload { overview: AdminOverview; runtime: { lines: string[]; warnings: string[] }; recent: AdminLogEntry[] }

export default function AdminOverviewPage() {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<{ payload: Payload; loadedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminFetch<Payload>("/api/admin/overview").then((payload) => setData({ payload, loadedAt: Date.now() })).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="drawer-error" role="alert">{error}</p>;
  if (!data) return <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>;
  const o = data.payload.overview;
  const tiles: { label: string; value: string; href: string; note?: string }[] = [
    { label: t("Users"), value: String(o.users), href: "/admin/users", note: o.disabledUsers ? t("{n} disabled", { n: String(o.disabledUsers) }) : undefined },
    { label: t("Sites"), value: String(o.sites), href: "/admin/sites", note: o.takenDownSites ? t("{n} taken down", { n: String(o.takenDownSites) }) : undefined },
    { label: t("Storage"), value: formatBytes(o.byteTotal), href: "/admin/sites", note: o.deletedSites ? t("{n} deleted, restorable", { n: String(o.deletedSites) }) : undefined },
    { label: t("Anonymous sites"), value: String(o.anonymousSites), href: "/admin/sites?anonymous=1" },
  ];
  return (
    <>
      <div className="admin-tiles">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="admin-tile">
            <small>{tile.label}</small>
            <strong>{tile.value}</strong>
            {tile.note && <span>{tile.note}</span>}
          </Link>
        ))}
      </div>
      {data.payload.runtime.warnings.length > 0 && (
        <div className="admin-warnings" role="status">
          {data.payload.runtime.warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}
      <h2 className="admin-h2">{t("Recent administrative actions")}</h2>
      <ActionLog entries={data.payload.recent} emptyText={t("Nothing yet.")} />
      <p className="drawer-note">{t("Last updated {when}", { when: formatWhen(data.loadedAt, locale) })}</p>
    </>
  );
}
