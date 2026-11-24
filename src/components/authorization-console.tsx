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
  const [reference, setReference] = useState("");
  const [lookupReason, setLookupReason] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [known, setKnown] = useState<{ id: string; name: string } | null>(null);
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
          "Choose a site you own or have been directly granted administrator access to, or a workspace, then assign roles.",
        )}
      </p>
      <form className="admin-known-site" onSubmit={async event => {
        event.preventDefault(); setLookupBusy(true); setError(""); setSelected(""); setKnown(null); setActiveReason("");
        try {
          const data = await authorizationFetch<{ resources: { id: string; name: string }[] }>(`/api/authorization/resources?type=site&exact=${encodeURIComponent(reference)}`, lookupReason);
          const resource = data.resources[0];
          setType("site"); setSelected(resource.id); setKnown(resource); setActiveReason(lookupReason.trim());
        } catch (err) { setError(err instanceof Error ? err.message : t("Request failed")); }
        finally { setLookupBusy(false); }
      }}>
        <p>{t("Manage a known site by its exact address or ID. The lookup requires a reason and is audited.")}</p>
        <label>{t("Site address, slug or ID")}<input required maxLength={2048} value={reference} disabled={lookupBusy} onChange={event => { setReference(event.target.value); if (known) { setKnown(null); setSelected(""); setActiveReason(""); } }} /></label>
        <label>{t("Management reason")}<input required maxLength={500} value={lookupReason} disabled={lookupBusy} onChange={event => { setLookupReason(event.target.value); if (known) { setKnown(null); setSelected(""); setActiveReason(""); } }} /></label>
        <button className="btn" disabled={lookupBusy || !reference.trim() || !lookupReason.trim()}>{t("Load known site")}</button>
        {known && <p role="status">{known.name} · <code>{known.id}</code></p>}
      </form>
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
              setKnown(null); setActiveReason("");
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
            onChange={(e) => { setSelected(e.target.value); setKnown(null); setActiveReason(""); }}
          >
            <option value="">{t("Select a resource")}</option>
            {known && !resources.some(resource => resource.id === known.id) && <option value={known.id}>{known.name}</option>}
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
