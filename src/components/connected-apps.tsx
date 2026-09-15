// Connected applications — the account page's view of what reaches this account through OAuth
// (ChatGPT, Claude and other MCP clients that signed in rather than pasting a token), and the
// kill switch for each. Listing and disconnecting are browser-session-only, like publish tokens:
// a leaked access token cannot hide its grant or shed its siblings.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import { countText, formatDate } from "@/lib/i18n";

interface ConnectionRow {
  id: string;
  clientId: string;
  clientName: string;
  clientHost: string | null;
  scope: string;
  connectedAt: number;
  lastUsedAt: number | null;
}

export default function ConnectedAppsCard() {
  const t = useT();
  const locale = useLocale();
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/me/connections")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error ?? t("Failed to load")))))
      .then((d: { connections: ConnectionRow[] }) => setRows(d.connections))
      .catch((e: Error) => setError(e.message));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function disconnect(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/me/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? t("Failed to disconnect the application"));
      }
      load();
    } catch {
      setError(t("Network error. Try again later."));
    } finally {
      setBusyId(null);
    }
  }

  const access = (scope: string) => (scope.split(/\s+/).includes("artifacts:write") ? t("Read and change") : t("Read only"));

  return (
    <section className="sites-section" aria-label={t("Connected applications")}>
      <div className="sites-head">
        <h2>{t("Connected applications")}</h2>
        <span>{rows ? countText(t, rows.length, "{n} application", "{n} applications") : ""}</span>
      </div>
      <p className="drawer-note">
        {t("Applications such as ChatGPT connect to this server by signing in as you, without a token to paste. Disconnecting takes effect immediately; the application has to ask for your permission again.")}
      </p>
      {error && <p className="drawer-error" role="alert">{error}</p>}
      {rows && rows.length > 0 && (
        <ul className="me-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>{row.clientName}{row.clientHost ? ` · ${row.clientHost}` : ""}</span>
              <small>
                {access(row.scope)}
                {` · ${t("Connected {date}", { date: formatDate(row.connectedAt, locale) })}`}
                {row.lastUsedAt ? ` · ${t("Last used {date}", { date: formatDate(row.lastUsedAt, locale) })}` : ` · ${t("Never used")}`}
              </small>
              <button type="button" className="btn danger sm" onClick={() => disconnect(row.id)} disabled={busyId === row.id}>
                {busyId === row.id && <Loader2 size={12} className="spin" />} {t("Disconnect")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows && rows.length === 0 && <p className="drawer-note">{t("No applications are connected. Connect ChatGPT or another MCP client from the agent guide.")}</p>}
    </section>
  );
}
