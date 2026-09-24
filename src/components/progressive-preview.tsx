"use client";
import { useEffect, useRef, useState } from "react";
import ArtifactCover from "@/components/artifact-cover";
import { previewQueue } from "@/lib/preview-queue";
import { useT } from "@/components/locale-provider";
import type { SiteSummary } from "@/lib/types";

/** Keep the fast metadata cover until a visible card has remained on screen. */
export default function ProgressivePreview({ site, src }: { site: SiteSummary; src: string }) {
  // Removing the active child releases its queue slot and discards stale loading state.
  // Restoring the site mounts a fresh attempt that must pass the dwell and queue again.
  if (site.takenDownAt) return <div className="progressive-preview" data-preview-state="cover"><ArtifactCover site={site} /></div>;
  return <ActivePreview key={src} site={site} src={src} />;
}

function ActivePreview({ site, src }: { site: SiteSummary; src: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const finish = useRef<(() => void) | null>(null);
  const [state, setState] = useState<"cover" | "loading" | "ready">("cover");
  useEffect(() => {
    if (!host.current || !window.IntersectionObserver) return;
    let visible = false, complete = false, disposed = false;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const stop = () => {
      clearTimeout(dwell);
      clearTimeout(timeout);
      cancel?.(); cancel = undefined;
      finish.current?.(); finish.current = null;
      if (!complete && !disposed) setState("cover");
    };
    const schedule = () => {
      stop();
      if (!visible || document.hidden || complete || disposed) return;
      dwell = setTimeout(() => {
        cancel = previewQueue.enqueue(done => {
          if (disposed || !visible || document.hidden) { done(); return; }
          finish.current = () => { clearTimeout(timeout); done(); };
          setState("loading");
          timeout = setTimeout(() => {
            complete = true; // A failed/slow preview must not retry forever.
            setState("cover");
            finish.current?.(); finish.current = null;
          }, 10000);
        });
      }, 1500);
    };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!link || link.getAttribute("target") === "_blank" || link.hasAttribute("download")) return;
      const url = new URL((link as HTMLAnchorElement).href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      stop();
      complete = true;
    };
    document.addEventListener("click", navigate, true);
    const observer = new IntersectionObserver(entries => {
      const next = entries[entries.length - 1]?.isIntersecting ?? false;
      if (next !== visible) { visible = next; schedule(); }
    });
    observer.observe(host.current);
    document.addEventListener("visibilitychange", schedule);
    // Success and error both settle this attempt: failures intentionally do not auto-retry.
    const loaded = () => { complete = true; finish.current?.(); finish.current = null; };
    host.current.addEventListener("preview-settled", loaded);
    const element = host.current;
    return () => {
      disposed = true; stop(); observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("click", navigate, true);
      element.removeEventListener("preview-settled", loaded);
    };
  }, [src]);
  return <div ref={host} className="progressive-preview" data-preview-state={state}>
    <ArtifactCover site={site} />
    {state !== "cover" && <iframe src={src} title={t("{title} preview", { title: site.title })}
      tabIndex={-1} inert sandbox="" aria-hidden="true"
      style={{ opacity: state === "ready" ? 1 : 0 }}
      onLoad={() => { setState("ready"); host.current?.dispatchEvent(new Event("preview-settled")); }}
      onError={() => { setState("cover"); host.current?.dispatchEvent(new Event("preview-settled")); }} />}
  </div>;
}
