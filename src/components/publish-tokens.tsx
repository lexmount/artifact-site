// Publish tokens — the personal centre's view of what can publish as you, and the kill switch.
// Listing/revoking is browser-session-only (the API refuses token sessions), so a leaked token
// cannot hide itself or shed its siblings.
"use client";

import { useCallback, useEffect, useState } from "react";
import TokenCreate from "@/components/token-create";
import CommandBlock from "@/components/command-block";
import { Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import { formatDate, countText } from "@/lib/i18n";

interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export default function PublishTokensCard() {
  const t = useT();
  const [created, setCreated] = useState("");
  const locale = useLocale();
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/me/tokens")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error ?? t("Failed to load")))))
      .then((d: { tokens: TokenRow[] }) => setTokens(d.tokens))
      .catch((e: Error) => setError(e.message));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/me/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? t("Failed to revoke the token"));
      }
      load();
    } catch {
      setError(t("Network error. Try again later."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="sites-section" aria-label={t("Publish tokens")}>
      <div className="sites-head">
        <h2>{t("Publish tokens")}</h2>
        <span>{tokens ? countText(t, tokens.length, "{n} token", "{n} tokens") : ""}</span>
      </div>
      <p className="drawer-note">
        {t("Terminal and agent sessions publish as you with a token, so a site is yours from the moment it is created. When publishing, the agent walks you through a one-time device authorization; revoking takes effect immediately.")}
      </p>
      <TokenCreate onCreated={(token) => { setCreated(token); load(); }} />
      {created && <><p>{t("Copy this token now. It is shown only once; revoke it here when no longer needed.")}</p><CommandBlock command={created} /><button className="btn" onClick={() => setCreated("")}>{t("Dismiss token")}</button></>}
      {error && <p className="drawer-error" role="alert">{error}</p>}
      {tokens && tokens.length > 0 && (
        <ul className="me-list">
          {tokens.map((row) => (
            <li key={row.id}>
              <span>{row.name}</span>
              <small>
                {t("Created {date}", { date: formatDate(row.createdAt, locale) })}
                {row.lastUsedAt ? ` · ${t("Last used {date}", { date: formatDate(row.lastUsedAt, locale) })}` : ` · ${t("Never used")}`}
              </small>
              <button type="button" className="btn danger sm" onClick={() => revoke(row.id)} disabled={busyId === row.id}>
                {busyId === row.id && <Loader2 size={12} className="spin" />} {t("Revoke token")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {tokens && tokens.length === 0 && <p className="drawer-note">{t("No tokens yet. When you have an agent publish, it will walk you through authorization.")}</p>}
    </section>
  );
}
