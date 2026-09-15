"use client";
import { useEffect, useState } from "react";
import AppShell from "@/components/app-shell";
import { useT } from "@/components/locale-provider";
type Tenant = {
  id: string;
  name: string;
  role: string;
  disabledAt: number | null;
};
type Member = {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string;
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
  const [members, setMembers] = useState<Member[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [adminId, setAdminId] = useState("");
  const [anonymousCount, setAnonymousCount] = useState(0);
  async function call(path: string, body?: unknown, method = "PUT") {
    const res = await fetch(path, {
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
  useEffect(() => {
    let alive = true;
    void (async () => {
      setMembers([]);
      if (!manager || selected === "anonymous") return;
      try {
        const data = await call(`/api/tenants/${selected}/members`);
        if (alive) setMembers(data.members);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, manager]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {manager && selected !== "anonymous" && (
          <section className="share-sec">
            <h2>{t("Workspace members")}</h2>
            <ul className="share-people">
              {members.map((m) => (
                <li key={m.user_id}>
                  <span>
                    {m.display_name || m.email || m.user_id} ·{" "}
                    {roleLabel(m.role)}
                  </span>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await call(`/api/tenants/${selected}/members`, {
                          userId: m.user_id,
                          role: null,
                        });
                        setMembers(
                          (await call(`/api/tenants/${selected}/members`))
                            .members,
                        );
                      })
                    }
                  >
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
            <div className="share-add">
              <input
                aria-label={t("Email address")}
                placeholder={t("Email address")}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
              <select
                aria-label={t("Workspace role")}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="member">{t("Member")}</option>
                <option value="admin">{t("Workspace administrator")}</option>
              </select>
              <button
                className="btn"
                disabled={busy || !userId}
                onClick={() =>
                  void act(async () => {
                    await call(`/api/tenants/${selected}/members`, {
                      email: userId,
                      role,
                    });
                    setMembers(
                      (await call(`/api/tenants/${selected}/members`)).members,
                    );
                  })
                }
              >
                {t("Save member")}
              </button>
            </div>
          </section>
        )}
        {platform && (
          <section className="share-sec">
            <h2>{t("Create workspace")}</h2>
            <div className="share-add">
              <input
                aria-label={t("Workspace ID")}
                placeholder={t("Workspace ID")}
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              />
              <input
                aria-label={t("Workspace name")}
                placeholder={t("Workspace name")}
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
              />
              <input
                aria-label={t("Administrator email")}
                placeholder={t("Administrator email")}
                value={adminId}
                onChange={(e) => setAdminId(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || !tenantId || !adminId || !tenantName}
                onClick={() =>
                  void act(async () => {
                    await call(
                      "/api/tenants",
                      { id: tenantId, name: tenantName, adminEmail: adminId },
                      "POST",
                    );
                    setTenants((await call("/api/tenants")).tenants);
                  })
                }
              >
                {t("Create")}
              </button>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
