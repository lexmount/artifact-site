"use client";
import { track, analyticsRequest } from "@/lib/analytics";

// The product's front door: a large drag-and-drop zone that accepts a single .html, a whole
// folder (drag or webkitdirectory pick), a .zip, or pasted HTML — then POSTs multipart to
// /api/sites and redirects to the new /s/<slug>. No forms, no build step, no config.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { chooseUploadRoute, INLINE_UPLOAD_MAX_BYTES } from "@/lib/upload-route";
import { UploadCloud, FileCode2, FolderUp, FileArchive, ClipboardPaste, Loader2, ArrowUp, ChevronDown } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { useUploadConfirmation } from "@/components/upload-confirmation";
import MoreMenu from "@/components/more-menu";

type Picked = { path: string; file: File };


/** Zips cannot take the chunked route (the server has to unpack one to know what is inside), so a
 *  large zip can only be called out up front rather than sent off to wait for a 413 — an error that
 *  would then need explaining all over again. */
/** Recursively read a dropped directory entry into files carrying their relative paths. */
function readEntry(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((file) => {
        out.push({ path: entry.fullPath.replace(/^\//, ""), file });
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            await Promise.all(entries.map((e) => readEntry(e, out)));
            resolve();
          } else {
            entries.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

async function collectFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.some(Boolean)) {
    const out: Picked[] = [];
    await Promise.all(entries.map((e) => (e ? readEntry(e, out) : Promise.resolve())));
    if (out.length) return out;
  }
  // Fallback: plain file list with no directory structure.
  return Array.from(dt.files).map((file) => ({ path: file.name, file }));
}

export default function Uploader({ compact = false }: { compact?: boolean } = {}) {
  const t = useT();
  const router = useRouter();
  const { confirmUpload, uploadConfirmation } = useUploadConfirmation();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Chunked-upload progress (bytes). The old path has no readable progress, so this is only set on the chunked route. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [pasteHtml, setPasteHtml] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [dropTitle, setDropTitle] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [pageDrag, setPageDrag] = useState(false);

  // Compact mode: the whole window is the drop target. A drag entering the document raises the
  // overlay; leaving it (or dropping) lowers it. Counted, because dragenter/leave fire per element.
  useEffect(() => {
    if (!compact) return;
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
  }, [compact]);

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
  async function submitChunked(files: Picked[], title: string) {
    const official = await confirmUpload();
    if (official === null) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: files.reduce((sum, f) => sum + f.file.size, 0) });
    try {
      const opened = await analyticsRequest("publish", () => fetch("/api/uploads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title || undefined, official }),
      }));
      const session = await opened.json().catch(() => ({}));
      if (!opened.ok || !session.versionId) throw new Error(session?.error || t("Could not start the upload"));

      let done = 0;
      for (const picked of files) {
        const path = picked.path.split("/").map(encodeURIComponent).join("/");
        const res = await analyticsRequest("publish", () => fetch(`/api/uploads/${session.versionId}/files/${path}`, {
          method: "PUT",
          // Use the File directly as the request body: the browser streams it instead of assembling a full copy in memory first.
          body: picked.file,
          headers: { "content-length": String(picked.file.size) },
        }));
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || t("{path} failed to upload", { path: picked.path }));
        }
        done += picked.file.size;
        setProgress({ done, total: files.reduce((sum, f) => sum + f.file.size, 0) });
      }

      const committed = await analyticsRequest("publish", () => fetch(`/api/uploads/${session.versionId}/commit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title || undefined, official }),
      }));
      const data = await committed.json().catch(() => ({}));
      if (!committed.ok || !data.slug) throw new Error(data?.error || t("Failed to commit the upload"));
      if (data.editToken) { try { localStorage.setItem(`sites:editToken:${data.slug}`, data.editToken); } catch { /* ignore */ } }
      track("artifact_publish_success", { upload_method: "chunked" });
      router.push(`/s/${data.slug}?published=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Upload failed"));
      setBusy(false);
      setProgress(null);
    }
  }

  async function submit(body: FormData) {
    const official = await confirmUpload();
    if (official === null) return;
    body.set("official", String(official));
    setBusy(true);
    setError(null);
    try {
      const res = await analyticsRequest("publish", () => fetch("/api/sites", { method: "POST", body }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Publish failed ({status})", { status: res.status }));
      const slug: string | undefined = data.slug ?? data?.site?.slug;
      if (!slug) throw new Error(t("Published, but no site identifier came back"));
      // Owner token: remember it so this browser can edit/delete/rename/rollback this site later.
      if (data.editToken) { try { localStorage.setItem(`sites:editToken:${slug}`, data.editToken); } catch { /* ignore */ } }
      track("artifact_publish_success", { upload_method: "inline" });
      router.push(`/s/${slug}?published=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Publish failed"));
      setBusy(false);
    }
  }

  // The optional display title typed in the dropzone; applied to whatever gets published.
  function applyTitle(fd: FormData) {
    if (dropTitle.trim()) fd.set("title", dropTitle.trim());
    return fd;
  }

  function submitPicked(picked: Picked[]) {
    if (picked.length === 0) return;
    const route = chooseUploadRoute(picked.map((p) => ({ path: p.path, size: p.file.size })), INLINE_UPLOAD_MAX_BYTES, t);
    if (route.kind === "error") { setError(route.message); return; }
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
    submitPicked(picked);
  }

  function submitPaste() {
    if (!pasteHtml.trim()) { setError(t("Paste some HTML first")); return; }
    const fd = new FormData();
    fd.set("mode", "paste");
    fd.set("html", pasteHtml);
    if (pasteTitle.trim()) fd.set("title", pasteTitle.trim());
    void submit(fd);
  }

  const inputs = (
    <>
      {uploadConfirmation}
      <input ref={fileInput} type="file" accept=".html,.htm,.pdf,.pptx,.ppt,.docx,.doc,.zip,application/zip" hidden onChange={(e) => onPickFiles(e.target.files, "file")} />
      {/* @ts-expect-error webkitdirectory is a valid non-standard attribute */}
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => onPickFiles(e.target.files, "folder")} />
      <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => onPickFiles(e.target.files, "zip")} />
    </>
  );

  if (compact) {
    return (
      <div className="hero-upload">
        {/* The zone itself takes a drop (the page-wide overlay below takes the rest of the page);
            the button sits at its right edge, so "drag it here, or click" reads left to right. */}
        <div
          className={`hero-drop${drag ? " is-drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
        >
          <div className="hero-drop-text">
            <UploadCloud size={26} strokeWidth={1.6} aria-hidden="true" />
            <div>
              <b>{t("Drop a file or folder here")}</b>
              <span>{t("HTML · PDF · PPTX · DOCX · folder · ZIP")}</span>
            </div>
          </div>
          <span className="upload-split">
            <button data-analytics-button="upload" type="button" className="primary" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />} {busy ? t("Publishing…") : t("Upload")}
            </button>
            <MoreMenu label={t("More upload options")} iconOnly buttonClassName="primary upload-more" buttonContent={<ChevronDown size={14} aria-hidden="true" />} disabled={busy}>
              <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => fileInput.current?.click()}><FileCode2 size={14} /> {t("A file (HTML, PDF, Office, zip)")}</button>
              <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => folderInput.current?.click()}><FolderUp size={14} /> {t("A folder (a build's dist/)")}</button>
              <button data-analytics-button="upload" type="button" role="menuitem" className="menu-item" onClick={() => zipInput.current?.click()}><FileArchive size={14} /> {t("A .zip archive")}</button>
            </MoreMenu>
          </span>
        </div>
        <div className="formats">{t("No build, no configuration — upload and share.")}</div>
        {progress && progress.total > 0 && (
          <div className="upload-progress" role="status" aria-live="polite">
            <div className="upload-progress-bar"><span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>
            <p>{t("Uploaded {done} / {total} MB", { done: (progress.done / 1048576).toFixed(1), total: (progress.total / 1048576).toFixed(1) })}</p>
          </div>
        )}
        {error && <p className="upload-error" role="alert">{error}</p>}
        {inputs}
        {pageDrag && (
          <div
            className={`page-drop${drag ? " is-drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
            onDrop={onDrop}
          >
            <div className="page-drop-inner"><UploadCloud size={28} aria-hidden="true" /><b>{t("Drop to publish")}</b><span>{t("HTML · PDF · PPTX · DOCX · folder · ZIP")}</span></div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {uploadConfirmation}
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
          <h2>{busy ? t("Publishing…") : t("Drop HTML / PDF / Office / a folder / .zip, or paste code")}</h2>
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
                {progress.done < progress.total ? t(", large files take a few minutes — please keep this page open") : t(", committing…")}
              </p>
            </div>
          )}
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
              <FileArchive size={15} /> {t("Choose a .zip")}
            </button>
            <button data-analytics-button="upload" type="button" className="btn ghost" onClick={() => { setPaste(true); setError(null); }} disabled={busy}>
              <ClipboardPaste size={15} /> {t("Paste HTML")}
            </button>
          </div>
          <span className="dropzone-hint">{t("HTML · PDF · PPTX · DOCX · folder · ZIP · paste")}</span>
          <input ref={fileInput} type="file" accept=".html,.htm,.pdf,.pptx,.ppt,.docx,.doc" hidden onChange={(e) => onPickFiles(e.target.files, "file")} />
          {/* @ts-expect-error webkitdirectory is a valid non-standard attribute */}
          <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => onPickFiles(e.target.files, "folder")} />
          <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => onPickFiles(e.target.files, "zip")} />
        </div>
      ) : (
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
            <button type="button" className="btn ghost" onClick={() => { setPaste(false); setError(null); }} disabled={busy}>{t("Back to drop zone")}</button>
            <button data-analytics-button="upload" type="button" className="btn solid" onClick={submitPaste} disabled={busy}>
              {busy ? <><Loader2 size={15} className="spin" /> {t("Publishing")}</> : t("Publish and get a link")}
            </button>
          </div>
        </div>
      )}
      {error && <p className="upload-error" role="alert">{error}</p>}
    </div>
  );
}
