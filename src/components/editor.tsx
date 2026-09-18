"use client";
import { track, analyticsRequest } from "@/lib/analytics";

import SiteDownload from "@/components/site-download";
import { siteFetch as fetch, withShareContext } from "@/lib/share-context";

// In-browser editor. The default is **visual**: you land straight in the preview and double-click text to change it,
// with no source code and no file list in sight. Source editing was not removed — folder sites still need it for
// CSS/JS, binary files, and whenever visual mapping fails — it was just tucked behind the secondary "Edit source"
// entry point and is no longer the default view.
// Every save POSTs to /api/sites/<slug>/edit and produces a new immutable version.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, ExternalLink, Loader2, FileCode2, Copy, Lock, Code2, MousePointerClick, History, Eye } from "lucide-react";
import { useEditToken, rememberEditToken } from "@/lib/edit-token";
import VisualEditor, { type VisualEditorState } from "@/components/visual-editor";
import MoreMenu from "@/components/more-menu";
import type { EditBaseInfo } from "@/lib/edit-base";
import { useT } from "@/components/locale-provider";

type EditFile = { path: string; content: string; editable: boolean };

/**
 * Which version the edit frame fetches its source from is passed through VisualEditor's optional `baseVersionId`
 * prop (when set, it fetches /edit-frame?version=<id>). This alias relaxes only that one optional property — every
 * other prop is still fully type-checked — so that "pass it down" and "declare it" can land as separate halves;
 * once both are in, it is an identity alias and can be deleted.
 */
const VisualEditorWithBase = VisualEditor as ComponentType<
  ComponentProps<typeof VisualEditor> & { baseVersionId?: string }
>;

const INDENT = "  "; // matches the textarea's tab-size: 2

/**
 * What to do with the drafts in hand when switching to visual editing.
 *
 * Visual editing works on the **saved** entry file, so unsaved source changes to the entry genuinely cannot carry
 * over and must be confirmed before being dropped. But only that one entry file should be dropped — this used to be
 * `setDraft({ ...saved })`, which rolled back the drafts of **every file**: in a folder site, the half-edited
 * app.js / style.css the user was working on vanished the moment they switched to visual, while the confirm dialog
 * only said "source changes will not carry over". The confirm condition narrows accordingly to "the entry itself is
 * dirty"; other files being dirty must not trigger this dialog.
 */
export function visualSwitchPlan(
  draft: Record<string, string>,
  saved: Record<string, string>,
  entry: string,
): { needsConfirm: boolean; nextDraft: Record<string, string> } {
  if (draft[entry] === saved[entry]) return { needsConfirm: false, nextDraft: draft };
  return { needsConfirm: true, nextDraft: { ...draft, [entry]: saved[entry] ?? "" } };
}

/** Source is loaded only after server authorization. A cached receipt cannot unlock this page. */
export function editorLocked(state: { canEdit: boolean; authResolved: boolean; editToken: string | null }): boolean {
  return !state.canEdit;
}

