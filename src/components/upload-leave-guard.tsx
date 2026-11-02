"use client";
import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/components/confirm-dialog";
import { useT } from "@/components/locale-provider";

type Destination = { url: string; type: string; key?: string };
type HistoryNavigation = EventTarget & { traverseTo(key: string): { finished: Promise<unknown> } };

/** Protect transfer/commit only. Acknowledged background jobs no longer depend on this page. */
export function useUploadLeaveGuard(active: boolean, resumable: boolean) {
  const t = useT();
  const allowed = useRef(false);
  const [destination, setDestination] = useState<Destination | null>(null);
  useEffect(() => {
    if (!active) return;
    allowed.current = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (allowed.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (allowed.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.download || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href);
      if (!["http:", "https:"].includes(url.protocol) || (url.pathname === location.pathname && url.search === location.search && url.hash)) return;
      event.preventDefault(); event.stopPropagation(); setDestination({ url: url.href, type: "push" });
    };
    // Navigation API also covers browser Back and programmatic SPA navigation where supported.
    const navigation = (window as unknown as { navigation?: HistoryNavigation }).navigation;
    const navigate = (event: Event) => {
      const e = event as Event & { destination: { url: string; key: string }; hashChange: boolean; navigationType: string; downloadRequest?: string | null };
      if (allowed.current || !e.cancelable || e.hashChange || e.navigationType === "reload" || e.downloadRequest != null || !/^https?:/.test(e.destination.url)) return;
      e.preventDefault(); setDestination({ url: e.destination.url, type: e.navigationType, key: e.destination.key });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    navigation?.addEventListener("navigate", navigate);
    return () => {
      setDestination(null);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
      navigation?.removeEventListener("navigate", navigate);
    };
  }, [active]);
  const message = resumable
    ? t("Leaving will interrupt this upload. Return in this browser and select the same file to resume.")
    : t("Leaving will interrupt this upload. Keep this page open until submission is confirmed.");
  return {
    release: () => { allowed.current = true; },
    hint: active ? <p className="upload-leave-hint">{message}</p> : null,
    dialog: active && destination ? <ConfirmDialog title={t("Leave before uploading finishes?")} body={message}
      cancelPrimary cancelLabel={t("Continue uploading")} confirmLabel={t("Leave page")} onClose={() => setDestination(null)}
      onConfirm={async () => {
        allowed.current = true;
        try {
          if (destination.type === "traverse") {
            const navigation = (window as unknown as { navigation: HistoryNavigation }).navigation;
            await navigation.traverseTo(destination.key!).finished;
          } else if (destination.type === "replace") window.location.replace(destination.url);
          else window.location.assign(destination.url);
        } catch (error) { allowed.current = false; throw error; }
      }} /> : null,
  };
}
