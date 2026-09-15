"use client";

import { siteFetch } from "@/lib/share-context";

/** Header credentials never enter a download URL or the artifact's iframe. */
export async function fetchSiteDownload(slug: string, version: string | undefined, headers: HeadersInit = {}) {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const response = await siteFetch(`/api/sites/${encodeURIComponent(slug)}/export${query}`, { headers, cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let filename = `${slug}.zip`;
  if (encoded) {
    try { filename = decodeURIComponent(encoded); } catch { /* Use the safe fallback. */ }
  }
  return { blob: await response.blob(), filename };
}

export async function downloadSite(slug: string, version: string | undefined, headers: HeadersInit = {}) {
  const { blob, filename } = await fetchSiteDownload(slug, version, headers);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Allow the browser to start consuming the object before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
