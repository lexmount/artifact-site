"use client";

import { useEffect, useState, type RefObject } from "react";
import ConfirmDialog from "@/components/confirm-dialog";
import { useT } from "@/components/locale-provider";
import { platformDestination } from "@/lib/preview-navigation";

/** Messages cannot prove user activation. A host-owned confirmation prevents forced navigation. */
export default function PreviewNavigation({ frameRef }: { frameRef: RefObject<HTMLIFrameElement | null> }) {
  const t = useT();
  const [destination, setDestination] = useState<ReturnType<typeof platformDestination>>(null);
  useEffect(() => {
    // The opaque frame has no targetable origin. This capability announcement contains no data.
    const enable = () => frameRef.current?.contentWindow?.postMessage({ type: "artifact:platform-navigation-enabled" }, "*");
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== "null") return;
      if (event.data?.type === "artifact:platform-navigation-ready") { enable(); return; }
      if (!event.data || event.data.type !== "artifact:platform-navigation") return;
      const path = platformDestination(event.data.path);
      if (path) setDestination(current => current ?? path);
    };
    window.addEventListener("message", receive);
    enable();
    return () => { window.removeEventListener("message", receive); };
  }, [frameRef]);
  if (!destination) return null;
  const label = destination === "/me" ? t("My sites") : destination === "/explore" ? t("Explore") : t("Home");
  return <ConfirmDialog title={t("Return to {destination}?", { destination: label })}
    body={t("Open the platform outside this preview using your current browser sign-in.")}
    confirmLabel={t("Continue")} onClose={() => setDestination(null)}
    onConfirm={async () => { window.location.assign(destination); }} />;
}
