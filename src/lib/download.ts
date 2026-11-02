"use client";

import { siteFetch } from "@/lib/share-context";

/** Header credentials never enter a download URL or the artifact's iframe. */
async function requestDownload(slug: string, version: string | undefined, headers: HeadersInit, direct = false) {
  const query = (version ? `?version=${encodeURIComponent(version)}` : "") + (direct ? `${version ? "&" : "?"}delivery=direct` : "");
  const response = await siteFetch(`/api/sites/${encodeURIComponent(slug)}/download${query}`, { headers, cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${response.status})`);
  }
  return response;
}

async function downloadBlob(response: Response, slug: string) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let filename = `${slug}.zip`;
  if (encoded) {
    try { filename = decodeURIComponent(encoded); } catch { /* Use the safe fallback. */ }
  }
  return { blob: await response.blob(), filename };
}

export async function fetchSiteDownload(slug: string, version: string | undefined, headers: HeadersInit = {}) {
  return downloadBlob(await requestDownload(slug, version, headers), slug);
}

export async function downloadSite(slug: string, version: string | undefined, headers: HeadersInit = {}, onTransferError?: () => void) {
  const response = await requestDownload(slug, version, headers, true);
  if (response.headers.get("content-type")?.includes("application/json")) {
    const { url } = await response.json();
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid download URL");
    // A separate, opaque context avoids editor beforeunload and contains storage error pages.
    // This is not the uploaded-content preview: no scripts, same-origin access or top navigation.
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-downloads");
    frame.setAttribute("aria-hidden", "true");
    frame.referrerPolicy = "no-referrer";
    frame.src = target.href;
    // An attachment is handed to the browser without loading a document. A loaded document
    // instead is an error/blocked download; it cannot replace the application or run scripts.
    frame.onload = () => { frame.remove(); onTransferError?.(); };
    document.body.append(frame);
    // Once attachment headers arrive, the browser owns the transfer independently of this frame.
    window.setTimeout(() => frame.remove(), 300_000);
    return;
  }
  const { blob, filename } = await downloadBlob(response, slug);
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
