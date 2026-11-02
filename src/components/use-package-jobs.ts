"use client";
import { useCallback, useEffect, useState } from "react";
import { appFetch, appPath } from "@/lib/app-path";
import { useAuth } from "@/lib/use-auth";
import type { PackageJobStatus } from "@/lib/package-job-contract";
import { acknowledgeJobs, readJobReceipts, type JobReceipts } from "@/lib/package-job-notices";
const EMPTY: PackageJobStatus[] = [];
const NO_RECEIPTS: JobReceipts = {};
export function usePackageJobs() {
  const auth = useAuth();
  const scope = auth.loading ? null : `${appPath("/")}:${auth.user?.id ?? "browser"}`;
  const storageKey = `artifact:upload-read:${scope}`;
  const [data, setData] = useState<{ scope: string; jobs: PackageJobStatus[]; error: string; loaded: boolean; now: number } | null>(null);
  const [read, setRead] = useState<{ key: string; values: JobReceipts } | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (!scope) return;
    const sync = () => {
      let values: JobReceipts = {};
      try { values = readJobReceipts(localStorage.getItem(storageKey)); } catch { /* Storage may be blocked. */ }
      setRead({ key: storageKey, values });
    };
    sync(); window.addEventListener("storage", sync); window.addEventListener("package-jobs-read", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("package-jobs-read", sync); };
  }, [scope, storageKey]);
  useEffect(() => {
    if (!scope) return;
    let alive = true, loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await appFetch("/api/uploads/jobs", { signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.jobs)) throw new Error();
        if (alive) {
          const jobs = body.jobs as PackageJobStatus[];
          for (const job of jobs) if (job.status === "completed" && typeof job.result?.editToken === "string") {
            try { localStorage.setItem(`sites:editToken:${job.result.slug}`, job.result.editToken); } catch { /* Optional persistence. */ }
          }
          setData({ scope, jobs, error: "", loaded: true, now: Date.now() });
        }
      } catch {
        if (alive) setData(previous => ({ scope, jobs: previous?.scope === scope ? previous.jobs : [], loaded: true, now: Date.now(), error: "Could not refresh package processing. Your tasks continue in the background." }));
      } finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 3000);
    window.addEventListener("package-job-submitted", load);
    return () => { alive = false; controller.abort(); clearInterval(timer); window.removeEventListener("package-job-submitted", load); };
  }, [scope]);
  const jobs = data?.scope === scope ? data.jobs : EMPTY;
  const receipts = read?.key === storageKey ? read.values : NO_RECEIPTS;
  const markRead = useCallback((visible: PackageJobStatus[]) => {
    if (!scope) return;
    let previous = receipts;
    try { previous = { ...previous, ...readJobReceipts(localStorage.getItem(storageKey)) }; } catch { /* Use in-memory receipts. */ }
    const next = acknowledgeJobs(visible, previous);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    setRead({ key: storageKey, values: next });
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event("package-jobs-read"));
    } catch { /* In-memory acknowledgement still works. */ }
  }, [scope, storageKey, receipts]);
  const retry = async (job: PackageJobStatus) => {
    if (!scope || pending.includes(job.versionId)) return;
    setPending(values => [...values, job.versionId]);
    try {
      const response = await appFetch(`/api/uploads/${encodeURIComponent(job.versionId)}/retry`, { method: "POST" });
      if (!response.ok) throw new Error();
      const updated = await response.json();
      setData(previous => previous?.scope === scope ? { ...previous, error: "", jobs: previous.jobs.map(j => j.versionId === job.versionId ? updated : j) } : previous);
      window.dispatchEvent(new Event("package-job-submitted"));
    } catch { setData(previous => previous?.scope === scope ? { ...previous, error: "Could not retry package processing. Try again." } : previous); }
    finally { setPending(values => values.filter(id => id !== job.versionId)); }
  };
  return { now: data?.scope === scope ? data.now : 0, jobs, receipts, markRead, retry, pending, scope, loaded: data?.scope === scope && data.loaded, error: data?.scope === scope ? data.error : "" };
}
export type PackageJobsModel = ReturnType<typeof usePackageJobs>;
