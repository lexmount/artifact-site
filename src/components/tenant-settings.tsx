"use client";
import TenantMembers from "@/components/tenant-members";
import { appFetch } from "@/lib/app-path";
import Link from "next/link";
import { useEffect, useState } from "react";
import AppShell from "@/components/app-shell";
import { useT } from "@/components/locale-provider";
type Tenant = {
  id: string;
  name: string;
  role: string;
  disabledAt: number | null;
};
export default function TenantSettings() {
  const t = useT();
  const roleLabel = (role: string) =>
    t(
      role === "platform-admin"
        ? "Platform administrator"
        : role === "admin"
          ? "Workspace administrator"
          : "Member",
    );
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState("init");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [anonymousCount, setAnonymousCount] = useState(0);
  async function call(path: string, body?: unknown, method = "PUT") {
    const res = await appFetch(path, {
      method: body === undefined ? "GET" : method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t("Request failed"));
    return data;
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [a, b] = await Promise.all([
          call("/api/tenants"),
          call("/api/me/adopt"),
        ]);
        if (alive) {
          setTenants(a.tenants);
          if (!a.tenants.some((x: Tenant) => x.id === "init"))
            setSelected(a.tenants[0]?.id ?? "");
          setAnonymousCount(b.sites.length);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const manager = tenants.some(
    (x) => x.id === selected && ["admin", "platform-admin"].includes(x.role),
  );
  const platform = tenants.some((x) => x.role === "platform-admin");
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
      setStatus(t("Saved"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppShell>
      <div className="tenant-settings">
        <div className="work-title">
          <h1>{t("Workspaces")}</h1>
        </div>
        <p>
          {t(
            "Membership is permanent until removed. Share links grant separate, revocable access.",
          )}
        </p>
        {error && (
          <p className="drawer-error" role="alert">
            {error}
          </p>
        )}
        <p role="status">{status}</p>
        <label>
          {t("Workspace")}{" "}
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {tenants.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {roleLabel(x.role)}
                {x.disabledAt ? ` (${t("Disabled")})` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="drawer-note">{t("Selecting a workspace here does not change your default publishing tenant.")}</p>
        {anonymousCount > 0 && (
          <section className="share-sec">
            <h2>{t("Claim anonymous artifacts")}</h2>
            <p>
              {t(
                "Claim {n} artifacts from this browser and move them to the selected workspace.",
                { n: anonymousCount },
              )}
            </p>
            <button
              className="btn"
              disabled={busy || selected === "anonymous"}
              onClick={() =>
                void act(async () => {
                  await call("/api/me/adopt", { tenantId: selected }, "POST");
                  setAnonymousCount(0);
                })
              }
            >
              {t("Claim and move")}
            </button>
          </section>
        )}
        {manager && selected !== "anonymous" && <TenantMembers key={selected} tenantId={selected} disabled={Boolean(tenants.find(x => x.id === selected)?.disabledAt)}/>}
        {manager && selected !== "anonymous" && <p><Link href="/authorization" className="btn">{t("Manage authorization")}</Link></p>}
        {platform && <p><Link href="/admin/tenants" className="btn">{t("Tenant management")}</Link></p>}

      </div>
    </AppShell>
  );
}
