"use client";
import ConfirmDialog from "@/components/confirm-dialog";
import { useUploadLeaveGuard } from "@/components/upload-leave-guard";
import { archiveFingerprint, uploadArchiveChunks } from "@/lib/archive-chunk-client";
import { PackageUploadHint } from "@/components/package-jobs";
import { isPackageJob } from "@/lib/package-job-client";
import { uploadFailureMessage, normalizePickedFolder, packageForFiles, checkArchiveSize, packageUploadLimit, type PackagePickedFiles } from "@/lib/package-upload-client";
import type { PackageOptions } from "@/lib/package-contract";

import { appFetch } from "@/lib/app-path";
import { track, analyticsRequest } from "@/lib/analytics";

// The product's front door: a large drag-and-drop zone that accepts a single .html, a whole
// folder (drag or webkitdirectory pick), a .zip, or pasted HTML — then POSTs multipart to
// /api/sites and redirects to the new /s/<slug>. No forms, no build step, no config.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { chooseUploadRoute, INLINE_UPLOAD_MAX_BYTES } from "@/lib/upload-route";
import { UploadCloud, FileCode2, FolderUp, FileArchive, ClipboardPaste, Loader2, ArrowUp, ChevronDown } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { useUploadConfirmation } from "@/components/upload-confirmation";
import MoreMenu from "@/components/more-menu";
import QuotaNotice from "@/components/quota-notice";
import { ClientQuotaExceeded, quotaDetailsFrom, type QuotaDetails } from "@/lib/quota-client";

import { collectFromDrop, type Picked } from "@/lib/upload-pick";

