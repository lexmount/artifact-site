"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, Folder, Link2, Info } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import { appPath } from "@/lib/app-path";
import PolicyFields, { PolicySummary } from "./policy-fields";
import type {
  ScopeSettings,
  SharingPolicy,
  SharingPreview,
} from "@/lib/sharing-policy";
export function SharingDialog({
  title,
  children,
  onClose,
  onSubmit,
  confirmLabel,
  disabled = false,
  danger = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  const t = useT(),
    ref = useRef<HTMLDialogElement>(null),
    id = useId(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className={`scope-dialog ${className}`}
      ref={ref}
      aria-labelledby={id}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
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
          <h2 id={id}>{title}</h2>
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
        <div className="scope-dialog-body"><fieldset disabled={busy}>{children}</fieldset></div>
        {error && (
          <p className="drawer-error" role="alert">
            {t(error)}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          <button
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
  const count = (source: string) =>
    preview.items.filter((i) => i.source === source).length;
  return (
    <div className="scope-impact">
      <h3>{t("Change impact")}</h3>
      <div className="scope-impact-counts">
        <span>
          <b>{preview.items.length}</b>
          {t("Documents to update")}
        </span>
        <span>
          <b>{preview.unchanged}</b>
          {t("Keep current settings")}
        </span>
        {preview.excluded > 0 && (
          <span>
            <b>{preview.excluded}</b>
            {t("Excluded documents")}
          </span>
        )}
      </div>
      <ul className="scope-impact-destinations">
        {count("folder") > 0 && (
          <li>
            {t("{n} documents will follow their folder", {
              n: count("folder"),
            })}
          </li>
        )}
        {count("all") > 0 && (
          <li>
            {t("{n} documents will follow all-sites sharing", {
              n: count("all"),
            })}
          </li>
        )}
        {count("default") > 0 && (
          <li>
            {t("{n} documents will restore current defaults", {
              n: count("default"),
            })}
          </li>
        )}
      </ul>
      {preview.items.length > 0 && (
        <details open={preview.items.length <= 5}>
          <summary>{t("Review affected documents")}</summary>
          <div className="scope-impact-table">
            <table>
              <thead>
                <tr>
                  <th>{t("Document")}</th>
                  <th>{t("Current access")}</th>
                  <th>{t("After this change")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((i) => (
                  <tr key={i.slug}>
                    <td>
                      {i.title}
                      <small>{i.tenantName}</small>
                    </td>
                    <td data-label={t("Current access")}>
                      <PolicySummary policy={i.before} />
                    </td>
                    <td data-label={t("After this change")}>
                      <PolicySummary policy={i.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
export default function ScopeSharingDialog({
  folderId,
  onClose,
  onSaved,
  deleting = false,
}: {
  folderId: string | null;
  onClose: () => void;
  onSaved: () => void;
  deleting?: boolean;
}) {
  const t = useT(),
    [data, setData] = useState<ScopeSettings | null>(null),
    [policy, setPolicy] = useState<SharingPolicy>({
      audience: "tenant",
      comments: true,
    }),
    [stop, setStop] = useState(deleting),
    [preview, setPreview] = useState<SharingPreview | null>(null),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    adminFetch<ScopeSettings>(
      `/api/me/sharing/scopes${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
    )
      .then((r) => {
        if (alive) {
          setData(r);
          setPolicy(r.policy);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [folderId]);
  const title = deleting
    ? t("Delete folder?")
    : stop
      ? t(folderId ? "Stop folder sharing?" : "Stop all-sites sharing?")
      : t(folderId ? "Share folder" : "Share my entire collection");
  return (
    <SharingDialog
      title={title}
      onClose={onClose}
      disabled={!data}
      danger={deleting}
      confirmLabel={
        preview
          ? t(
              deleting
                ? "Delete folder"
                : stop
                  ? "Stop and restore"
                  : data?.enabled
                    ? "Save changes"
                    : "Enable sharing",
            )
          : t("Review changes")
      }
      onSubmit={async () => {
        const body = {
          folderId,
          enabled: !stop,
          policy,
          ...(deleting ? { deleteFolder: true } : {}),
        };
        if (!preview) {
          setPreview(
            await adminFetch<SharingPreview>("/api/me/sharing/scopes", {
              method: "POST",
              body,
            }),
          );
          return;
        }
        try {
          await adminFetch("/api/me/sharing/scopes", {
            method: "POST",
            body: { ...body, confirmation: preview.confirmation },
          });
          onSaved();
          if (stop) {
            onClose();
          } else {
            const next = await adminFetch<ScopeSettings>(
              `/api/me/sharing/scopes${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
            );
            setData(next);
            setPreview(null);
          }
        } catch (e) {
          setPreview(null);
          throw e;
        }
      }}
    >
      {error && (
        <p className="drawer-error" role="alert">
          {t(error)}
        </p>
      )}
      {data && (
        <>
          <div className="scope-identity">
            <span>{folderId ? <Folder /> : <Link2 />}</span>
            <div>
              <strong>
                {folderId ? data.name : t("My entire collection")}
              </strong>
              <small>
                {folderId
                  ? t("{n} owned documents", { n: data.eligible })
                  : t("Across tenants · Documents I own")}
              </small>
            </div>
          </div>
          <p className="scope-muted">
            {t(
              "{following} following · {custom} custom · {excluded} excluded",
              {
                following: data.following,
                custom: data.custom,
                excluded: data.excluded,
              },
            )}
          </p>
          {!stop && (
            <PolicyFields
              value={policy}
              onChange={(p) => {
                setPolicy(p);
                setPreview(null);
              }}
            />
          )}
          {stop ? (
            <p className="scope-warning">
              <Info size={17} />
              {t(
                "Restoring defaults does not mean private. Some documents may remain accessible.",
              )}
            </p>
          ) : !data.enabled ? (
            <p className="scope-notice">
              <Info size={18} />
              {t(
                "Enabling sharing replaces the main-address settings of eligible documents. New documents in this scope will also follow.",
              )}
            </p>
          ) : (
            <p className="scope-muted">
              {t(
                "Scope changes do not override documents with custom settings.",
              )}
            </p>
          )}
          {deleting && (
            <p>
              {t("Documents will not be deleted. They will move to Unfiled.")}
            </p>
          )}
          <p className="scope-muted">
            {t("Independent sharing links and direct grants remain unchanged.")}
          </p>
          {preview && <ImpactPreview preview={preview} />}
          {data.enabled && !stop && (
            <>
              <div className="scope-link">
                <label>
                  {t("Collection link")}
                  <input
                    readOnly
                    value={
                      typeof window !== "undefined"
                        ? window.location.origin + appPath(data.url!)
                        : data.url!
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn solid"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        window.location.origin + appPath(data.url!),
                      );
                      setCopied(true);
                    } catch {
                      setError("Copy failed. Select and copy the link.");
                    }
                  }}
                >
                  {t(copied ? "Copied" : "Copy collection link")}
                </button>
              </div>
              <p className="scope-muted">
                {t(
                  "Only documents the visitor can access appear in this collection.",
                )}
              </p>
              <button
                type="button"
                className="scope-danger-link"
                onClick={() => {
                  setStop(true);
                  setPreview(null);
                }}
              >
                {t("Stop unified sharing")}
              </button>
            </>
          )}
        </>
      )}
    </SharingDialog>
  );
}
