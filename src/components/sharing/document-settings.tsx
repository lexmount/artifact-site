"use client";
import { useEffect, useState } from "react";
import { Folder, Info, Link2, SlidersHorizontal } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import { invalidateClientCaches } from "@/lib/client-cache";
import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";
import PolicyFields, { PolicySummary } from "./policy-fields";
import { SharingDialog } from "./scope-dialog";
type State = SharingState & {
  links: number;
  members: number;
  canStop: boolean;
  follow: SharingState | null;
};
export default function DocumentSharingSettings({
  slug,
  onSaved,
  onStateChange,
  disabled = false,
}: {
  slug: string;
  disabled?: boolean;
  onSaved: (pending: boolean) => void;
  onStateChange?: (editing: boolean, busy: boolean, unavailable: boolean) => void;
}) {
  const t = useT(),
    [data, setData] = useState<State | null>(null),
    [draft, setDraft] = useState<SharingPolicy | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"follow" | "stop" | null>(null);
  useEffect(() => {
    onStateChange?.(draft !== null, busy, !data);
    return () => onStateChange?.(false, false, false);
  }, [draft, busy, data, onStateChange]);
  const endpoint = `/api/sites/${encodeURIComponent(slug)}/main-sharing`;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    adminFetch<State>(endpoint)
      .then((r) => {
        if (alive) { setData(r); setError(""); }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [endpoint, retry]);
  async function save(action: "custom" | "follow" | "stop") {
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await adminFetch<SharingState>(endpoint, {
        method: "PUT",
        body: { action, ...(action === "custom" ? { policy: draft } : {}) },
      });
      setData(await adminFetch<State>(endpoint));
      setDraft(null);
      setConfirm(null);
      invalidateClientCaches();
      onSaved(saved.pending);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sharing-section sharing-main-policy">
      <h3>{t("Main address access")}</h3>
      {error && (
        <p role="alert" className="drawer-error">
          {t(error)}
        </p>
      )}
      {!data && !error && <div className="sharing-skeleton" aria-busy="true" />}
      {!data && error && <button className="btn sm" onClick={() => { setError(""); setRetry(value => value + 1); }}>{t("Try again")}</button>}
      {data && (
        <>
          {data.source !== "default" && <div
            className={
              data.source === "manual" ? "scope-source" : "scope-notice"
            }
          >
            {data.source === "folder" ? <Folder size={17} /> : data.source === "all" ? <Link2 size={17} /> : <SlidersHorizontal size={17} />}
            <span>
              {data.source === "folder"
                ? t("Following folder: {name}", { name: data.sourceName ?? "" })
                : data.source === "all"
                  ? t("Following my entire collection")
                  : t("Custom settings")}
            </span>
            {data.source === "manual" && (
              <button
                className="btn sm"
                disabled={busy || disabled}
                onClick={() => setConfirm("follow")}
              >
                {t("Resume following")}
              </button>
            )}
          </div>}
          <PolicyFields
            includePublic
            value={draft ?? data.policy}
            disabled={busy || disabled}
            onChange={setDraft}
          />
          {draft && (
            <>
              <p className="scope-warning">
                <Info size={16} />
                {t(
                  "Saving creates custom settings. Future scope changes will not override this document.",
                )}
              </p>
              <div className="scope-form-actions">
                <button
                  className="btn"
                  disabled={busy || disabled}
                  onClick={() => setDraft(null)}
                >
                  {t("Cancel")}
                </button>
                <button
                  className="btn solid"
                  disabled={busy || disabled}
                  onClick={() =>
                    void save("custom").catch((e) => setError(e.message))
                  }
                >
                  {t("Save custom settings")}
                </button>
              </div>
            </>
          )}
          {(data.links > 0 || data.members > 0) && <p className="scope-muted">
            {t(
              "Other access: {links} independent links · {members} direct grants",
              { links: data.links, members: data.members },
            )}
          </p>}
          {data.canStop && (data.policy.audience !== "private" || data.links > 0 || data.members > 0 || data.pending || data.source === "folder" || data.source === "all") && (
            <button
              className="scope-danger-link"
              disabled={busy || disabled}
              onClick={() => setConfirm("stop")}
            >
              {t("Stop all sharing for this document")}
            </button>
          )}
          {confirm && (
            <SharingDialog
              title={t(
                confirm === "stop"
                  ? "Stop all sharing for this document?"
                  : "Resume following?",
              )}
              onClose={() => setConfirm(null)}
              danger={confirm === "stop"}
              confirmLabel={t(
                confirm === "stop" ? "Stop all sharing" : "Confirm restore",
              )}
              onSubmit={() => save(confirm)}
            >
              {confirm === "stop" ? (
                <>
                  <p>
                    {t(
                      "The main address becomes private. Independent links and direct grants are revoked, and this document stops following scope settings.",
                    )}
                  </p>
                  <p className="scope-warning">
                    {t("Owner and necessary administrative access remain.")}
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {t(
                      "This replaces custom settings with the applicable folder, all-sites scope, or current defaults.",
                    )}
                  </p>
                  {data.follow && (
                    <div className="scope-restore-preview">
                      <div>
                        <small>{t("Current access")}</small>
                        <PolicySummary policy={data.policy} />
                      </div>
                      <span>→</span>
                      <div>
                        <small>{t("After this change")}</small>
                        <PolicySummary policy={data.follow.policy} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </SharingDialog>
          )}
        </>
      )}
    </section>
  );
}
