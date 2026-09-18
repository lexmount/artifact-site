"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronDown, Check } from "lucide-react";
import MoreMenu from "@/components/more-menu";
import { siteFetch as fetch } from "@/lib/share-context";
import { useEditToken } from "@/lib/edit-token";
import { useT } from "@/components/locale-provider";

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export const OFFICIAL_CHANGED = "artifact:official-changed";
interface OfficialInfo {
  versions: { id: string; number: number; current: boolean; official: boolean }[];
  currentVersionId: string | null;
  officialVersionId: string | null;
  officialRevision?: number;
  officialSetAt: number | null;
  officialSetByName?: string | null;
  canManage: boolean;
}
export default function OfficialVersion({ slug, versionId, share, onStatus, onOpenChange }: { slug: string; versionId?: string; share?: string; onStatus?: (official: string | null, latest: string | null) => void; onOpenChange?: (open: boolean) => void }) {
  const t = useT();
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<{ id: string | null; number: number; revision: number; previous: number | null } | null>(null);
  useEffect(() => { if (pending) dialog.current?.showModal(); }, [pending]);
  useEffect(() => { onOpenChange?.(menuOpen || !!pending); return () => onOpenChange?.(false); }, [menuOpen, pending, onOpenChange]);
  const { token: editToken } = useEditToken(slug);
  const [info, setInfo] = useState<OfficialInfo | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/sites/${slug}/official`, { cache: "no-store", headers: { ...(share ? { "x-artifact-share": share } : {}), ...(editToken ? { "x-edit-token": editToken } : {}) } });
    if (res.ok) setInfo(await res.json());
    else if ([401, 403, 404].includes(res.status)) {
      setInfo(null);
      setPending(null);
      setMenuOpen(false);
      setMessage("");
    }
    // Keep the last successful snapshot and open confirmation on transient failures.
  }, [slug, share, editToken]);
  useEffect(() => {
    const refresh = () => { void load().catch(() => {}); };
    refresh();
    window.addEventListener(OFFICIAL_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener(OFFICIAL_CHANGED, refresh); window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => {
    if (!info?.canManage) return;
    const timer = setInterval(() => { void load().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [info?.canManage, load]);
  useEffect(() => { if (info) onStatus?.(info.officialVersionId, info.currentVersionId); }, [info, onStatus]);
  useEffect(() => {
    const header = root.current?.closest("header");
    const viewer = root.current?.closest<HTMLElement>(".fs-viewer");
    if (!header || !viewer) return;
    const measure = () => viewer.style.setProperty("--fs-bar-h", `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [info]);
  if (!info) return null;
  const viewed = info.versions.find(v => v.id === (versionId ?? info.currentVersionId));
  const official = info.versions.find(v => v.official);
  const href = (id: string) => share ? `/v/${encodeURIComponent(share)}?version=${encodeURIComponent(id)}` : `/s/${slug}?version=${encodeURIComponent(id)}`;
  function closeConfirmation() { dialog.current?.close(); setPending(null); }
  async function setOfficial() {
    if (!pending) return;
    const clear = pending.id === null;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${slug}/official`, { method: clear ? "DELETE" : "PUT", headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) }, body: JSON.stringify({ versionId: pending.id ?? undefined, expectedRevision: pending.revision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 409 ? t("The official version changed. Choose again.") : data.error || t("Could not change the official version"));
      setMessage(t(clear ? "Official designation removed. Content is unchanged." : "Official version updated. The latest version is unchanged."));
      closeConfirmation();
      window.dispatchEvent(new Event(OFFICIAL_CHANGED));
    } catch (e) { setMessage(e instanceof Error ? e.message : t("Could not change the official version")); closeConfirmation(); await load().catch(() => {}); }
    finally { setBusy(false); }
  }
  if (!viewed) return null;
  const status = viewed.official ? t("Official version") : viewed.current ? t("Latest version") : t("Historical version");
  const label = <><span className="official-version-number">v{viewed.number}</span><span className="official-version-state">{viewed.official && <Check size={12} aria-hidden="true" />}{status}</span></>;
  return <div className="official-bar" ref={root}>
    <MoreMenu label={`${t("Version actions")}: v${viewed.number} · ${status}`} iconOnly buttonClassName={`official-version-trigger${viewed.official ? " is-official" : ""}`} buttonContent={<>{label}<ChevronDown size={13} aria-hidden="true" /></>} onOpenChange={setMenuOpen}>
      <div className="official-version-options">
        {info.versions.map(v => <Link key={v.id} role="menuitem" className="menu-item official-version-option" href={href(v.id)} aria-current={v.id === viewed.id ? "page" : undefined}>
          <span className="official-option-number"><Check size={14} aria-hidden="true" style={{ visibility: v.id === viewed.id ? "visible" : "hidden" }} />v{v.number}</span>
          <span className="official-option-tags">{v.current && <small>{t("Latest version")}</small>}{v.official && <small className="official-pill">{t("Official version")}</small>}{v.id === viewed.id && <small>{t("Currently viewing")}</small>}</span>
        </Link>)}
      </div>
      <div className="official-menu-footer">{t("{n} versions total", { n: info.versions.length })}</div>
      {info.canManage && info.officialRevision !== undefined && <button role="menuitem" className="menu-item official-designate" type="button" disabled={busy} onClick={() => setPending({ id: viewed.official ? null : viewed.id, number: viewed.number, revision: info.officialRevision!, previous: official?.number ?? null })}>{t(viewed.official ? "Remove official designation" : "Set this version as official")}</button>}
    </MoreMenu>
    {official && !viewed.official && <Link className="official-version-link" href={href(official.id)}>{t("Official v{n}", { n: official.number })}</Link>}
    {hydrated && createPortal(<>
      {message && <span className="official-feedback" role="status">{message}<button type="button" aria-label={t("Close")} onClick={() => setMessage("")}>×</button></span>}
      {pending && <dialog ref={dialog} className="upload-confirmation official-confirmation" aria-labelledby={dialogTitle} onCancel={event => { event.preventDefault(); if (!busy) closeConfirmation(); }}>
        <h2 id={dialogTitle}>{pending.id ? t("Set v{n} as official?", { n: pending.number }) : t("Remove official designation?")}</h2>
        <p>{pending.id && pending.previous != null ? t("This replaces official v{n}. All version content and the latest version stay unchanged.", { n: pending.previous }) : t("All version content and the latest version stay unchanged.")}</p>
        <div className="official-actions"><button type="button" className="btn" disabled={busy} onClick={closeConfirmation}>{t("Cancel")}</button><button type="button" className="btn solid" disabled={busy} onClick={() => void setOfficial()}>{t(busy ? "Saving…" : "Confirm")}</button></div>
      </dialog>}
    </>, document.body)}
  </div>;
}
