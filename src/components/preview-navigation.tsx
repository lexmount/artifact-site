"use client";

import { appPath } from "@/lib/app-path";
import { useEffect, useState, type RefObject } from "react";
import ConfirmDialog from "@/components/confirm-dialog";
import { useT } from "@/components/locale-provider";
import { platformDestination } from "@/lib/preview-navigation";

/** Messages cannot prove user activation. A host-owned confirmation prevents forced navigation. */
export default function PreviewNavigation({ frameRef }: { frameRef: RefObject<HTMLIFrameElement | null> }) {
  const t = useT();
  const [destination, setDestination] = useState<{ path: string; newTab: boolean } | null>(null);
  useEffect(() => {
    // The opaque frame has no targetable origin. This capability announcement contains no data.
    const enable = () => frameRef.current?.contentWindow?.postMessage({ type: "artifact:platform-navigation-enabled" }, "*");
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== "null") return;
      if (event.data?.type === "artifact:platform-navigation-ready") { enable(); return; }
      if (!event.data || event.data.type !== "artifact:platform-navigation") return;
      const path = platformDestination(event.data.path);
      if (path) setDestination(current => current ?? { path, newTab: event.data.newTab === true });
    };
    window.addEventListener("message", receive);
    enable();
    return () => { window.removeEventListener("message", receive); };
  }, [frameRef]);
  if (!destination) return null;
  const { path, newTab } = destination;
  const viewer = /^\/(c|s|v)\//.test(path);
  const label = path === "/me" ? t("My sites") : path === "/explore" ? t("Explore") : t("Home");
  return <ConfirmDialog title={viewer ? path.startsWith("/c/") ? t("Open this collection?") : t("Open this artifact?") : t("Return to {destination}?", { destination: label })}
    body={t("Open the platform outside this preview using your current browser sign-in.")}
    confirmLabel={newTab ? t("Open in a new tab") : t("Continue")} onClose={() => setDestination(null)}
    onConfirm={async () => {
      if (newTab) window.open(appPath(path), "_blank", "noopener,noreferrer");
      else window.location.assign(appPath(path));
    }} />;
}
