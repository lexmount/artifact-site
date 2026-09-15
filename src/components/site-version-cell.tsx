"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import SiteLink from "@/components/site-link";
import { siteFetch as fetch } from "@/lib/share-context";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import type { SiteSummary } from "@/lib/types";
import { useT } from "@/components/locale-provider";
import MoreMenu from "@/components/more-menu";

interface Version { id: string; number: number; current: boolean; official: boolean }
interface Status { versions: Version[]; officialVersionId: string | null; officialRevision: number; canManage: boolean }

/** Fetch history only when opened, and confirm against the revision the user actually saw. */
export default function SiteVersionCell({ site, canManage, token, onMutated }: {
  site: SiteSummary; canManage: boolean; token?: string; onMutated?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [info, setInfo] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ version: Version | null; revision: number; previous: number | null } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/sites/${site.slug}/official`, { cache: "no-store", headers: token ? { "x-edit-token": token } : {} });
      if (!response.ok) throw new Error();
      setInfo(await response.json());
    } catch { setInfo(null); setError(t("Could not load versions. Try again.")); }
    finally { setLoading(false); }
  }, [site.slug, token, t]);
  const openChanged = useCallback((open: boolean) => { if (open) void load(); }, [load]);
  useEffect(() => { if (pending) dialog.current?.showModal(); }, [pending]);
  const official = info ? info.versions.find(v => v.official)?.number : site.officialVersionNumber;
  const label = official != null ? t("Official v{n}", { n: official }) : t("No official version");
  function choose(version: Version | null) {
    if (!info || !info.canManage) return;
    setPending({ version, revision: info.officialRevision, previous: official ?? null });
  }
  function close() { dialog.current?.close(); setPending(null); }
  async function save() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/sites/${site.slug}/official`, {
        method: pending.version ? "PUT" : "DELETE",
        headers: { "content-type": "application/json", ...(token ? { "x-edit-token": token } : {}) },
        body: JSON.stringify({ versionId: pending.version?.id, expectedRevision: pending.revision }),
      });
      if (!response.ok) {
        close();
        await load();
        setError(t(response.status === 409 ? "The official version changed. Choose again." : "Could not change the official version"));
        return;
      }
      const result = await response.json();
      setInfo(previous => previous ? { ...previous, officialVersionId: result.officialVersionId, officialRevision: result.officialRevision, versions: previous.versions.map(v => ({ ...v, official: v.id === result.officialVersionId })) } : null);
      close();
      onMutated?.();
      router.refresh();
    } catch { close(); setError(t("Could not change the official version")); }
    finally { setBusy(false); }
  }
  return <div className="row-versions">
    {canManage ? <MoreMenu label={t("Choose official version for {title}", { title: site.title })} iconOnly buttonClassName="version-choice" buttonContent={<>{label}<ChevronDown size={13} aria-hidden="true" /></>} disabled={busy} onOpenChange={openChanged}>
      <div className="version-options">
        {loading ? <p className="menu-note" role="status">{t("Loading…")}</p> : !info ? <button role="menuitem" type="button" className="menu-item" onClick={() => void load()}>{t("Retry")}</button> : <>
          {info.officialVersionId && <SiteLink slug={site.slug} role="menuitem" className="menu-item" href={`/s/${site.slug}?version=${encodeURIComponent(info.officialVersionId)}`}>{t("View official version")}</SiteLink>}
          {info.canManage ? <>
            {info.versions.map(v => <button key={v.id} type="button" role="menuitem" className="menu-item version-option" disabled={v.official} onClick={() => choose(v)}>
              <span>{t("Version {n}", { n: v.number })}</span><small>{[v.current ? t("Latest version") : "", v.official ? t("Official version") : ""].filter(Boolean).join(" · ")}</small>
            </button>)}
            {info.officialVersionId && <button type="button" role="menuitem" className="menu-item" onClick={() => choose(null)}>{t("Remove official designation")}</button>}
          </> : <p className="menu-note">{t("Only site managers can change the official version.")}</p>}
        </>}
      </div>
    </MoreMenu> : site.officialVersionId ? <SiteLink slug={site.slug} className="official-pill" href={`/s/${site.slug}?version=${encodeURIComponent(site.officialVersionId)}`}>{label}</SiteLink> : <span>{label}</span>}
    <small>{t("{n} versions total", { n: info?.versions.length ?? site.versionCount })}</small>
    {error && <small className="version-error" role="alert">{error}</small>}
    {pending && <dialog ref={dialog} className="upload-confirmation" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <h2 id={titleId}>{pending.version ? t("Set v{n} as official?", { n: pending.version.number }) : t("Remove official designation?")}</h2>
      <p>{pending.version && pending.previous != null ? t("This replaces official v{n}. All version content and the latest version stay unchanged.", { n: pending.previous }) : t("All version content and the latest version stay unchanged.")}</p>
      <div className="official-actions"><button type="button" className="btn" disabled={busy} onClick={close}>{t("Cancel")}</button><button type="button" className="btn solid" disabled={busy} onClick={() => void save()}>{t(busy ? "Saving…" : "Confirm")}</button></div>
    </dialog>}
  </div>;
}
