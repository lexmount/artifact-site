"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, Folder, Link2, Info, MoreHorizontal, Copy, Check, TriangleAlert } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import { appPath } from "@/lib/app-path";
import PolicyFields, { PolicySummary } from "./policy-fields";
import type {
  ScopeSettings,
  SharingPolicy,
  SharingPreview,
  ScopePreview,
} from "@/lib/sharing-policy";
export function SharingDialog({
  title,
  children,
  onClose,
  onSubmit,
  confirmLabel,
  disabled = false,
  danger = false,
  alert = false,
  description,
  className = "",
  headerActions,
  onBack,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
  alert?: boolean;
  description?: string;
  className?: string;
  headerActions?: ReactNode;
  onBack?: () => void;
}) {
  const t = useT(),
    ref = useRef<HTMLDialogElement>(null),
    id = useId(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <dialog
      className={`scope-dialog ${className}`}
      ref={ref}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-description` : undefined}
      role={alert ? "alertdialog" : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || disabled) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Request failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <h2 id={id}>{alert && <TriangleAlert size={20} aria-hidden="true"/>}{title}</h2>
          {headerActions && <fieldset className="scope-header-actions" disabled={busy}>{headerActions}</fieldset>}
          <button
            type="button"
            className="quiet"
            aria-label={t("Close")}
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </header>
        <div className="scope-dialog-body"><fieldset disabled={busy}>
          {description && <p id={`${id}-description`}>{description}</p>}
          {children}
        </fieldset></div>
        {error && (
          <p className="drawer-error" role="alert">
            {t(error)}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="btn"
            autoFocus={alert}
            onClick={onBack ?? onClose}
            disabled={busy}
          >
            {t(onBack ? "Back" : "Cancel")}
          </button>
          <button
            type="submit"
            className={`btn ${danger ? "danger" : "solid"}`}
            disabled={busy || disabled}
          >
            {busy ? t("Saving…") : confirmLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export function ImpactPreview({ preview }: { preview: SharingPreview }) {
  const t = useT();
  const policies = [...new Map(preview.items.map(item => [`${item.after.audience}:${item.after.comments}`, item.after])).values()];
  return <div className="scope-impact scope-impact-compact">
    <p className="scope-impact-summary">{t("{n} artifacts will follow these settings", { n: preview.items.length })}</p>
    {policies.length > 0 && <p className="scope-impact-access">{policies.slice(0, 3).map(policy => <span key={`${policy.audience}:${policy.comments}`}><PolicySummary policy={policy}/></span>)}{policies.length > 3 && <span>{t("{n} more settings", { n: policies.length - 3 })}</span>}</p>}
    {(preview.unchanged > 0 || preview.excluded > 0) && <p className="scope-muted">{t("{unchanged} unchanged · {excluded} excluded", { unchanged: preview.unchanged, excluded: preview.excluded })}</p>}
    {preview.items.length > 0 && <details>
      <summary>{t("View impact")}</summary>
      <div className="scope-impact-table"><table>
        <thead><tr><th>{t("Site")}</th><th>{t("Current access")}</th><th>{t("After this change")}</th></tr></thead>
        <tbody>{preview.items.map(item => <tr key={item.slug}>
          <td>{item.title}<small>{item.tenantName}</small></td>
          <td data-label={t("Current access")}><PolicySummary policy={item.before}/></td>
          <td data-label={t("After this change")}><PolicySummary policy={item.after}/>
            <small>{t(item.source === "folder" ? "Following folder: {name}" : item.source === "all" ? "Following my entire collection" : "Source: current defaults", { name: item.sourceName ?? "" })}</small>
          </td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}
export default function ScopeSharingDialog({ folderId, onClose, onSaved, deleting = false }: {
  folderId: string | null;
  onClose: () => void;
  onSaved: () => void;
  deleting?: boolean;
}) {
  const t = useT();
  const [data, setData] = useState<ScopeSettings | null>(null);
  const [policy, setPolicy] = useState<SharingPolicy>({ audience: "private", comments: true });
  const [stop, setStop] = useState(deleting);
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const endpoint = `/api/me/sharing/scopes${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`;
  useEffect(() => {
    let alive = true;
    adminFetch<ScopeSettings>(endpoint).then(next => {
      if (alive) { setData(next); setPolicy(next.policy); }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [endpoint]);
  const dirty = data && (policy.audience !== data.policy.audience || policy.comments !== data.policy.comments);
  const enabled = preview?.scope?.enabled ?? data?.enabled;
  const title = deleting ? "Delete folder?" : stop ? folderId ? "Stop folder sharing?" : "Stop all-sites sharing?"
    : preview ? enabled ? "Review sharing changes" : folderId ? "Enable folder sharing?" : "Enable all-sites sharing?"
    : folderId ? "Share folder" : "Share all sites";
  const url = data?.url ? (typeof window !== "undefined" ? window.location.origin : "") + appPath(data.url) : "";
  async function submit() {
    if (!data) return;
    setStatus("");
    const body = { folderId, enabled: !stop, policy, ...(deleting ? { deleteFolder: true } : {}) };
    const review = preview ?? await adminFetch<ScopePreview>("/api/me/sharing/scopes", { method: "POST", body });
    if (!preview && (stop || !data.enabled || !review.scope?.enabled || review.requiresConfirmation !== false
      || !Number.isInteger(data.revision) || review.scope.revision !== data.revision)) {
      setPreview(review);
      return;
    }
    try {
      const saved = await adminFetch<SharingPreview>("/api/me/sharing/scopes", { method: "POST", body: { ...body, confirmation: review.confirmation } });
      onSaved();
      if (stop) { onClose(); return; }
      setPreview(null);
      setStatus(t(saved.pending ? "Opening request under review" : "Sharing settings updated"));
      // A failed refresh must not turn an acknowledged write into a reported failure.
      try { const next = await adminFetch<ScopeSettings>(endpoint); setData(next); setPolicy(next.policy); }
      catch { onClose(); }
    } catch (e) {
      setPreview(null);
      throw e;
    }
  }
  return <SharingDialog title={t(title)} onClose={onClose} onSubmit={submit} className="scope-sharing-compact" danger={deleting}
    disabled={!data || (!stop && policy.audience === "tenant" && !data.canSelectOrganization) || (!stop && !preview && data.enabled && !dirty)}
    confirmLabel={t(preview ? deleting ? "Delete folder" : stop ? "Stop and restore" : enabled ? "Save changes" : "Enable sharing" : "Save")}
    onBack={preview || (stop && !deleting) ? () => { setPreview(null); if (!deleting) setStop(false); } : undefined}
    headerActions={data?.enabled && !stop && !preview ? <details className="scope-more">
      <summary aria-label={t("More sharing options")}><MoreHorizontal size={20}/></summary>
      <div><button type="button" onClick={e => { setShowLink(true); e.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("Show link")}</button>
        <button type="button" className="danger" onClick={() => { setStop(true); setPreview(null); }}>{t("Stop unified sharing")}</button></div>
    </details> : undefined}>
    {error && <p className="drawer-error" role="alert">{t(error)}</p>}
    {!data && !error && <p role="status">{t("Loading…")}</p>}
    {data && <>
      <p className="scope-object">{folderId && <Folder size={18} aria-hidden="true"/>}{folderId && <strong>{data.name}</strong>}
        <span>{t("{n} artifacts", { n: data.eligible })}{data.enabled && <> · {t("{n} following", { n: data.following })}</>}</span>
      </p>
      {!stop && !preview && <PolicyFields value={policy} includeOrganization={data.canSelectOrganization} onChange={next => { setPolicy(next); setCopied(false); setStatus(""); }}/>}
      {preview && <ImpactPreview preview={preview}/>}
      {stop ? <p className="scope-warning"><Info size={16}/>{t("Restoring defaults does not mean private. Some documents may remain accessible.")}</p>
        : preview && !enabled ? <p className="scope-notice"><Info size={16}/>{t("Existing custom settings may be replaced. New artifacts will also follow.")}</p> : null}
      {deleting && <p className="scope-muted">{t("Documents will not be deleted. They will move to Unfiled.")}</p>}
      {!preview && !stop && <details className="scope-rules">
        <summary><span>{t("{n} custom settings", { n: data.custom })}</span><span>{t("View details")}</span></summary>
        <p>{t(data.enabled ? "Scope changes do not override documents with custom settings." : "Existing custom settings may be replaced. New artifacts will also follow.")}</p>
        {data.excluded > 0 && <p>{t("{n} artifacts are excluded", { n: data.excluded })}</p>}
        <p>{t("Folder sharing takes priority over all-sites sharing.")}</p>
        <p>{t("Independent sharing links and direct grants remain unchanged.")}</p>
      </details>}
      {(stop || preview) && <p className="scope-muted">{t("Independent sharing links and direct grants remain unchanged.")}</p>}
      {data.enabled && !stop && !preview && <div className="scope-link scope-link-compact">
        <span><Link2 size={18}/>{t("Sharing link")}</span>
        <button type="button" className="btn sm" onClick={async () => {
          try { await navigator.clipboard.writeText(url); setCopied(true); }
          catch { setShowLink(true); setStatus(t("Copy failed. Select and copy the link.")); }
        }}>{copied ? <Check size={15}/> : <Copy size={15}/>} {t(copied ? "Copied" : "Copy link")}</button>
        {showLink && <input aria-label={t("Sharing link")} readOnly value={url} onFocus={e => e.currentTarget.select()}/>}
      </div>}
      {status && <p className="scope-success" role="status">{status}</p>}
      {dirty && !preview && !stop && <p className="scope-muted" role="status">{t("Changes apply after saving.")}</p>}
    </>}
  </SharingDialog>;
}
