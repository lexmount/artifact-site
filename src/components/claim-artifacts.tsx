"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/components/admin/format";
import { useT } from "@/components/locale-provider";
import { invalidateClientCaches } from "@/lib/client-cache";
type ClaimData = { sites: { slug: string; title: string }[]; tenant: { id: string; name: string; disabledAt: number | null } | null };
export default function ClaimArtifacts() {
  const t = useT(), router = useRouter();
  const [data, setData] = useState<ClaimData | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [adopted, setAdopted] = useState<number | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([
      adminFetch<{ sites: ClaimData["sites"] }>("/api/me/adopt"),
      adminFetch<{ defaultTenant: ClaimData["tenant"] }>("/api/me/sharing/preferences"),
    ]).then(([a, b]) => { if (alive) { setData({ sites: a.sites, tenant: b.defaultTenant }); setError(""); } }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [retry]);
  async function claim() {
    if (!data?.tenant || data.tenant.disabledAt || busy) return;
    setBusy(true); setError("");
    try {
      const result = await adminFetch<{ adopted: number }>("/api/me/adopt", { method: "POST", body: { tenantId: data.tenant.id } });
      setAdopted(result.adopted); invalidateClientCaches(); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  return <div className="claim-artifacts tenant-settings">
    <Link className="quiet" href="/me">← {t("My sites")}</Link>
    <h1>{t("Add browser-created artifacts to my account")}</h1>
    {error && <p className="drawer-error" role="alert">{t(error)} <button className="btn sm" disabled={busy} onClick={() => setRetry(v => v + 1)}>{t("Try again")}</button></p>}
    {!data && !error && <p>{t("Loading…")}</p>}
    {adopted !== null ? <p className="claim-success" role="status">{t("Added {n} artifacts to your account.", { n: adopted })} <Link href="/me">{t("My sites")}</Link></p> : data && <>
      {data.sites.length === 0 ? <p>{t("No unclaimed artifacts in this browser.")}</p> : <>
        <p>{t("These {n} artifacts were created in this browser before signing in.", { n: data.sites.length })}</p>
        {data.tenant && !data.tenant.disabledAt ? <p>{t("They will belong to your account and move to your default tenant: {name}.", { name: data.tenant.name })}</p> : <p className="drawer-error">{t("Your default publishing tenant is unavailable. Contact an administrator.")}</p>}
        <ul className="claim-artifact-list">{data.sites.map(site => <li key={site.slug}>{site.title}</li>)}</ul>
        <div className="scope-form-actions"><Link className="btn" href="/me">{t("Cancel")}</Link><button className="btn solid claim-submit" disabled={busy || !data.tenant || Boolean(data.tenant.disabledAt)} onClick={() => void claim()}>{t(busy ? "Saving…" : "Confirm and add to my account")}</button></div>
      </>}
    </>}
  </div>;
}
