"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
/** Local Performance timeline only: no URLs, account data or telemetry sent to a third party. */
export default function NavigationMetrics() {
  const path = usePathname();
  useEffect(() => {
    const mark = () => {
      performance.clearMarks("artifact:navigation-start");
      performance.mark("artifact:navigation-start");
    };
    const click = (e: MouseEvent) => {
      if (
        !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0 &&
        e.target instanceof Element &&
        e.target.closest('.site-header a[href^="/"]')
      )
        mark();
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  useEffect(() => {
    if (performance.getEntriesByName("artifact:navigation-start").length) {
      performance.clearMeasures("artifact:navigation-commit");
      performance.measure(
        "artifact:navigation-commit",
        "artifact:navigation-start",
      );
      performance.clearMarks("artifact:navigation-start");
    }
  }, [path]);
  return null;
}
