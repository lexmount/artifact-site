"use client";
import { usePathname } from "next/navigation";
import AppShell from "@/components/app-shell";
import type { ReactNode } from "react";
/** Lives in the root layout so navigation does not unmount the common header. */
export default function NavigationShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return ["/", "/me", "/explore", "/for-agents"].includes(path) ||
    path.startsWith("/for-agents/") ? (
    <AppShell>{children}</AppShell>
  ) : (
    children
  );
}
