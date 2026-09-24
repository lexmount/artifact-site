"use client";
import { useEffect, useState } from "react";
import type { SitePermissions } from "@/lib/authz";
import { useStoredToken } from "@/lib/edit-token";
import { siteFetch, withShareContext } from "@/lib/share-context";
import { useAuth } from "@/lib/use-auth";
import { RequestCache } from "@/lib/request-cache";
import { registerClientCache } from "@/lib/client-cache";
const requests = new RequestCache<SitePermissions>();
registerClientCache(() => requests.clear());
function acquire(slug: string, token: string, identity: string, exchange = true) {
  const path = withShareContext(`/api/sites/${slug}/permissions`);
  const method = token && exchange ? "POST" : "GET";
  return requests.acquire(
    JSON.stringify([identity, path, token, method]),
    async (signal) => {
      const res = await siteFetch(path, {
        method,
        headers: token ? { "x-edit-token": token } : {},
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.permissions) throw new Error("Invalid permission response");
      return body.permissions;
    },
  );
}
/** Server-provided permissions need no second fetch. All operations still authorize on the server. */
export function useSitePermissions(slug: string, initial?: SitePermissions) {
  const token = useStoredToken(slug) ?? "";
  const auth = useAuth();
  const key = JSON.stringify([slug, token, auth.user?.id, withShareContext("/")]);
  const [resolved, setResolved] = useState<{
    key: string;
    value: SitePermissions;
  } | null>(null);
  useEffect(() => {
    // A browser-only receipt may grant more than the server could see on a direct visit.
    if (auth.loading || (initial && (!token || initial.canEditContent))) return;
    let alive = true;
    const lease = acquire(slug, token, auth.user?.id ?? "anonymous");
    lease.promise
      .then((value) => {
        if (alive) setResolved({ key, value });
      })
      .catch(() => {});
    return () => {
      alive = false;
      lease.release();
    };
  }, [slug, token, auth.loading, auth.user?.id, initial, key]);
  return token && !initial?.canEditContent
    ? (resolved?.key === key ? resolved.value : initial)
    : initial ?? (resolved?.key === key ? resolved.value : undefined);
}
export function usePermissionsForSites(
  slugs: string[],
  tokens: Record<string, string>,
  initial?: Record<string, SitePermissions>,
) {
  const auth = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<{ key: string; slugs: string[] }>({
    key: "",
    slugs: [],
  });
  const key = JSON.stringify([
    auth.user?.id,
    slugs.map((slug) => [slug, tokens[slug] ?? ""]),
    withShareContext("/"),
  ]);
  const [resolved, setResolved] = useState<{
    key: string;
    values: Record<string, SitePermissions>;
  }>({ key: "", values: {} });
  useEffect(() => {
    if (initial || auth.loading) return;
    let alive = true;
    const [, pairs] = JSON.parse(key) as [string, [string, string][]];
    const leases = pairs.map(([slug, token]) => {
      // Listing verifies receipts without minting an editing cookie. Exchange only on opening.
      const lease = acquire(slug, token, auth.user?.id ?? "anonymous", false);
      lease.promise
        .then((value) => {
          if (alive)
            setResolved((prev) => ({
              key,
              values: {
                ...(prev.key === key ? prev.values : {}),
                [slug]: value,
              },
            }));
        })
        .catch(() => {
          if (alive)
            setFailed((prev) => ({
              key,
              slugs: [...(prev.key === key ? prev.slugs : []), slug],
            }));
        });
      return lease;
    });
    return () => {
      alive = false;
      for (const lease of leases) lease.release();
    };
  }, [key, initial, auth.loading, auth.user?.id, attempt]);
  return {
    permissions: initial ?? (resolved.key === key ? resolved.values : {}),
    failed: failed.key === key ? failed.slugs : [],
    retry: () => {
      setFailed({ key: "", slugs: [] });
      setAttempt((n) => n + 1);
    },
  };
}
