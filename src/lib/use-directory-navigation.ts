"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { DirectoryNavigation } from "@/lib/directory-navigation";
/** Search replaces history after a pause; paging/filtering includes the latest draft. */
export function useDirectoryNavigation() {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [navigation] = useState(() => new DirectoryNavigation(
    params.toString(),
    (query) => startTransition(() => router.replace(`${path}?${query}`, { scroll: false })),
    (value) => {
      const next = new URLSearchParams(window.location.search);
      next.set("view", value);
      window.history.replaceState(null, "", `${path}?${next}`);
      return next.toString();
    },
  ));
  const search = useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const view = useSyncExternalStore(navigation.subscribe, navigation.viewSnapshot, navigation.viewSnapshot);
  const urlQuery = params.toString();
  useEffect(() => { navigation.receive(urlQuery); }, [navigation, urlQuery]);
  useEffect(() => { if (!pending) navigation.finish(urlQuery); }, [navigation, pending, urlQuery]);
  useEffect(() => {
    const restore = () => navigation.receive(new URLSearchParams(window.location.search).toString(), true);
    window.addEventListener("popstate", restore);
    return () => { navigation.dispose(); window.removeEventListener("popstate", restore); };
  }, [navigation]);
  return { change: navigation.change.bind(navigation), search, view, pending, params };
}
