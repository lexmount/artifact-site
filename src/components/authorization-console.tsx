"use client";
import { useEffect, useState } from "react";
import AuthorizationPanel, {
  authorizationFetch,
} from "@/components/authorization-panel";
import { useT } from "@/components/locale-provider";
export default function AuthorizationConsole() {
  const t = useT();
  const [type, setType] = useState<"site" | "tenant">("site");
  const [query, setQuery] = useState("");
  const [resources, setResources] = useState<
    {
      id: string;
      name: string;
      slug?: string;
    }[]
  >([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [activeReason, setActiveReason] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    authorizationFetch<{
      resources: {
        id: string;
        name: string;
        slug?: string;
      }[];
      nextCursor: string | null;
    }>(
      `/api/authorization/resources?type=${type}&q=${encodeURIComponent(query)}`,
      "",
    )
      .then((data) => {
        if (alive) {
          setResources(data.resources);
          setCursor(data.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [type, query]);
  async function more() {
    try {
      const data = await authorizationFetch<{
        resources: {
          id: string;
          name: string;
          slug?: string;
        }[];
        nextCursor: string | null;
      }>(
        `/api/authorization/resources?type=${type}&q=${encodeURIComponent(query)}&cursor=${cursor}`,
        "",
      );
      setResources((current) => [...current, ...data.resources]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Request failed"));
    }
  }
  return (
    <div className="authorization-console">
      <p>
        {t(
          "Choose a site or workspace, then assign roles to its members or a wider audience.",
        )}
      </p>
      {error && (
        <p role="alert" className="drawer-error">
          {error}
        </p>
      )}
      <div className="authorization-filters">
        <label>
          {t("Resource type")}
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as "site" | "tenant");
              setSelected("");
            }}
          >
            <option value="site">{t("Site")}</option>
            <option value="tenant">{t("Workspace")}</option>
          </select>
        </label>
        <label>
          {t("Find resource")}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search by name")}
          />
        </label>
        <label>
          {t("Resource")}
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">{t("Select a resource")}</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.slug ? ` · ${r.slug}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cursor && (
        <button className="btn" onClick={() => void more()}>
          {t("Load more")}
        </button>
      )}
      <form
        className="authorization-reason"
        onSubmit={(e) => {
          e.preventDefault();
          setActiveReason(reason.trim());
        }}
      >
        <label>
          {t("Management reason")}
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Why are you changing access?")}
          />
        </label>
        <button className="btn" disabled={!selected || !reason.trim()}>
          {t("Manage authorization")}
        </button>
      </form>
      {selected && activeReason && (
        <AuthorizationPanel
          key={`${type}:${selected}:${activeReason}`}
          resource={{ type, id: selected }}
          reason={activeReason}
        />
      )}
    </div>
  );
}