export default function Uploader({ compact = false, inline = false, footerAction }: { compact?: boolean; inline?: boolean; footerAction?: ReactNode } = {}) {
  const t = useT();
  const router = useRouter();
  const { confirmUpload, uploadConfirmation } = useUploadConfirmation();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resumable, setResumable] = useState(false);
  const leave = useUploadLeaveGuard(busy, resumable);
  const [recoverJob, setRecoverJob] = useState<((recover: boolean | null) => void) | null>(null);
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  /** Chunked-upload progress (bytes). The old path has no readable progress, so this is only set on the chunked route. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaDetails | null>(null);
  const [paste, setPaste] = useState(false);
  const [pasteHtml, setPasteHtml] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [dropTitle, setDropTitle] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [pageDrag, setPageDrag] = useState(false);

  function fail(data: unknown, fallback: string): never {
    const details = quotaDetailsFrom(data);
    if (details) {
      setQuota(details);
      setError(null);
      throw new ClientQuotaExceeded(details);
    }
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : fallback;
    throw new Error(message);
  }

  function showFailure(error: unknown, fallback: string) {
    if (error instanceof ClientQuotaExceeded) return;
    setError(uploadFailureMessage(error, fallback, t));
  }

  // Compact and inline modes: the whole window is the drop target. A drag entering the document raises the
  // overlay; leaving it (or dropping) lowers it. Counted, because dragenter/leave fire per element.
  useEffect(() => {
    if (!compact && !inline) return;
    let depth = 0;
    const enter = (e: DragEvent) => { if (!e.dataTransfer?.types.includes("Files")) return; depth++; setPageDrag(true); };
    const leave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setPageDrag(false); };
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    // Accept the drop at the document level too: `dragover` above already accepts file drags
    // everywhere, so a drop that lands before the overlay has mounted (or on any element without a
    // React onDrop) must not make the browser navigate to the file.
    const drop = (e: DragEvent) => { e.preventDefault(); depth = 0; setPageDrag(false); };
    document.addEventListener("dragenter", enter); document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over); document.addEventListener("drop", drop);
    return () => { document.removeEventListener("dragenter", enter); document.removeEventListener("dragleave", leave); document.removeEventListener("dragover", over); document.removeEventListener("drop", drop); };
  }, [compact, inline]);

  /**
   * Large projects take the chunked route: stream one file at a time, then commit at the end.
   *
   * Why not everything on the old path: a one-shot upload stuffs the whole project into a single
   * multipart body, and the server has to READ ALL OF IT INTO MEMORY before it can get at the
   * content. Projects with video easily run to two or three hundred MB, and that has been measured
   * to crash the production process (everyone gets 503 while it restarts). Chunked, the server
   * handles one file at a time, and each request is the size of that file, which naturally fits
   * under the gateway's per-request limit.
   *
   * Small projects still take the old path: it saves a round trip, and that path is where zip
   * extraction and Office conversion live — things the server can only do with the complete content.
   */
  async function submitChunked(files: Picked[], title: string, packageOptions?: PackageOptions) {
    const official = await confirmUpload();
    if (official === null) return;
    setSubmittedJob(null);
    setResumable(false); setBusy(true);
    setError(null);
    setQuota(null);
    setProgress({ done: 0, total: files.reduce((sum, f) => sum + f.file.size, 0) });
    try {
      if (packageOptions) {
        const cap = await packageUploadLimit(appFetch, t);
        if (!checkArchiveSize(files, packageOptions, cap)) throw new Error(t("Archive exceeds the server upload limit."));
      }
      let recoveryKey: string | undefined;
      let recovered: string | null = null;
      let useChunks = false;
      if (packageOptions?.source === "archive") {
        const me = await (await appFetch("/api/auth/me")).json();
        useChunks = me.uploadLimits?.archiveChunks === 1;
        setResumable(useChunks);
        if (useChunks) {
          recoveryKey = `archive-upload:${process.env.NEXT_PUBLIC_ARTIFACT_BASE_PATH || ""}:${me.user?.id || "anonymous"}:${await archiveFingerprint(files[0].file)}:${JSON.stringify([title, official, packageOptions.name])}`;
          try { recovered = localStorage.getItem(recoveryKey); } catch { /* Storage is optional. */ }
          if (recovered) {
            const response = await appFetch(`/api/uploads/${recovered}`);
            if (response.status === 404) recovered = null;
            else if (!response.ok) throw new Error(t("Could not start the upload"));
            else if (isPackageJob(await response.json())) {
              const recover = globalThis.crypto?.subtle || await new Promise<boolean | null>(resolve => setRecoverJob(() => resolve));
              if (recover === null) { setBusy(false); setProgress(null); return; }
              try { localStorage.removeItem(recoveryKey); } catch { /* Storage is optional. */ }
              if (recover) { leave.release(); setSubmittedJob(recovered); setBusy(false); setProgress(null); return; }
              recovered = null;
            }
          }
        }
      }
      const opened = recovered ? Response.json({ versionId: recovered }) : await analyticsRequest("publish", () => appFetch("/api/uploads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title || packageOptions?.name || undefined, official, package: packageOptions }),
      }));
      const session = await opened.json().catch(() => ({}));
      if (!opened.ok || !session.versionId) fail(session, t("Could not start the upload"));

      if (recoveryKey) { try { localStorage.setItem(recoveryKey, session.versionId); } catch { /* Storage is optional. */ } }
      let done = 0;
      for (const picked of files) {
        if (useChunks) {
          await uploadArchiveChunks(appFetch, session.versionId, picked.file, {}, bytes => setProgress({ done: bytes, total: picked.file.size }), t);
          continue;
        }
        const path = packageOptions?.source === "archive" ? "original" : picked.path.split("/").map(encodeURIComponent).join("/");
        const res = await analyticsRequest("publish", () => appFetch(`/api/uploads/${session.versionId}/files/${path}`, {
          method: "PUT",
          // Use the File directly as the request body: the browser streams it instead of assembling a full copy in memory first.
          body: picked.file,
          headers: { "content-length": String(picked.file.size) },
        }));
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          fail(err, t("{path} failed to upload", { path: picked.path }));
        }
        done += picked.file.size;
        setProgress({ done, total: files.reduce((sum, f) => sum + f.file.size, 0) });
      }

      const committed = await analyticsRequest("publish", () => appFetch(`/api/uploads/${session.versionId}/commit${packageOptions ? "?async=1" : ""}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title || undefined, official }),
      }));
      const data = await committed.json().catch(() => ({}));
      if (committed.ok && isPackageJob(data)) {
        if (recoveryKey) { try { localStorage.removeItem(recoveryKey); } catch { /* Storage is optional. */ } }
        leave.release();
        setSubmittedJob(data.versionId);
        window.dispatchEvent(new Event("package-job-submitted"));
        setBusy(false); setProgress(null); return;
      }
      if (!committed.ok || !data.slug) fail(data, t("Failed to commit the upload"));
      if (data.editToken) { try { localStorage.setItem(`sites:editToken:${data.slug}`, data.editToken); } catch { /* ignore */ } }
      track("artifact_publish_success", { upload_method: "chunked" });
      leave.release();
      router.refresh();
      router.push(`/s/${data.slug}?published=1`);
    } catch (e) {
      showFailure(e, t("Upload failed"));
      setBusy(false);
      setProgress(null);
    }
  }

  async function submit(body: FormData) {
    const official = await confirmUpload();
    if (official === null) return;
    body.set("official", String(official));
    setSubmittedJob(null);
    setResumable(false); setBusy(true);
    setError(null);
    setQuota(null);
    try {
      const res = await analyticsRequest("publish", () => appFetch("/api/sites", { method: "POST", body }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) fail(data, t("Publish failed ({status})", { status: res.status }));
      const slug: string | undefined = data.slug ?? data?.site?.slug;
      if (!slug) throw new Error(t("Published, but no site identifier came back"));
      // Owner token: remember it so this browser can edit/delete/rename/rollback this site later.
      if (data.editToken) { try { localStorage.setItem(`sites:editToken:${slug}`, data.editToken); } catch { /* ignore */ } }
      track("artifact_publish_success", { upload_method: "inline" });
      leave.release();
      router.refresh();
      router.push(`/s/${slug}?published=1`);
    } catch (e) {
      showFailure(e, t("Publish failed"));
      setBusy(false);
    }
  }

  // The optional display title typed in the dropzone; applied to whatever gets published.
  function applyTitle(fd: FormData) {
    if (dropTitle.trim()) fd.set("title", dropTitle.trim());
    return fd;
  }

  function submitPicked(picked: PackagePickedFiles) {
    picked = normalizePickedFolder(picked);
    if (picked.length === 0 && !picked.directories?.length) return;
    const packageOptions = packageForFiles(picked);
    if (packageOptions) {
      void submitChunked(picked, dropTitle.trim(), packageOptions); return;
    }
    const route = chooseUploadRoute(picked.map((p) => ({ path: p.path, size: p.file.size })), INLINE_UPLOAD_MAX_BYTES, t);
    if (route.kind === "error") { setQuota(null); setError(route.message); return; }
    // A single large HTML / PDF, and folders over the total limit, take the chunked route (streamed; the whole thing is never read into server memory).
    if (route.kind === "chunked") { void submitChunked(picked, (dropTitle || "").trim()); return; }

    const fd = new FormData();
    if (route.kind === "file") {
      fd.set("mode", "file");
      fd.set("file", picked[0].file, picked[0].file.name);
    } else if (route.kind === "zip") {
      fd.set("mode", "zip");
      fd.set("file", picked[0].file, picked[0].file.name);
    } else {
      fd.set("mode", "folder");
      // Server reads relpath from each File's name AND from a positional `paths` field —
      // send both so nested paths (assets/app.css) survive.
      for (const p of picked) {
        fd.append("files", p.file, p.path);
        fd.append("paths", p.path);
      }
    }
    void submit(applyTitle(fd));
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (busy) return;
    const picked = await collectFromDrop(e.dataTransfer);
    submitPicked(picked);
  }

  function onPickFiles(list: FileList | null, kind: "file" | "folder" | "zip") {
    if (!list || list.length === 0) return;
    // All three entry points (pick files / pick a folder / pick a zip) defer to submitPicked →
    // chooseUploadRoute, so "a single large PDF/HTML goes chunked automatically" also applies to the
    // file picker instead of only drag-and-drop / folder picks.
    void kind;
    const picked: Picked[] = Array.from(list).map((file) => ({
      // webkitdirectory picks carry a relative path; single-file picks use the bare name.
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      file,
    }));
    for (const input of [fileInput, folderInput, zipInput]) if (input.current) input.current.value = "";
    submitPicked(Object.assign(picked, { folder: kind === "folder" }));
  }

  function submitPaste() {
    if (!pasteHtml.trim()) { setError(t("Paste some HTML first")); return; }
    const fd = new FormData();
    fd.set("mode", "paste");
    fd.set("html", pasteHtml);
    if (pasteTitle.trim()) fd.set("title", pasteTitle.trim());
    void submit(fd);
  }

  const dialogs = <>
      {leave.dialog}
      {recoverJob && <ConfirmDialog title={t("Previous upload found")}
        body={t("This browser cannot verify whether the selected file matches the previous submitted upload. View that task, or upload the selected file as a new task.")}
        confirmLabel={t("View previous task")} cancelLabel={t("Upload selected file")}
        onDismiss={() => { recoverJob(null); setRecoverJob(null); }}
        onConfirm={async () => { recoverJob(true); }} onClose={() => { recoverJob(false); setRecoverJob(null); }} />}
      {uploadConfirmation}
  </>;

  const inputs = (
    <>
      {dialogs}
      <input ref={fileInput} type="file" accept=".html,.htm,.pdf,.pptx,.ppt,.docx,.doc,.zip,.rar,.7z,.tar,.tar.gz,.tgz,application/zip" hidden onChange={(e) => onPickFiles(e.target.files, "file")} />
      {/* @ts-expect-error webkitdirectory is a valid non-standard attribute */}
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => onPickFiles(e.target.files, "folder")} />
      <input ref={zipInput} type="file" accept=".zip,.rar,.7z,.tar,.tar.gz,.tgz" hidden onChange={(e) => onPickFiles(e.target.files, "zip")} />
    </>
  );

  const pastePanel = (
    <div className="paste-panel">
      <div className="field">
        <label htmlFor="paste-title">{t("Title (optional)")}</label>
        <input id="paste-title" value={pasteTitle} placeholder={t("My site")} onChange={(e) => setPasteTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="paste-html">HTML</label>
        <textarea id="paste-html" value={pasteHtml} placeholder="<!doctype html> …" onChange={(e) => setPasteHtml(e.target.value)} spellCheck={false} />
      </div>
      <div className="row">
        <button type="button" className="btn ghost" onClick={() => { setPaste(false); setError(null); setQuota(null); }} disabled={busy}>{t(inline ? "Cancel" : "Back to drop zone")}</button>
        <button data-analytics-button="upload" type="button" className="btn solid" onClick={submitPaste} disabled={busy}>
          {busy ? <><Loader2 size={15} className="spin" /> {t("Publishing")}</> : t("Publish and get a link")}
        </button>
      </div>
    </div>
  );

  const uploadOptions = <>
    <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => fileInput.current?.click()}><FileCode2 size={14} /> {t("A file (HTML, PDF, Office, zip)")}</button>
    <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => folderInput.current?.click()}><FolderUp size={14} /> {t("A folder")}</button>
    <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => zipInput.current?.click()}><FileArchive size={14} /> {t("An archive (ZIP, RAR, 7z, TAR, TAR.GZ, TGZ)")}</button>
    <button type="button" role="menuitem" className="menu-item" onClick={() => { setPaste(true); setError(null); setQuota(null); }}><ClipboardPaste size={14} /> {t("Paste HTML")}</button>
  </>;
  const feedback = <>
    {progress && progress.total > 0 && (
      <div className="upload-progress" role="status" aria-live="polite">
        <div className="upload-progress-bar"><span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>
        <p>{t("Uploaded {done} / {total} MB", { done: (progress.done / 1048576).toFixed(1), total: (progress.total / 1048576).toFixed(1) })}</p>
      </div>
    )}
    {leave.hint}
    {error && <p className="upload-error" role="alert">{error}</p>}
    {quota && <QuotaNotice details={quota} />}
  </>;
  const dropOverlay = <>
    {pageDrag && (
      <div
        className={`page-drop${drag ? " is-drag" : ""}`}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
        onDrop={onDrop}
      >
        <div className="page-drop-inner"><UploadCloud size={28} aria-hidden="true" /><b>{t("Drop to publish")}</b><span>{t("HTML · PDF · PPTX · DOCX · folder · ZIP / RAR / 7z / TAR / TAR.GZ / TGZ")}</span></div>
      </div>
    )}
  </>;

  if (inline) {
    return <div className="hero-upload inline-upload">
      <span className="inline-upload-actions">
        <button data-analytics-button="upload" type="button" className="home-upload-trigger" onClick={() => fileInput.current?.click()} disabled={busy}>
          {t("Or")} <span className="home-upload-label">{t("upload an artifact")}</span>
        </button>
        <MoreMenu label={t("More upload options")} iconOnly buttonClassName="home-upload-more" buttonContent={<ChevronDown size={14} aria-hidden="true" />} disabled={busy}>
          {uploadOptions}
          {footerAction}
        </MoreMenu>
      </span>
      {(paste || busy || submittedJob || error || quota) && <div className="inline-upload-feedback">
        {paste && pastePanel}
        {busy && <p className="inline-upload-status" role="status"><Loader2 size={15} className="spin" aria-hidden="true" />{t("Publishing…")}</p>}
        {submittedJob && <PackageUploadHint versionId={submittedJob} />}
        {feedback}
      </div>}
      {inputs}
      {dropOverlay}
    </div>;
  }

  if (compact) {
    return (
      <div className="hero-upload">
        {/* The zone itself takes a drop (the page-wide overlay below takes the rest of the page);
            the button sits at its right edge, so "drag it here, or click" reads left to right. */}
        {paste ? pastePanel : <div
          className={`hero-drop${drag ? " is-drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
        >
          <div className="hero-drop-text">
            <UploadCloud size={26} strokeWidth={1.6} aria-hidden="true" />
            <div>
              <b>{t("Drop a file or folder here")}</b>
              <span>{t("HTML · PDF · PPTX · DOCX · folder · ZIP / RAR / 7z / TAR / TAR.GZ / TGZ")}</span>
            </div>
          </div>
          <span className="upload-split">
            <button data-analytics-button="upload" type="button" className="primary" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />} {busy ? t("Publishing…") : t("Upload")}
            </button>
            <MoreMenu label={t("More upload options")} iconOnly buttonClassName="primary upload-more" buttonContent={<ChevronDown size={14} aria-hidden="true" />} disabled={busy}>
              {uploadOptions}
            </MoreMenu>
          </span>
        </div>}
        {submittedJob && <PackageUploadHint versionId={submittedJob} />}
        <div className="hero-upload-footer">
          <div className="formats">{t("No build, no configuration — upload and share.")}</div>
          {footerAction}
        </div>
        {feedback}
        {inputs}
        {dropOverlay}
      </div>
    );
  }

  return (
    <div>
      {dialogs}
      {!paste ? (
        <div
          className={`dropzone${drag ? " is-drag" : ""}${busy ? " busy" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          aria-label={t("Drop files to publish")}
          onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) fileInput.current?.click(); }}
        >
          <span className="dropzone-glyph" aria-hidden="true">
            {busy ? <Loader2 size={26} className="spin" /> : <UploadCloud size={26} />}
          </span>
          <h2>{busy ? t("Publishing…") : t("Drop HTML / PDF / Office / a folder / ZIP / RAR / 7z / TAR / TAR.GZ / TGZ, or paste code")}</h2>
          {/* Large projects take minutes to upload. Waiting without progress, a person cannot tell
              "still uploading" from "frozen" — and that is exactly when they refresh the page and
              kill the upload. */}
          {progress && progress.total > 0 && (
            <div className="upload-progress" role="status" aria-live="polite">
              <div className="upload-progress-bar">
                <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
              </div>
              <p>
                {t("Uploaded {done} / {total} MB", { done: (progress.done / 1048576).toFixed(1), total: (progress.total / 1048576).toFixed(1) })}
                {progress.done < progress.total ? t(", large files take a few minutes — please keep this page open") : t(", preparing the directory and publishing…")}
              </p>
            </div>
          )}
          {leave.hint}
          <p>{t("Drop it here to publish. Sites and documents are served as they are — no build, no configuration, just a shareable link.")}</p>
          <input
            className="dropzone-title"
            value={dropTitle}
            placeholder={t("Site title (optional)")}
            aria-label={t("Site title (optional)")}
            disabled={busy}
            onChange={(e) => setDropTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="dropzone-actions">
            <button data-analytics-button="upload" type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
              <FileCode2 size={15} /> {t("Choose a file")}
            </button>
            <button data-analytics-button="upload" type="button" className="btn" onClick={() => folderInput.current?.click()} disabled={busy}>
              <FolderUp size={15} /> {t("Choose a folder")}
            </button>
            <button data-analytics-button="upload" type="button" className="btn" onClick={() => zipInput.current?.click()} disabled={busy}>
              <FileArchive size={15} /> {t("Choose an archive")}
            </button>
            <button data-analytics-button="upload" type="button" className="btn ghost" onClick={() => { setPaste(true); setError(null); setQuota(null); }} disabled={busy}>
              <ClipboardPaste size={15} /> {t("Paste HTML")}
            </button>
          </div>
          <p className="dropzone-hint">{t("To preserve empty folders reliably, upload an archive.")}</p>
          <span className="dropzone-hint">{t("HTML · PDF · PPTX · DOCX · folder · ZIP / RAR / 7z / TAR / TAR.GZ / TGZ · paste")}</span>
          <input ref={fileInput} type="file" accept=".html,.htm,.pdf,.pptx,.ppt,.docx,.doc" hidden onChange={(e) => onPickFiles(e.target.files, "file")} />
          {/* @ts-expect-error webkitdirectory is a valid non-standard attribute */}
          <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => onPickFiles(e.target.files, "folder")} />
          <input ref={zipInput} type="file" accept=".zip,.rar,.7z,.tar,.tar.gz,.tgz" hidden onChange={(e) => onPickFiles(e.target.files, "zip")} />
        </div>
      ) : (
        pastePanel
      )}
      {submittedJob && !compact && <PackageUploadHint versionId={submittedJob} />}
      {error && <p className="upload-error" role="alert">{error}</p>}
      {quota && <QuotaNotice details={quota} />}
    </div>
  );
}
