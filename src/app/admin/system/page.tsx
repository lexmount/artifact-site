"use client";

// System: what the process runs on and the maintenance jobs on demand.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import ActionLog from "@/components/admin/action-log";
import type { AdminLogEntry } from "@/lib/types";

type Task = "purge-deleted" | "sweep-uploads" | "reconcile" | "expire-anonymous" | "backfill-text" | "prune-audit";

export default function AdminSystemPage() {
  const t = useT();
  const [runtime, setRuntime] = useState<{ lines: string[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<AdminLogEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState("");

  useEffect(() => {
    adminFetch<{ runtime: { lines: string[]; warnings: string[] } }>("/api/admin/overview").then((r) => setRuntime(r.runtime)).catch((e: Error) => setError(e.message));
    adminFetch<{ entries: AdminLogEntry[] }>("/api/admin/log?limit=200").then(r => setEntries(r.entries)).catch((e: Error) => setLogError(e.message));
  }, []);

  async function run(task: Task, dryRun?: boolean) {
    const key = `${task}${dryRun ? ":dry" : ""}`;
    setBusy(key); setResult(null); setError(null);
    try {
      if (task === "backfill-text") {
        // Each call works for a bounded time and says what is left; keep going until nothing is.
        let indexed = 0;
        for (let pass = 0; pass < 40; pass++) {
          const r = await adminFetch<{ task: Task; result: { indexed: number; remaining: number } }>("/api/admin/maintenance", { method: "POST", body: { task } });
          indexed += r.result.indexed;
          setResult(`${task}: ${JSON.stringify({ indexed, remaining: r.result.remaining })}`);
          if (!r.result.remaining || r.result.indexed === 0) break;
        }
        return;
      }
      const r = await adminFetch<{ task: Task; result: unknown }>("/api/admin/maintenance", { method: "POST", body: { task, dryRun } });
      setResult(`${task}${dryRun ? ` (${t("dry run")})` : ""}: ${JSON.stringify(r.result)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2 className="admin-h2">{t("Runtime")}</h2>
      {runtime ? <pre className="admin-runtime">{runtime.lines.join("\n")}</pre> : <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}

      <h2 className="admin-h2">{t("Maintenance")}</h2>
      <p className="drawer-note">{t("These jobs also run on their own about once an hour. Run one now when you do not want to wait.")}</p>
      <div className="admin-actions-row">
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("purge-deleted")}>{busy === "purge-deleted" && <Loader2 size={14} className="spin" />} {t("Purge deleted sites past retention")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("expire-anonymous")}>{busy === "expire-anonymous" && <Loader2 size={14} className="spin" />} {t("Expire unclaimed anonymous sites")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("prune-audit")}>{busy === "prune-audit" && <Loader2 size={14} className="spin" />} {t("Prune expired audit logs")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("sweep-uploads")}>{busy === "sweep-uploads" && <Loader2 size={14} className="spin" />} {t("Sweep abandoned uploads")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("backfill-text")}>{busy === "backfill-text" && <Loader2 size={14} className="spin" />} {t("Index search text of existing sites")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("reconcile", true)}>{busy === "reconcile:dry" && <Loader2 size={14} className="spin" />} {t("Reconcile storage (dry run)")}</button>
        <button type="button" className="btn sm danger" disabled={busy != null} onClick={() => run("reconcile", false)}>{busy === "reconcile" && <Loader2 size={14} className="spin" />} {t("Reconcile storage (delete orphans)")}</button>
      </div>
      {result && <pre className="admin-runtime" role="status">{result}</pre>}
      {error && <p className="drawer-error" role="alert">{error}</p>}
      <h2 className="admin-h2">{t("Action log")}</h2>
      <p className="drawer-note">{t("Showing up to 200 actions. Leave the target empty for system, user and your own site actions, or enter an exact user or site ID.")}</p>
      <form className="admin-known-site" onSubmit={async event => {
        event.preventDefault(); setLogBusy(true); setLogError(""); setEntries(null);
        try {
          const data = await adminFetch<{ entries: AdminLogEntry[] }>(`/api/admin/log?limit=200&target=${encodeURIComponent(target.trim())}`);
          setEntries(data.entries);
        } catch (err) { setLogError(err instanceof Error ? err.message : t("Request failed")); }
        finally { setLogBusy(false); }
      }}>
        <label>{t("Exact user or site ID")}<input value={target} maxLength={100} disabled={logBusy} onChange={event => setTarget(event.target.value)} /></label>
        <button className="btn" disabled={logBusy}>{t("Load audit records")}</button>
      </form>
      {logError && <p className="drawer-error" role="alert">{logError}</p>}
      {entries && <ActionLog entries={entries} emptyText={t("Nothing yet.")} />}
    </>
  );
}