export default function Editor(props: {
  slug: string; title: string; kind: "single" | "folder"; entry: string; versionId: string; files: EditFile[];
  /** Description of the base when it is a **historical** version (omitted when the base is the current version). See lib/edit-base. */
  baseVersion?: EditBaseInfo;
  latestVersionId?: string; officialBase?: boolean;
  /**
   * Server-resolved "can this visitor change content" (capability ≥ content, see lib/authz). Required rather than
   * optional: every new render site must answer this question explicitly; a default of false would silently lock
   * signed-in users out — which was the original bug.
   */
  canEdit: boolean;
  /** The site has several versions → the top bar offers a "switch version" entry point, so the selection step is not something you only stumble on once. */
  canPickVersion?: boolean;
}) {
  const { slug, title, kind, entry, versionId, files, canEdit, canPickVersion } = props;
  const router = useRouter();
  const t = useT();
  const [forking, setForking] = useState(false);
  // Edit access, second path: the per-site token from a ?t=<token> link or this browser's stored
  // owner token. The first path is `canEdit`, resolved server-side — see editorLocked above.
  const { token: editToken, resolved: authResolved } = useEditToken(slug);

  const editableFiles = useMemo(() => files.filter((f) => f.editable), [files]);
  const first = editableFiles.find((f) => f.path === entry) ?? editableFiles[0];

  const [selected, setSelected] = useState<string>(first?.path ?? entry);
  // Working draft + last-saved baseline, both keyed by path.
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(files.map((f) => [f.path, f.content])));
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries(files.map((f) => [f.path, f.content])));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [curVersion, setCurVersion] = useState(props.latestVersionId ?? versionId);
  // The base only holds while nothing has been saved yet. Once a save succeeds, what we are editing is already the
  // **new current version**, and the base must be cleared: otherwise re-fetching the edit frame would still carry
  // ?version=<old version>, the x-ah-editor-version the server returns would not match the freshly saved baseline,
  // and VisualEditor would misreport the user's own save as "This site was updated elsewhere".
  const [baseVersion, setBaseVersion] = useState(props.baseVersion);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // A pending [start, end] selection to restore after a state-driven textarea edit (tab handling).
  const pendingSel = useRef<[number, number] | null>(null);

  // Debounced source that drives the single-site live srcDoc preview (~400ms).
  const [live, setLive] = useState<string>(draft[selected] ?? "");
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLive(draft[selected] ?? ""), 400);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [draft, selected]);

  // Restore the caret/selection after a tab-driven controlled update lands.
  useEffect(() => {
    const sel = pendingSel.current;
    if (sel && taRef.current) {
      taRef.current.setSelectionRange(sel[0], sel[1]);
      pendingSel.current = null;
    }
  });

  const sourceDirty = draft[selected] !== saved[selected];
  const [visualDirty, setVisualDirty] = useState(false);
  // The visual editor's toolbar state (mode, dirty, save) — rendered in the header below, owned by the frame.
  const [ve, setVe] = useState<VisualEditorState | null>(null);
  const anySourceDirty = useMemo(() => Object.keys(draft).some((p) => draft[p] !== saved[p]), [draft, saved]);
  const anyDirty = anySourceDirty || visualDirty;

  // The only bar to visual editing left is "the entry is a readable HTML text file": saving goes through text
  // write-back, so the page no longer has to be script-free and the site no longer has to be single-file (see
  // lib/text-writeback). The real admission check happens in /edit-frame; this only picks the default view.
  const entryFile = files.find((f) => f.path === entry);
  const canVisual = !!entryFile?.editable && /\.html?$/i.test(entry) && (entryFile.content ?? "").trim().length > 0;
  // Visual by default — what users want is "click Edit and change the text directly"; source is the fallback, not the home page.
  const [mode, setMode] = useState<"source" | "visual">(canVisual ? "visual" : "source");

  function enterVisual() {
    // Drop only the entry file's draft; unsaved changes in other files are kept as they are (see visualSwitchPlan).
    const plan = visualSwitchPlan(draft, saved, entry);
    if (plan.needsConfirm
      && !window.confirm(t("“{entry}” has unsaved source changes, and they will not carry over to visual editing. Discard the changes to this one file and continue? (Unsaved changes in other files are kept)", { entry }))) return;
    if (plan.nextDraft !== draft) setDraft(plan.nextDraft);
    setMode("visual");
  }

  function enterSource() {
    if (visualDirty && !window.confirm(t("Visual editing has unsaved changes; switching to source will discard them. Continue?"))) return;
    setVisualDirty(false);
    setMode("source");
  }

  // Unsaved-change guard: warn on refresh / close / external navigation while anything is dirty.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Visual save succeeded: bring the source editor and the version id up to date, so switching back and forth between the two views never shows stale content.
  const onVisualSaved = useCallback((content: string, newVersionId: string | null) => {
    setSaved((prev) => ({ ...prev, [entry]: content }));
    setDraft((prev) => ({ ...prev, [entry]: content }));
    if (newVersionId) setCurVersion(newVersionId);
    setBaseVersion(undefined); // already saved as a new version, so no longer "based on an old version" (see the baseVersion comment above)
    setReloadKey((k) => k + 1);
    flash(t("Saved · A new version was created"));
  }, [entry, flash, t]);

  // Fall back to source editing when the visual side is unavailable (or the user chooses to). Must be a stable reference, otherwise the edit frame would be re-fetched over and over.
  const onVisualFallback = useCallback((reason: string) => {
    setMode("source");
    flash(reason);
  }, [flash]);

  async function save() {
    if (!sourceDirty || busy) return;
    setBusy(true);
    try {
      const body = kind === "single"
        ? { content: draft[selected] }
        : { path: selected, content: draft[selected] };
      const res = await analyticsRequest("update", () => fetch(`/api/sites/${slug}/edit?expected_version=${encodeURIComponent(curVersion)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) },
        body: JSON.stringify({ ...body, baseVersionId: baseVersion?.id }),
      }));
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error(t("This report has changed. Your edits are still here; copy them before refreshing to review the latest version."));
      if (!res.ok) throw new Error(data?.error || t("Save failed ({status})", { status: res.status }));
      track("artifact_update_success", { method: "source" });
      setSaved((prev) => ({ ...prev, [selected]: draft[selected] }));
      if (typeof data?.versionId === "string") setCurVersion(data.versionId);
      setBaseVersion(undefined); // after a save the base is the latest version, consistent with the visual side
      setReloadKey((k) => k + 1); // refresh the served preview for folder sites
      flash(t("Saved · A new version was created"));
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Save failed"));
    } finally {
      setBusy(false);
    }
  }

  // Save as new site — fork the current (saved) version into an independent new site, then open it.
  async function fork() {
    if (forking) return;
    if (anyDirty && !window.confirm(t("There are unsaved changes. Save as new site only includes the saved version; unsaved content will not be in the copy. Continue?"))) return;
    setForking(true);
    try {
      const res = await fetch(`/api/sites/${slug}/fork`, { method: "POST", headers:editToken ? {"x-edit-token":editToken} : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("Save as new site failed"));
      // The fork is ours: keep its fresh edit token so we can edit the new copy.
      if (data.editToken) rememberEditToken(data.slug, data.editToken);
      flash(t("Saved as a new site"));
      router.push(`/s/${data.slug}/edit`);
    } catch (e) {
      flash(e instanceof Error ? e.message : t("Save as new site failed"));
      setForking(false);
    }
  }

  // Share editable link — copy a link that carries this site's edit token; anyone who opens it can edit.


  // Ctrl/Cmd+S saves.
  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  }

  // Tab / Shift+Tab: indent inside the textarea instead of moving focus. A single caret inserts
  // two spaces; a multi-line selection (or Shift+Tab) indents / dedents each covered line.
  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd, value } = ta;
    const spansLines = value.slice(selectionStart, selectionEnd).includes("\n");
    if (e.shiftKey || spansLines) {
      const from = value.lastIndexOf("\n", selectionStart - 1) + 1;
      const block = value.slice(from, selectionEnd);
      const replaced = e.shiftKey ? block.replace(/^(?: {1,2}|\t)/gm, "") : block.replace(/^/gm, INDENT);
      const next = value.slice(0, from) + replaced + value.slice(selectionEnd);
      pendingSel.current = [Math.min(selectionStart, from + INDENT.length), selectionEnd + (replaced.length - block.length)];
      setDraft((prev) => ({ ...prev, [selected]: next }));
    } else {
      const next = value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd);
      const caret = selectionStart + INDENT.length;
      pendingSel.current = [caret, caret];
      setDraft((prev) => ({ ...prev, [selected]: next }));
    }
  }

  function guardLeave(e: React.MouseEvent) {
    if (anyDirty && !window.confirm(t("There are unsaved changes that will be lost if you leave. Go back anyway?"))) e.preventDefault();
  }

  const noEditable = editableFiles.length === 0;
  const shortVer = curVersion.length > 14 ? `${curVersion.slice(0, 12)}…` : curVersion;
  const visual = mode === "visual" && canVisual;

  // No capability from the server and no token in this browser → only then is access genuinely missing; show the lock screen (see editorLocked).
  if (editorLocked({ canEdit, authResolved, editToken })) {
    return (
      <div className="editor">
        <header className="editor-bar">
          <div className="editor-bar-left">
            <Link className="brand" href={`/s/${slug}`} aria-label={t("Back to viewer")}>
              <span aria-hidden="true"><ArrowLeft size={15} /></span>
              <b>artifact-site</b>
            </Link>
            <div className="header-title" title={title}>{title}</div>
          </div>
        </header>
        <div className="editor-note">
          <Lock size={30} />
          <p>{t("You do not have edit access to this site (an editable link is required).")}<br />{t("Viewing is open, but only the site owner or someone holding an editable link can change it.")}</p>
          <div className="locked-actions">
            <Link className="btn sm solid" href={`/s/${slug}`}><ArrowLeft size={14} /> {t("Back to viewer")}</Link>
            <button className="btn sm ghost" type="button" onClick={fork} disabled={forking} title={t("Copy into a new site that you own and can edit")}>
              {forking ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} {t("Save as my editable copy")}
            </button>
          </div>
        </div>
        <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
      </div>
    );
  }

  return (
    <div className="editor" onKeyDown={onKeyDown}>
      {/* One bar, three parts, as the design draws it: where you are (back, title, which version), what you are
          doing (Edit / Preview), and the way out (unsaved, the other editor, "···", save). */}
      <header className="editor-bar">
        <div className="editor-bar-left">
          <Link className="brand" href={`/s/${slug}`} aria-label={t("Back to viewer")} onClick={guardLeave}>
            <span aria-hidden="true"><ArrowLeft size={15} /></span>
            <b>artifact-site</b>
          </Link>
          <div className="header-title" title={title}>{title}</div>
          {/* Editing on top of an old version must stay visible at all times, otherwise users assume they are changing the live version. */}
          {props.officialBase && <span className="official-pill">{t("Based on an official version; the original stays unchanged")}</span>}
          <span className="editor-meta" title={baseVersion ? t("All files come from {label}; saving creates a new latest version", { label: baseVersion.label }) : curVersion}>
            {baseVersion ? <><History size={12} aria-hidden="true" /> {t("Based on {label}", { label: baseVersion.label })}</> : t("Editing version {version}", { version: shortVer })}
          </span>
          {!visual && kind === "folder" && <span className="editor-meta">{selected}</span>}
        </div>

        {visual && (
          <div className="segmented ve-mode" role="group" aria-label={t("Edit / Preview")}>
            <button type="button" aria-pressed={!ve?.previewing} disabled={!ve?.ready} onClick={() => ve?.togglePreview(false)}>
              <MousePointerClick size={13} aria-hidden="true" /> {t("Edit")}
            </button>
            <button type="button" aria-pressed={!!ve?.previewing} disabled={!ve?.ready} onClick={() => ve?.togglePreview(true)}
              title={t("Hand the page back to the artifact in place: its own keys, clicks, and controls come back; unsaved changes are kept")}>
              <Eye size={13} aria-hidden="true" /> {t("Preview")}
            </button>
          </div>
        )}

        <div className="editor-bar-right">
          {anyDirty && <span className="ve-pill"><span className="dirty-dot" aria-hidden="true" />{t("Unsaved")}</span>}
          {/* Source is the fallback, not the home page: while in visual mode it is just an unobtrusive secondary entry point. */}
          {visual ? (
            <button className="ve-secondary" type="button" onClick={enterSource} title={t("Advanced: edit the HTML source directly (for styles, scripts, and other files)")}>
              <Code2 size={13} /> {t("Edit source")}
            </button>
          ) : canVisual && (
            <button className="ve-secondary" type="button" onClick={enterVisual} title={t("Back to visual editing, where you double-click text to change it")}>
              <MousePointerClick size={13} /> {t("Edit visually")}
            </button>
          )}
          {/* The rest — the bare artifact, the editable link, forking, another base version — folds behind "···". */}
          <MoreMenu label={t("More")} iconOnly>
            <SiteDownload slug={slug} editToken={editToken} versionId={baseVersion?.id ?? curVersion} />
            {/* The "Preview" in the toolbar switches in place (no navigation), so this external link is called
                "Open in new tab" instead — calling both of them preview only leaves people guessing which one leaves the page. */}
            <a role="menuitem" className="menu-item" href={withShareContext(`/api/preview/${slug}`)} target="_blank" rel="noreferrer" title={t("Open the artifact itself in a new tab")}><ExternalLink size={14} aria-hidden="true" /> {t("Open in new tab")}</a>

            <button role="menuitem" className="menu-item" type="button" onClick={fork} disabled={forking} title={t("Copy into a separate new site")}>
              {forking ? <Loader2 size={14} className="spin" /> : <Copy size={14} aria-hidden="true" />} {t("Save as new site")}
            </button>
            {canPickVersion && (
              <Link role="menuitem" className="menu-item" href={`/s/${slug}/edit?pick=1`} onClick={guardLeave} title={t("Back to version selection: pick a different base version, or make a copy and edit that")}>
                <History size={14} aria-hidden="true" /> {t("Switch version")}
              </Link>
            )}
          </MoreMenu>
          {visual ? (
            <button data-analytics-button="update" className="btn primary" type="button" onClick={() => ve?.save()} disabled={!ve?.dirty || !!ve?.busy || !ve?.ready}>
              {ve?.busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {t("Save new version")}
            </button>
          ) : (
            <button data-analytics-button="update" className="btn primary" type="button" onClick={save} disabled={!sourceDirty || busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {t("Save new version")}
            </button>
          )}
        </div>
      </header>

      {!visual && (
        <div className="editor-subbar">
          <span className="editor-hint">
            {baseVersion
              ? t("All files come from earlier version {label}. Saving creates a new latest version; {label} and the official version remain unchanged.", { label: baseVersion.label })
              : t("Saving creates a new immutable version; earlier versions stay unchanged.")}
          </span>
        </div>
      )}

      {/* The file list belongs to source editing only — users should never see it in visual mode. */}
      {!visual && kind === "folder" && (
        <div className="editor-filelist" aria-label={t("Choose a file to edit")}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              aria-pressed={selected === f.path}
              disabled={!f.editable}
              title={f.editable ? f.path : t("{path} (binary or too large, not editable)", { path: f.path })}
              onClick={() => f.editable && setSelected(f.path)}
            >
              {f.path}{draft[f.path] !== saved[f.path] ? " •" : ""}
            </button>
          ))}
        </div>
      )}

      {visual ? (
        <VisualEditorWithBase
          slug={slug}
          kind={kind}
          entry={entry}
          versionId={curVersion}
          // With a base, the edit frame fetches source from that version — it must be the same version as `source` above, otherwise the marker offsets would be misaligned.
          baseVersionId={baseVersion?.id}
          source={saved[entry] ?? ""}
          editToken={editToken}
          onSaved={onVisualSaved}
          onDirtyChange={setVisualDirty}
          onFallback={onVisualFallback}
          onState={setVe}
        />
      ) : noEditable ? (
        <div className="editor-note">
          <FileCode2 size={30} />
          <p>{t("This site has no text files that can be edited online. Re-upload it from the home page to update it.")}</p>
        </div>
      ) : (
        <div className="editor-body">
          <div className="editor-pane">
            <div className="editor-pane-head"><span className="micro">{t("Source · {path}", { path: selected })}</span></div>
            <textarea
              ref={taRef}
              className="editor-textarea"
              value={draft[selected] ?? ""}
              spellCheck={false}
              onKeyDown={onTextareaKeyDown}
              onChange={(e) => setDraft((prev) => ({ ...prev, [selected]: e.target.value }))}
            />
          </div>
          <div className="editor-pane">
            <div className="editor-pane-head">
              <span className="micro">{t("Live preview")}</span>
              {kind === "folder" && <span className="micro">{t("Saved version")}</span>}
            </div>
            {kind === "single" ? (
              <iframe
                className="editor-preview"
                title={t("Live preview")}
                srcDoc={live}
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
              />
            ) : (
              <iframe
                key={reloadKey}
                className="editor-preview"
                title={t("Site preview")}
                src={withShareContext(`/api/preview/${slug}?r=${reloadKey}`)}
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              />
            )}
          </div>
        </div>
      )}

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
