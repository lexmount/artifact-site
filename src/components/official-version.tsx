"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { siteFetch as fetch } from "@/lib/share-context";
import { useEditToken } from "@/lib/edit-token";
import { useT } from "@/components/locale-provider";

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
export default function OfficialVersion({ slug, versionId, share, onStatus }: { slug: string; versionId?: string; share?: string; onStatus?: (official: string | null, latest: string | null) => void }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const { token: editToken } = useEditToken(slug);
  const [info, setInfo] = useState<OfficialInfo | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/sites/${slug}/official`, { cache: "no-store", headers: { ...(share ? { "x-artifact-share": share } : {}), ...(editToken ? { "x-edit-token": editToken } : {}) } });
    if (res.ok) setInfo(await res.json()); else setInfo(null);
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
  const latest = info.versions.find(v => v.current);
  const href = (id: string) => share ? `/v/${encodeURIComponent(share)}?version=${encodeURIComponent(id)}` : `/s/${slug}?version=${encodeURIComponent(id)}`;
  async function setOfficial(clear = false) {
    if (!viewed || !info) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${slug}/official`, { method: clear ? "DELETE" : "PUT", headers: { "content-type": "application/json", ...(editToken ? { "x-edit-token": editToken } : {}) }, body: JSON.stringify({ versionId: viewed.id, expectedRevision: info.officialRevision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("Could not change the official version"));
      setMessage(t(clear ? "Official designation removed. Content is unchanged." : "Official version updated. The latest version is unchanged."));
      window.dispatchEvent(new Event(OFFICIAL_CHANGED));
    } catch (e) { setMessage(e instanceof Error ? e.message : t("Could not change the official version")); await load(); }
    finally { setBusy(false); }
  }
  if (!viewed) return null;
  return <div className="official-bar" ref={root}>
    <span>{t("Version {n}", { n: viewed.number })}</span>
    {viewed.current && <span className="kind-chip">{t("Latest version")}</span>}
    {viewed.official && <span className="official-pill" title={[info.officialSetByName, info.officialSetAt ? new Date(info.officialSetAt).toLocaleString() : null].filter(Boolean).join(" · ")}>{t("Official version")}</span>}
    {official && !viewed.official && <Link href={href(official.id)}>{t("View official v{n}", { n: official.number })}</Link>}
    {!viewed.current && latest && <Link href={share ? `/v/${encodeURIComponent(share)}` : `/s/${slug}`}>{t("Back to latest version")}</Link>}
    {info.canManage && <div className="official-actions"><button className="btn sm" type="button" disabled={busy} onClick={() => void setOfficial(viewed.official)}>{t(viewed.official ? "Remove official designation" : "Set this version as official")}</button></div>}
    {message && <span role="status">{message}</span>}
  </div>;
}
