"use client";
import { useState } from "react";
import { useT } from "@/components/locale-provider";

export default function TokenCreate({ onCreated }: { onCreated: (token: string) => void }) {
  const t = useT(); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <form className="connection-token-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/me/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      onCreated(result.token); setName("");
    } catch (error) { setError(error instanceof Error ? error.message : t("Network error. Try again later.")); }
    finally { setBusy(false); }
  }}>
    <label>{t("Token name")}<input className="field" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder={t("For example: My agent")} /></label>
    <button className="btn" disabled={busy || !name.trim()}>{busy ? t("Creating…") : t("Create personal token")}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
