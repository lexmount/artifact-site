"use client";
import { invalidateClientCaches } from "@/lib/client-cache";
// Client-side auth state. One shared fetch of /api/auth/me, cached per page load.
//
// `oidcEnabled` matters as much as `user`: with no IdP configured the product must look exactly
// as it did before identity existed, so every auth affordance hides rather than offering a login
// that cannot work.
import { useEffect, useSyncExternalStore } from "react";

export interface MeUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AuthState {
  user: MeUser | null;
  oidcEnabled: boolean;
  /** This account is an administrator (ARTIFACT_ADMIN_EMAILS). Decides one menu entry; the console re-checks server-side. */
  isAdmin: boolean;
  loading: boolean;
}

type Loaded = { user: MeUser | null; oidcEnabled: boolean; isAdmin: boolean };
let cached: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;
let generation = 0;
const loadingSnapshot: AuthState = { user: null, oidcEnabled: false, isAdmin: false, loading: true };
let clientSnapshot: AuthState = loadingSnapshot;
const listeners = new Set<() => void>();

function publish(result: Loaded): void {
  clientSnapshot = { ...result, loading: false };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getClientSnapshot(): AuthState { return clientSnapshot; }
function getServerSnapshot(): AuthState { return loadingSnapshot; }

function load(): Promise<Loaded> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    const started = generation;
    inflight = fetch("/api/auth/me")
      .then((r) => r.json())
      .then((body: { user?: MeUser | null; oidcEnabled?: boolean; isAdmin?: boolean }) => {
        const result = { user: body.user ?? null, oidcEnabled: Boolean(body.oidcEnabled), isAdmin: Boolean(body.isAdmin) };
        if (started === generation) { cached = result; publish(result); }
        return result;
      })
      .catch(() => {
        const unavailable = { user: null, oidcEnabled: false, isAdmin: false };
        if (started === generation) publish(unavailable);
        return unavailable;
      })
      .finally(() => { if (started === generation) inflight = null; });
  }
  return inflight;
}

/** Drop the cache after a login or logout so the header re-reads the real state. */
export function resetAuthCache(): void {
  generation += 1;
  inflight = null;
  cached = null;
  clientSnapshot = loadingSnapshot;
  for (const listener of listeners) listener();
  invalidateClientCaches();
  void load();
}

export function useAuth(): AuthState {
  // Hydration uses the stable server snapshot, while later client-side mounts can synchronously
  // reuse the resolved snapshot instead of flashing the loading placeholder on every navigation.
  const state = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  useEffect(() => {
    void load();
  }, []);
  return state;
}

/** Send the browser to the IdP, returning to wherever it is now. */
export function loginHref(returnTo?: string): string {
  const target = returnTo ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search);
  return `/api/auth/login?return_to=${encodeURIComponent(target)}`;
}
