"use client";

// System: what the process runs on, the maintenance jobs on demand, and the full action log.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import ActionLog from "@/components/admin/action-log";
import type { AdminLogEntry } from "@/lib/types";

type Task = "purge-deleted" | "sweep-uploads" | "reconcile" | "expire-anonymous" | "backfill-text";

export default function AdminSystemPage() {
  const t = useT();
  const [runtime, setRuntime] = useState<{ lines: string[]; warnings: string[] } | null>(null);
  const [log, setLog] = useState<AdminLogEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLog = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (target.trim()) params.set("target", target.trim());
    adminFetch<{ entries: AdminLogEntry[] }>(`/api/admin/log?${params}`).then((r) => setLog(r.entries)).catch((e: Error) => setError(e.message));
  }, [target]);
  useEffect(() => {
    adminFetch<{ runtime: { lines: string[]; warnings: string[] } }>("/api/admin/overview").then((r) => setRuntime(r.runtime)).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { loadLog(); }, [loadLog]);

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
        loadLog();
        return;
      }
      const r = await adminFetch<{ task: Task; result: unknown }>("/api/admin/maintenance", { method: "POST", body: { task, dryRun } });
      setResult(`${task}${dryRun ? ` (${t("dry run")})` : ""}: ${JSON.stringify(r.result)}`);
      loadLog();
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
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("sweep-uploads")}>{busy === "sweep-uploads" && <Loader2 size={14} className="spin" />} {t("Sweep abandoned uploads")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("backfill-text")}>{busy === "backfill-text" && <Loader2 size={14} className="spin" />} {t("Index search text of existing sites")}</button>
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => run("reconcile", true)}>{busy === "reconcile:dry" && <Loader2 size={14} className="spin" />} {t("Reconcile storage (dry run)")}</button>
        <button type="button" className="btn sm danger" disabled={busy != null} onClick={() => run("reconcile", false)}>{busy === "reconcile" && <Loader2 size={14} className="spin" />} {t("Reconcile storage (delete orphans)")}</button>
      </div>
      {result && <pre className="admin-runtime" role="status">{result}</pre>}
      {error && <p className="drawer-error" role="alert">{error}</p>}

      <h2 className="admin-h2">{t("Action log")}</h2>
      <div className="admin-toolbar">
        <label className="searchbox admin-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder={t("Filter by user or site id")} value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t("Filter the action log")} />
        </label>
      </div>
      {log ? <ActionLog entries={log} emptyText={t("Nothing yet.")} /> : <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
    </>
  );
}
