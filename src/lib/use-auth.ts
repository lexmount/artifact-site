"use client";
// Client-side auth state. One shared fetch of /api/auth/me, cached per page load.
//
// `oidcEnabled` matters as much as `user`: with no IdP configured the product must look exactly
// as it did before identity existed, so every auth affordance hides rather than offering a login
// that cannot work.
import { useEffect, useState } from "react";

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

function load(): Promise<Loaded> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/auth/me")
      .then((r) => r.json())
      .then((body: { user?: MeUser | null; oidcEnabled?: boolean; isAdmin?: boolean }) => {
        cached = { user: body.user ?? null, oidcEnabled: Boolean(body.oidcEnabled), isAdmin: Boolean(body.isAdmin) };
        return cached;
      })
      .catch(() => ({ user: null, oidcEnabled: false, isAdmin: false }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cache after a login or logout so the header re-reads the real state. */
export function resetAuthCache(): void {
  cached = null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, oidcEnabled: false, isAdmin: false, loading: true });
  useEffect(() => {
    let alive = true;
    load().then((r) => { if (alive) setState({ ...r, loading: false }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/** Send the browser to the IdP, returning to wherever it is now. */
export function loginHref(returnTo?: string): string {
  const target = returnTo ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search);
  return `/api/auth/login?return_to=${encodeURIComponent(target)}`;
}
