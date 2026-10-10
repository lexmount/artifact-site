"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Folder, FileText, Search, Link2 } from "lucide-react";
import AppShell from "@/components/app-shell";
import { adminFetch } from "@/components/admin/format";
import { useT } from "@/components/locale-provider";
import { loginHref } from "@/lib/use-auth";
import { appPath } from "@/lib/app-path";
type Collection = {
  state: string;
  name?: string;
  owner?: string;
  items: {
    slug: string;
    title: string;
    tenantName: string;
    updatedAt: number;
    comments: boolean;
  }[];
};
export default function CollectionPage({ token }: { token: string }) {
  const t = useT(),
    [data, setData] = useState<Collection | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    adminFetch<Collection>(`/api/collections/${encodeURIComponent(token)}`)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [token]);
  return (
    <AppShell>
      <main className="collection-page">
        {error && (
          <p role="alert" className="drawer-error">
            {t(error)}
          </p>
        )}
        {!data && !error && (
          <div className="tenant-skeleton" aria-busy="true" />
        )}
        {data?.state === "ready" ? (
          <>
            <div className="collection-heading">
              <div className="scope-identity">
                <span>
                  <Folder />
                </span>
                <div>
                  <h1>
                    {data.name === "My entire collection"
                      ? t(data.name)
                      : data.name}
                  </h1>
                  <p>
                    {data.owner} ·{" "}
                    {t("{n} accessible documents", { n: data.items.length })}
                  </p>
                </div>
              </div>
              <label className="searchbox">
                <Search size={17} />
                <input
                  type="search"
                  placeholder={t("Search this collection")}
                  aria-label={t("Search this collection")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            <p className="scope-notice">
              {t("Only documents you can access are shown.")}
            </p>
            <div className="collection-list">
              {data.items
                .filter((s) =>
                  s.title.toLowerCase().includes(query.toLowerCase()),
                )
                .map((s) => (
                  <Link
                    className="collection-row"
                    key={s.slug}
                    href={`/s/${s.slug}?collection=${encodeURIComponent(token)}`}
                  >
                    <FileText size={20} />
                    <strong>{s.title}</strong>
                    <span>{s.tenantName}</span>
                    <time>{new Date(s.updatedAt).toLocaleDateString()}</time>
                    <span
                      className={s.comments ? "scope-badge" : "scope-muted"}
                    >
                      {t(s.comments ? "Can comment" : "Can view")}
                    </span>
                  </Link>
                ))}
            </div>
            {data.items.every(
              (s) => !s.title.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="scope-muted">{t("No documents match.")}</p>}
          </>
        ) : (
          data && (
            <div className="collection-empty">
              <Link2 size={32} />
              <h1>
                {t(
                  data.state === "login"
                    ? "Sign in to view this collection"
                    : data.state === "empty"
                      ? "No accessible documents"
                      : "Collection link disabled",
                )}
              </h1>
              <p>
                {t(
                  data.state === "unavailable"
                    ? "Contact the sharer for a new way to access these documents."
                    : "Documents in this collection use their own access permissions.",
                )}
              </p>
              {data.state === "login" && (
                <a
                  className="btn solid"
                  href={appPath(loginHref(`/c/${token}`))}
                >
                  {t("Sign in")}
                </a>
              )}
            </div>
          )
        )}
      </main>
    </AppShell>
  );
}
