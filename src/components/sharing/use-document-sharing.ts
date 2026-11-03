"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/app-path";
import { invalidateClientCaches } from "@/lib/client-cache";
import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";
import type { DocumentSharingState } from "./main-sharing-model";

/** Main policy and counts stay mounted across the member/link subpanels. */
export function useDocumentSharing(slug: string, enabled: boolean) {
  const [data, setData] = useState<DocumentSharingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(true);
  const generation = useRef({ version: 0 }), writing = useRef(false), validated = useRef(false);
  const endpoint = `/api/sites/${encodeURIComponent(slug)}/main-sharing`;
  const load = useCallback(async () => {
    if (writing.current) return;
    validated.current = false;
    setUnavailable(true);
    const version = ++generation.current.version;
    try {
      const response = await appFetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not refresh access. Retry before changing settings.");
      const next: DocumentSharingState = await response.json();
      if (version !== generation.current.version) return;
      validated.current = true;
      setData(next);
      setUnavailable(false);
      setError("");
    } catch (e) {
      if (version !== generation.current.version) return;
      setUnavailable(true);
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [endpoint]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const lifecycle = generation.current;
    void (async () => { await load(); })();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("artifact:shares-changed", refresh);
    return () => {
      validated.current = false;
      lifecycle.version++;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("artifact:shares-changed", refresh);
    };
  }, [enabled, load]);
  async function save(action: "custom" | "follow" | "stop" | "reset-passcode", policy?: SharingPolicy) {
    if (!enabled || writing.current || !validated.current || unavailable || !data) return null;
    writing.current = true;
    const version = ++generation.current.version;
    setBusy(true);
    setError("");
    try {
      const response = await appFetch(endpoint, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedRevision: data.revision, ...(action === "custom" ? { policy } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setData(null);
        if ([401, 403, 404, 409].includes(response.status)) { validated.current = false; setUnavailable(true); }
        throw new Error(result.error || "Request failed");
      }
      if (version !== generation.current.version) return null;
      const saved = result as SharingState & { passcode: string | null };
      // A metadata refresh failure must never disguise an already committed change as a failed save.
      setData({ ...data, ...saved, ...(action === "stop" ? { links: 0, members: 0 } : {}) });
      invalidateClientCaches();
      return saved;
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Request failed";
      setError(detail);
      throw e;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return { data, busy, error, unavailable: !enabled || unavailable, load, save };
}
export type DocumentSharingController = ReturnType<typeof useDocumentSharing>;
