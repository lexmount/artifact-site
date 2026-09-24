"use client";
import { createContext, useContext, type ReactNode } from "react";

// These are display hints only, never authentication evidence or cookie values.
const AuthConfigured = createContext({ enabled: false, hasSessionHint: false });
export function AuthConfigProvider({ enabled, hasSessionHint, children }: { enabled: boolean; hasSessionHint: boolean; children: ReactNode }) {
  return <AuthConfigured.Provider value={{ enabled, hasSessionHint }}>{children}</AuthConfigured.Provider>;
}
export function useAuthConfig() { return useContext(AuthConfigured); }
