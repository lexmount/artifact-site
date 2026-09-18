"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/use-auth";
import { initializeAnalytics, syncAnalyticsIdentity, track, trackPage } from "@/lib/analytics";

export default function Analytics({ measurementId, hosts }: { measurementId: string; hosts: string[] }) {
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!initializeAnalytics(measurementId, hosts)) return;
    trackPage();
    if (!document.getElementById("artifact-ga-tag")) {
      const script = document.createElement("script");
      script.id = "artifact-ga-tag";
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
      script.referrerPolicy = "no-referrer";
      script.onload = () => { if (window.artifactAnalytics) window.artifactAnalytics.loaded = true; };
      document.head.appendChild(script);
    }
  }, [measurementId, hosts, pathname]);

  useEffect(() => {
    if (!loading) syncAnalyticsIdentity(userId);
  }, [userId, loading, measurementId, hosts]);

  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const control = e.target.closest("[data-analytics-button], a[href]");
      let name = control?.getAttribute("data-analytics-button");
      if (!name && control instanceof HTMLAnchorElement) {
        const url = new URL(control.href);
        if (url.origin === window.location.origin && url.pathname === "/api/auth/login") name = "login";
      }
      if (["upload", "login", "share", "download", "update"].includes(name ?? "")) {
        track("ui_click", { button_name: name as "upload" | "login" | "share" | "download" | "update" });
      }
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);

  return null;
}
