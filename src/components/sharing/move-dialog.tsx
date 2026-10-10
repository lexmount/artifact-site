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
}: {
  slugs: string[];
  folders: { id: string; name: string }[];
  initialFolderId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(),
    [folderId, setFolderId] = useState(initialFolderId),
    [preview, setPreview] = useState<SharingPreview | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
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
  }, [slugs, folderId]);
  return (
    <SharingDialog
      title={t(slugs.length > 1 ? "Move documents" : "Move document")}
      onClose={onClose}
      disabled={!preview}
      confirmLabel={t("Confirm move")}
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
      <label>
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
      </label>
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
                "Moving into a shared folder replaces custom settings and starts following that folder.",
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
