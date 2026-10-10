"use client";
import { appPath } from "@/lib/app-path";
// Client-side auth state, shared across account controls and revalidated on navigation.
//
// `oidcEnabled` matters as much as `user`: with no IdP configured the product must look exactly
// as it did before identity existed, so every auth affordance hides rather than offering a login
// that cannot work.
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import {
  getAuthSnapshot, initialAuth, refreshAuth, subscribeAuth,
  resetAuthCache as invalidateAuth,
  type AuthState,
} from "@/lib/auth-store";
export type { AuthState, MeUser } from "@/lib/auth-store";

const subscribe = subscribeAuth;
const getClientSnapshot = getAuthSnapshot;
const loadingSnapshot = initialAuth;
function getServerSnapshot(): AuthState { return loadingSnapshot; }
/** Recheck identity and invalidate cached capabilities after explicit account changes. */
export function resetAuthCache(): void {
  invalidateAuth();
  void refreshAuth();
}

export function useAuth(): AuthState {
  const path = usePathname();
  const state = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  useEffect(() => { void refreshAuth(); }, [path]);
  return state;
}

/** Send the browser to the IdP, returning to wherever it is now. */
export function loginHref(returnTo?: string): string {
  const target = returnTo ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search);
  return appPath(`/api/auth/login?return_to=${encodeURIComponent(target)}`);
}
