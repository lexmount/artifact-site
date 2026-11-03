"use client";
import { useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import { ImpactPreview, SharingDialog } from "./scope-dialog";
import type { SharingPreview } from "@/lib/sharing-policy";
export default function MoveSharingDialog({
  slugs,
  folders,
  initialFolderId,
  onClose,
  onSaved,
  initialPreview,
}: {
  slugs: string[];
  folders: { id: string; name: string }[];
  initialFolderId: string | null;
  onClose: () => void;
  onSaved: () => void;
  initialPreview?: SharingPreview;
}) {
  const t = useT(),
    [folderId, setFolderId] = useState(initialFolderId),
    [preview, setPreview] = useState<SharingPreview | null>(initialPreview ?? null),
    [error, setError] = useState("");
  useEffect(() => {
    if (initialPreview) return;
    let alive = true;
    adminFetch<SharingPreview>("/api/me/sharing/move", {
      method: "POST",
      body: { slugs, folderId },
    })
      .then((r) => {
        if (alive) setPreview(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [slugs, folderId, initialPreview]);
  return (
    <SharingDialog
      title={t(initialPreview ? "Move and update sharing?" : slugs.length > 1 ? "Move documents" : "Move document")}
      className="scope-sharing-compact"
      onClose={onClose}
      disabled={!preview}
      confirmLabel={t(preview?.items.length ? "Move and update" : "Confirm move")}
      onSubmit={async () => {
        try {
          await adminFetch("/api/me/sharing/move", {
            method: "POST",
            body: { slugs, folderId, confirmation: preview!.confirmation },
          });
          onSaved();
          onClose();
        } catch (e) {
          const next = await adminFetch<SharingPreview>(
            "/api/me/sharing/move",
            { method: "POST", body: { slugs, folderId } },
          );
          setPreview(next);
          throw e;
        }
      }}
    >
      {initialPreview ? <p className="scope-object">{t("Move {n} artifacts to {name}", { n: slugs.length, name: folders.find(f => f.id === folderId)?.name ?? t("Unfiled") })}</p> : <label>
        {t("Move to folder")}
        <select
          value={folderId ?? ""}
          onChange={(e) => {
            setPreview(null);
            setFolderId(e.target.value || null);
          }}
        >
          <option value="">{t("Unfiled")}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>}
      {error && (
        <p className="drawer-error" role="alert">
          {t(error)}
        </p>
      )}
      {preview && (
        <>
          <ImpactPreview preview={preview} />
          {preview.items.some((i) => i.source === "folder") && (
            <p className="scope-notice">
              {t(
                "These artifacts will follow the folder's sharing settings.",
              )}
            </p>
          )}
          <p className="scope-muted">
            {t(
              "When leaving, other applicable scopes take precedence over your current defaults. Independent links remain unchanged.",
            )}
          </p>
        </>
      )}
    </SharingDialog>
  );
}
