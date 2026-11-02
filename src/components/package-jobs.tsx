"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileArchive, ArrowRight } from "lucide-react";
import { useT } from "@/components/locale-provider";
import type { PackageJobStatus } from "@/lib/package-job-contract";
import { packageStages } from "@/lib/package-job-client";
import { jobNotice, unreadJob } from "@/lib/package-job-notices";
import { usePackageJobs, type PackageJobsModel } from "./use-package-jobs";

export function JobDot({ status }: { status: "failed" | "running" | "completed" }) {
  return <span className={`job-dot job-dot-${status}`} aria-hidden="true" />;
}
export function PackageTaskBadge({ model }: { model: PackageJobsModel }) {
  const t = useT(); const notice = jobNotice(model.jobs, model.receipts);
  if (!notice) return null;
  const label = notice === "failed" ? t("Unread failed uploads") : notice === "running" ? t("Uploads in progress") : t("Unread completed uploads");
  return <span className="job-badge" role="img" aria-label={label} title={label}><JobDot status={notice} /></span>;
}
function JobActions({ job, model }: { job: PackageJobStatus; model: PackageJobsModel }) {
  const t = useT();
  if (job.status === "completed" && typeof job.result?.slug === "string") return <Link className="quiet job-link" href={`/s/${encodeURIComponent(job.result.slug)}`}>{t("View artifact")}<ArrowRight size={14} aria-hidden="true" /></Link>;
  if (job.status !== "failed") return null;
  return job.retryable && job.expiresAt > model.now
    ? <button className="btn sm" disabled={model.pending.includes(job.versionId)} onClick={() => void model.retry(job)}>{t(model.pending.includes(job.versionId) ? "Retrying…" : "Retry")}</button>
    : <Link className="quiet" href="/">{t("Upload again")}</Link>;
}
function JobRow({ job, model }: { job: PackageJobStatus; model: PackageJobsModel }) {
  const t = useT(); const element = useRef<HTMLLIElement>(null);
  const unseen = unreadJob(job, model.receipts);
  const { markRead } = model;
  useEffect(() => {
    if (!unseen || !element.current) return;
    let visible = false;
    const acknowledge = () => { if (visible && document.visibilityState === "visible") markRead([job]); };
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5); acknowledge(); }, { threshold: 0.5 });
    observer.observe(element.current); document.addEventListener("visibilitychange", acknowledge);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", acknowledge); };
  }, [job, unseen, markRead]);
  const status = job.status === "queued" || job.status === "processing" ? "running" : job.status;
  return <li ref={element} className="package-task-row" data-job-id={job.versionId}>
    <div className="package-task-name"><FileArchive size={20} aria-hidden="true" /><strong>{job.title}</strong></div>
    <div className="package-task-state"><span><JobDot status={status} />{t(packageStages[job.stage] || (job.status === "processing" ? "Processing upload" : "Waiting to process"))}</span>
      {status === "running" && job.totalFiles !== null && <small>{t("{done} / {total} files", { done: job.processedFiles, total: job.totalFiles })}</small>}
      {job.status === "failed" && <small>{t(job.expiresAt <= model.now ? "Recovery expired. Upload the file again." : job.retryable ? "You can retry without uploading again." : "Check the details, then upload again.")}</small>}
    </div>
    <div className="package-task-actions"><JobActions job={job} model={model} /></div>
    <details className="package-task-details"><summary>{t("Details")}</summary><div>
      {job.status === "failed" && <p>{t(job.error || "Package processing failed")}</p>}
      {job.targetSlug && job.status !== "completed" && <p>{t("The existing version remains available.")}</p>}
      <p>{t("Upload ID")}: <code>{job.versionId}</code></p>
      {job.status !== "completed" && <p>{t("Available for recovery until")}: {new Date(job.expiresAt).toLocaleString()}</p>}
    </div></details>
  </li>;
}
export default function PackageJobs({ model }: { model: PackageJobsModel }) {
  const t = useT(); const [filter, setFilter] = useState("all");
  const jobs = model.jobs.filter(job => filter === "all" || (filter === "running" ? ["queued", "processing"].includes(job.status) : job.status === filter));
  return <section className="package-tasks" aria-label={t("Upload tasks")}>
    <div className="package-tasks-toolbar"><div className="package-task-filters" role="group" aria-label={t("Filter upload tasks")}>
      {[["all", "All"], ["running", "Processing uploads"], ["failed", "Failed"], ["completed", "Completed"]].map(([value, label]) => <button key={value} className="quiet" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</button>)}
    </div><small>{t("You can leave this page. Processing continues in the background.")}</small></div>
    {model.error && <p role="alert" className="package-task-error">{t(model.error)}</p>}
    {!model.loaded ? <p role="status">{t("Loading…")}</p> : !jobs.length ? !model.error && <p className="page-note">{t(model.jobs.length ? "No uploads match this filter." : "No recent upload tasks.")}</p> : <ul className="package-task-list">{jobs.map(job => <JobRow key={job.versionId} job={job} model={model} />)}</ul>}
  </section>;
}
export function PackageUploadHint({ versionId }: { versionId: string }) {
  const t = useT(); const model = usePackageJobs();
  const job = model.jobs.find(item => item.versionId === versionId);
  if (!job) return model.error ? <p className="package-upload-hint" role="status">{t(model.error)} <Link href="/me?tab=uploads">{t("View tasks")}<ArrowRight size={14} aria-hidden="true" /></Link></p> : null;
  const status = job.status === "queued" || job.status === "processing" ? "running" : job.status;
  return <div className="package-upload-hint">
    <span className="package-upload-message" role="status"><JobDot status={status} /><span className="package-upload-title" title={job.title}>{job.title}</span><span>{t(packageStages[job.stage] || (job.status === "processing" ? "Processing upload" : "Waiting to process"))}</span></span>
    <JobActions job={job} model={model} />
    <Link className="job-link" href="/me?tab=uploads">{t("View tasks")}<ArrowRight size={14} aria-hidden="true" /></Link>
    {model.error && <span role="alert">{t(model.error)}</span>}
  </div>;
}
