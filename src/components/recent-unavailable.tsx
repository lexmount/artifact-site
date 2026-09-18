"use client";
import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { forgetRecentEntrance } from "@/lib/recent";
import { updateRecent } from "@/lib/recent-store";

/** Mounted only by an unavailable viewer, never login/passcode prompts or prefetches. */
function ForgetUnavailable() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    void updateRecent(items => forgetRecentEntrance(items, pathname, search));
  }, [pathname, search]);
  return null;
}

export default function RecentUnavailable() {
  return <Suspense fallback={null}><ForgetUnavailable /></Suspense>;
}
