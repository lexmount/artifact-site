"use client";

// Settings: the policy an operator may change without a rebuild. Each row shows the value in
// force, where it comes from, and what the environment would give instead; "Use environment"
// takes the console value off again.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import { adminFetch, formatBytes, formatWhen } from "@/components/admin/format";

interface View { key: string; kind: "enum" | "int"; options?: string[]; value: string | number; source: "console" | "environment"; envValue: string | number; env: string; updatedAt: number | null }

const LABELS: Record<string, { label: string; help: string }> = {
  createPolicy: { label: "Who can create sites", help: "open: anyone who can reach the service. login: signed-in accounts only. token: only scripts holding the API token." },
  anonymousSites: { label: "Sites created without an account", help: "full: the creating browser owns the site (edit, share, delete). read-only: the browser can only open it; every other action asks for a sign-in, after which the site belongs to that account. Needs ownership enforcement." },
  defaultVisibility: { label: "New sites are", help: "public: listed and open to anyone. unlisted: open to anyone with the address. private: owner and collaborators only, until shared." },
  anonSiteTtlDays: { label: "Unclaimed anonymous sites are removed after (days)", help: "0 = never. Counted from the last change; removal is an ordinary delete an administrator can undo within the retention window." },
  quotaSitesPerUser: { label: "Sites per account", help: "0 = unlimited." },
  quotaBytesPerUser: { label: "Storage per account (bytes)", help: "0 = unlimited. Every version of every site counts." },
  quotaSitesPerAnon: { label: "Sites per anonymous browser", help: "0 = unlimited." },
  quotaBytesPerAnon: { label: "Storage per anonymous browser (bytes)", help: "0 = unlimited." },
};
const OPTION_LABELS: Record<string, string> = { open: "Anyone", login: "Signed-in accounts", token: "API token only", full: "Owned by the creating browser", "read-only": "Read-only until signed in", public: "Public", unlisted: "Unlisted", private: "Private" };

export default function AdminSettingsPage() {
  const t = useT();
  const locale = useLocale();
  const [rows, setRows] = useState<View[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    adminFetch<{ settings: View[] }>("/api/admin/settings").then((r) => { setRows(r.settings); setDraft({}); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(values: Record<string, string | number | null>) {
    setBusy(true); setError(null); setSaved(null);
    try {
      const r = await adminFetch<{ settings: View[]; changed: string[] }>("/api/admin/settings", { method: "PUT", body: { values } });
      setRows(r.settings); setDraft({});
      setSaved(r.changed.length ? t("Saved. Other replicas follow within half a minute.") : t("Nothing changed."));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !rows) return <p className="drawer-error" role="alert">{error}</p>;
  if (!rows) return <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>;
  const dirty = Object.keys(draft).length > 0;

  return (
    <form className="admin-settings" onSubmit={(e) => { e.preventDefault(); void save(draft); }}>
      <p className="drawer-note">{t("Values set here override the environment variables and take effect without a rebuild. Everything else (database, storage, sign-in, the public address, the administrator list) stays in the environment.")}</p>
      {rows.map((s) => {
        const meta = LABELS[s.key] ?? { label: s.key, help: "" };
        const current = draft[s.key] ?? String(s.value);
        return (
          <div className="admin-setting" key={s.key}>
            <div className="admin-setting-head">
              <label htmlFor={`set-${s.key}`}>{t(meta.label)}</label>
              <span className={`admin-pill ${s.source === "console" ? "ok" : ""}`} title={s.source === "console" ? t("Set from this console") : t("From the environment ({env}) or the built-in default", { env: s.env })}>
                {s.source === "console" ? t("console") : t("environment")}
              </span>
            </div>
            <p className="admin-setting-help">{meta.help ? t(meta.help) : null}</p>
            <div className="admin-setting-row">
              {s.kind === "enum" ? (
                <select id={`set-${s.key}`} value={current} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}>
                  {s.options!.map((o) => <option key={o} value={o}>{t(OPTION_LABELS[o] ?? o)}</option>)}
                </select>
              ) : (
                <input id={`set-${s.key}`} type="number" min={0} step={1} value={current} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
              )}
              {s.kind === "int" && s.key.startsWith("quotaBytes") && <span className="admin-setting-note">{formatBytes(Number(current) || 0)}</span>}
              {s.source === "console" && (
                <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void save({ [s.key]: null })}
                  title={t("Remove the console value; the environment ({env}) decides again: {value}", { env: s.env, value: String(s.envValue) })}>
                  {t("Use environment")}
                </button>
              )}
              {s.updatedAt && <span className="admin-setting-note">{t("changed {when}", { when: formatWhen(s.updatedAt, locale) })}</span>}
            </div>
          </div>
        );
      })}
      <div className="admin-actions-row">
        <button type="submit" className="btn solid" disabled={!dirty || busy}>{busy && <Loader2 size={14} className="spin" />} {t("Save changes")}</button>
        {dirty && <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft({})}>{t("Discard")}</button>}
        {saved && <span className="drawer-note" role="status">{saved}</span>}
        {error && <span className="drawer-error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
