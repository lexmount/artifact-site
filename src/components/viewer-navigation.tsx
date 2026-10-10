"use client";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { appPath, localPath } from "@/lib/app-path";
import { entryTrail, prepareViewerNavigation, returnTrail, takeViewerHandoff, viewerFamily, type ViewerEntry } from "@/lib/viewer-return";

/** Each history entry owns its return chain; returning consumes one level. */
export default function ViewerNavigation() {
  const pathname = usePathname(), search = useSearchParams();
  const previous = useRef<ViewerEntry | null>(null);
  useEffect(() => {
    const restore = () => {
      const href = window.location.href, family = viewerFamily(href);
      const handoff = takeViewerHandoff(href);
      const trail = family ? entryTrail(href, history.state?.artifactViewerReturn, handoff, previous.current) : [];
      if (family) {
        history.replaceState({ ...history.state, artifactViewerReturn: {family, trail}, artifactReturnTo: trail[0] ?? null }, "");
      }
      previous.current = { href, trail };
      window.dispatchEvent(new Event("artifact:return-changed"));
    };
    restore();
    // Entries may share the same pathname/query, so route hooks alone are insufficient.
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => { window.removeEventListener("popstate", restore); window.removeEventListener("hashchange", restore); };
  }, [pathname, search]);
  useEffect(() => {
    const remember = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || event.button > 1 || anchor.hasAttribute("download")) return;
      prepareViewerNavigation(anchor.href, anchor.hasAttribute("data-viewer-return"));
    };
    document.addEventListener("click", remember, true);
    document.addEventListener("auxclick", remember, true);
    return () => { document.removeEventListener("click", remember, true); document.removeEventListener("auxclick", remember, true); };
  }, []);
  return null;
}

export function viewerReturnDestination(): string {
  const state = history.state?.artifactViewerReturn;
  return (state?.family === viewerFamily(window.location.href) ? returnTrail(state.trail, window.location.href)[0] : null) ?? appPath("/");
}

const subscribeReturn = (notify: () => void) => {
  window.addEventListener("artifact:return-changed", notify);
  return () => window.removeEventListener("artifact:return-changed", notify);
};
const readReturn = () => localPath(viewerReturnDestination());
export function ViewerBackLink({ children, label }: { children: ReactNode; label: string }) {
  const href = useSyncExternalStore(subscribeReturn, readReturn, () => "/");
  return <Link className="brand" data-viewer-return href={href} prefetch={false} aria-label={label}>{children}</Link>;
}
