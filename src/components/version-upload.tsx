"use client";
import { analyticsRequest, track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileUp, X, Loader2 } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { siteFetch, withShareContext } from "@/lib/share-context";
import { collectFromDrop } from "@/lib/upload-pick";
import { chooseUploadRoute, INLINE_UPLOAD_MAX_BYTES } from "@/lib/upload-route";
import { uploadVersion, VersionConflict, VersionUploadRejected, type VersionFile } from "@/lib/version-upload-client";
import { browserRandomId } from "@/lib/browser-random-id";
import { OFFICIAL_CHANGED } from "@/components/official-version";
import QuotaNotice from "@/components/quota-notice";
import { ClientQuotaExceeded, type QuotaDetails } from "@/lib/quota-client";
export type UploadTarget = { slug: string; title: string; kind: string; token?: string | null; canOfficial: boolean };
export default function VersionUpload({ target, onClose, onPublished }: { target: UploadTarget; onClose: () => void; onPublished: () => void }) {
  const t = useT(), dialog = useRef<HTMLDialogElement>(null), picker = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [files, setFiles] = useState<VersionFile[]>([]), [expected, setExpected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [official, setOfficial] = useState(false), [success, setSuccess] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaDetails | null>(null);
  const [progress, setProgress] = useState(0), [attempted, setAttempted] = useState(false);
  const key = useRef(browserRandomId()), session = useRef<string | undefined>(undefined), running = useRef(false);
  async function load() {
    setSnapshotLoading(true);
    try {
      const res = await siteFetch(`/api/sites/${target.slug}/versions`, { headers: target.token ? { "x-edit-token": target.token } : {} });
      const data = await res.json();
      if (!res.ok || !data.currentVersionId) throw new Error(t("Could not load the current version. Try again."));
      setError(null); setQuota(null); setExpected(data.currentVersionId); setConflict(false); key.current = browserRandomId(); session.current = undefined; setAttempted(false);
    } catch (e) { setError(e instanceof Error ? e.message : t("Failed to load")); }
    finally { setSnapshotLoading(false); }
  }
  useEffect(() => {
    const el = dialog.current!, previous = document.activeElement;
    el.showModal();
    // Fetch the server snapshot when this independently mounted dialog opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { el.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
    // The parent keys this component by the selected target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function pick(list: FileList | null) {
    if (!list || attempted) return;
    setFiles(Array.from(list).map(file => ({ path: file.webkitRelativePath || file.name, file }))); setError(null); setQuota(null);
  }
  async function submit() {
    if (running.current || !expected || !files.length || conflict) return;
    const route = chooseUploadRoute(files.map(f => ({ path: f.path, size: f.file.size })), INLINE_UPLOAD_MAX_BYTES, t);
    if (route.kind === "error") { setQuota(null); setError(route.message); return; }
    running.current = true; setBusy(true); setAttempted(true); setError(null); setQuota(null);
    try {
      const result = await uploadVersion({ ...target, expected, key: key.current, files, official, session: session.current, onSession: id => { session.current = id; }, t, progress: (done, total) => setProgress(Math.round(done / total * 100)) }, (input, init) => init?.method === "POST" ? analyticsRequest("update", () => siteFetch(input, init)) : siteFetch(input, init));
      track("artifact_update_success", { method: target.kind === "document" ? "document" : "source" });
      setPublishedVersion(result.versionId); setSuccess(true); window.dispatchEvent(new Event(OFFICIAL_CHANGED)); onPublished();
    } catch (e) {
      if (e instanceof VersionConflict) setConflict(true);
      else if (e instanceof ClientQuotaExceeded) {
        setQuota(e.details);
        key.current = browserRandomId(); session.current = undefined;
        setAttempted(false); setProgress(0);
      }
      else {
        if (e instanceof VersionUploadRejected) {
          key.current = browserRandomId(); session.current = undefined;
          setAttempted(false); setProgress(0);
        }
        setError(e instanceof Error ? e.message : t("Uploading the new version failed"));
      }
    } finally { running.current = false; setBusy(false); }
  }
  return createPortal(<dialog className="version-upload" ref={dialog} aria-labelledby="version-upload-title" onCancel={e => { e.preventDefault(); if (!running.current) onClose(); }} onClose={() => { if (dialog.current?.open) return; if (running.current) dialog.current?.showModal(); else onClose(); }}>
    <header><h2 id="version-upload-title">{t(success ? "New version published" : "Upload new version")}</h2><button className="btn" disabled={busy} onClick={onClose} aria-label={t("Close")}><X size={16} /></button></header>
    <strong>{target.title}</strong><p className="muted">{t("The link, sharing settings and previous versions are preserved.")}</p>
    {success ? <><p role="status">{t(official ? "The new version is now official." : "The official version has not changed.")}</p><a className="btn solid" href={withShareContext(`/s/${target.slug}?version=${encodeURIComponent(publishedVersion!)}`)}>{t("View new version")}</a><button className="btn" onClick={onClose}>{t("Done")}</button></> : <>
      <div className="version-file-picker" onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={async e => { e.preventDefault(); e.stopPropagation(); if (busy || attempted) return; setFiles(await collectFromDrop(e.dataTransfer)); setError(null); setQuota(null); }}><FileUp size={24} /><p>{files.length ? t("{count} files selected", { count: files.length }) : t("Choose the complete new version")}</p>
        {files.length > 0 && <small>{files.slice(0, 3).map(f => f.path).join(" · ")} · {(files.reduce((n,f) => n+f.file.size,0)/1024/1024).toFixed(1)} MB</small>}
        <div><button className="btn" disabled={busy || attempted} onClick={() => picker.current?.click()}>{t("Choose file / ZIP")}</button>{target.kind !== "document" && <button className="btn" disabled={busy || attempted} onClick={() => folder.current?.click()}>{t("Choose folder")}</button>}</div>
      </div>
      <input ref={picker} type="file" hidden accept={target.kind === "document" ? ".pdf,.pptx,.ppt,.docx,.doc" : ".html,.htm,.zip"} onChange={e => pick(e.target.files)} />
      <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={e => pick(e.target.files)} />
      <p className="version-replace-note">{t("This replaces the complete content. Old files missing from this upload will not be included.")}</p>
      {target.canOfficial && <label><input type="checkbox" checked={official} disabled={busy || attempted} onChange={e => setOfficial(e.target.checked)} /> {t("Set as official version after uploading")}</label>}
      {busy && <div role="status"><p><Loader2 size={14} className="spin" /> {t("Uploading…")} {progress > 0 ? `${progress}%` : ""}</p><progress aria-label={t("Uploading…")} max={100} value={progress || undefined} /></div>}
      {error && <p role="alert" className="drawer-error">{error}</p>}
      {quota && <QuotaNotice details={quota} />}
      {conflict && <div role="alert"><p>{t("A newer version was published while you were choosing files. Review it before continuing.")}</p><a target="_blank" rel="noreferrer" href={withShareContext(`/s/${target.slug}`)}>{t("View artifact")}</a><button className="btn" disabled={snapshotLoading} onClick={() => void load()}>{t("Use the latest version as the new starting point")}</button></div>}
      <footer><button className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>{!expected ? <button className="btn" disabled={snapshotLoading} onClick={() => void load()}>{t(snapshotLoading ? "Loading…" : "Retry")}</button> : <button className="btn solid" disabled={busy || !files.length || conflict} onClick={() => void submit()}>{t(busy ? "Uploading…" : attempted ? "Retry upload" : "Publish new version")}</button>}</footer>
    </>}
  </dialog>, document.body);
}
