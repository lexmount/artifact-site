"use client";
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { adminFetch } from "@/components/admin/format";
import PolicyFields, { PolicySummary } from "./policy-fields";
import type { SharingPolicy } from "@/lib/sharing-policy";
type Defaults = {
  policy: SharingPolicy;
  tenantPolicy: SharingPolicy;
  inherited: boolean;
};
export default function DefaultSharingSettings({
  tenantId,
  tenant = false,
}: {
  tenantId: string;
  tenant?: boolean;
}) {
  const t = useT(),
    [data, setData] = useState<Defaults | null>(null),
    [policy, setPolicy] = useState<SharingPolicy>({
      audience: "private",
      comments: false,
    });
  const [inherit, setInherit] = useState(true),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const endpoint = tenant
    ? `/api/tenants/${encodeURIComponent(tenantId)}/sharing-defaults`
    : `/api/me/sharing/preferences?tenantId=${encodeURIComponent(tenantId)}`;
  useEffect(() => {
    let alive = true;
    adminFetch<Defaults>(endpoint)
      .then((r) => {
        if (alive) {
          setData(r);
          setPolicy(r.policy);
          setInherit(r.inherited);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);
  async function save() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const r = await adminFetch<Defaults>(endpoint, {
        method: "PUT",
        body: tenant ? policy : { tenantId, policy: inherit ? null : policy },
      });
      setData(r);
      setPolicy(r.policy);
      setStatus(t("Sharing preferences saved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sharing-defaults">
      <h2>{t(tenant ? "Default sharing settings" : "Sharing settings")}</h2>
      <p className="scope-muted">
        {t(
          "Only new documents use these defaults. Existing documents remain unchanged.",
        )}
      </p>
      {error && (
        <p className="drawer-error" role="alert">
          {t(error)}
        </p>
      )}
      {!data && !error && <div className="tenant-skeleton" aria-busy="true" />}
      {data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!tenant && (
            <fieldset className="scope-inheritance" disabled={busy}>
              <legend className="sr-only">
                {t("Default sharing settings")}
              </legend>
              <label className={inherit ? "selected" : ""}>
                <input
                  type="radio"
                  name="sharing-inheritance"
                  checked={inherit}
                  onChange={() => setInherit(true)}
                />
                <span>
                  <strong>{t("Inherit tenant settings")}</strong>
                  <small>
                    {t("Use the tenant's default sharing settings.")}
                  </small>
                </span>
              </label>
              <label className={!inherit ? "selected" : ""}>
                <input
                  type="radio"
                  name="sharing-inheritance"
                  checked={!inherit}
                  onChange={() => setInherit(false)}
                />
                <span>
                  <strong>{t("Custom settings")}</strong>
                  <small>
                    {t(
                      "Set your own defaults for new documents in this tenant.",
                    )}
                  </small>
                </span>
              </label>
            </fieldset>
          )}
          {(tenant || !inherit) && (
            <PolicyFields value={policy} onChange={setPolicy} disabled={busy} />
          )}
          <div className="scope-notice">
            <CheckCircle2 size={18} />
            <div>
              <strong>
                {t("Effective settings")}:{" "}
                <PolicySummary
                  policy={!tenant && inherit ? data.tenantPolicy : policy}
                />
              </strong>
              <p>
                {t(
                  !tenant && inherit
                    ? "Source: tenant defaults"
                    : "Applies to newly created documents",
                )}
              </p>
            </div>
          </div>
          <p className="scope-muted">
            {t(
              "Leaving a sharing scope restores the defaults effective at that time.",
            )}
          </p>
          <div className="scope-form-actions">
            <button className="btn solid" disabled={busy}>
              {t(busy ? "Saving…" : "Save settings")}
            </button>
            {!tenant && !inherit && (
              <button
                type="button"
                className="quiet"
                onClick={() => setInherit(true)}
              >
                {t("Restore inheritance")}
              </button>
            )}
          </div>
          {status && (
            <p role="status" className="scope-success">
              {status}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
export function PersonalSharingPreferences() {
  const t = useT();
  const [tenant, setTenant] = useState<{ id: string; name: string; disabledAt: number | null } | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    adminFetch<{ defaultTenant: typeof tenant }>("/api/me/sharing/preferences")
      .then(r => { if (alive) setTenant(r.defaultTenant); })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  return <main className="sharing-preferences-page">
    <h1>{t("Sharing preferences")}</h1>
    <p className="scope-muted">{t("Set the default sharing for new documents in your default publishing tenant.")}</p>
    {error && <p role="alert" className="drawer-error">{t(error)}</p>}
    {loading && <div className="tenant-skeleton" aria-label={t("Loading…")} aria-busy="true"/>}
    {tenant && <p className="scope-default-tenant">{t("Default publishing tenant")}<strong>{tenant.name}</strong></p>}
    {!loading && !error && (!tenant || tenant.disabledAt != null) && <p role="status" className="scope-muted">{t("Your default publishing tenant is unavailable. Contact an administrator.")}</p>}
    {tenant && tenant.disabledAt == null && <DefaultSharingSettings key={tenant.id} tenantId={tenant.id}/>}
  </main>;
}
