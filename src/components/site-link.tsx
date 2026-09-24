"use client";
import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { useStoredToken } from "@/lib/edit-token";
import { siteFetch } from "@/lib/share-context";

/** Exchange only the actively opened receipt before SSR, including after cookie eviction. */
export default function SiteLink({ slug, href, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { slug: string; href: string }) {
  const token = useStoredToken(slug);
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!token || event.defaultPrevented || event.button > 1) return;
    event.preventDefault();
    const separate = event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey || props.target === "_blank";
    const tab = separate ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    try {
      await siteFetch(`/api/sites/${slug}/permissions`, { method: "POST", headers: { "x-edit-token": token } });
    } catch {
      // Let the destination render its normal access/network error.
    } finally {
      // Full navigation avoids a prefetched permission-denied response from before the exchange.
      if (tab) tab.location.href = href;
      else if (!separate) window.location.assign(href);
    }
  };
  return <Link {...props} href={href} prefetch={props.prefetch ?? false} onClick={e => { void open(e); }} onAuxClick={e => { if (e.button === 1) void open(e); }} />;
}
