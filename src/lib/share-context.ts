"use client";
import { appFetch, appPath, localPath } from "@/lib/app-path";
import { invalidateClientCaches } from "@/lib/client-cache";
/** Carry the explicit link credential only to our own site APIs, never to artifact code or other origins. */
export function withShareContext(path: string): string {
  if (typeof window === "undefined") return path;
  const token = new URL(window.location.href).searchParams.get("share");
  if (!token) return path;
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) return path;
  url.searchParams.set("share", token);
  return url.pathname + url.search;
}
export const siteFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const next = withShareContext(appPath(url));
  const response = await appFetch(
    input instanceof Request
      ? new Request(new URL(next, window.location.origin), input)
      : next,
    init,
  );
  const method=(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const pathname = localPath(new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname);
  const permissionRead = method === "POST" && /^\/api\/sites\/[^/]+\/permissions$/.test(pathname);
  if(response.ok && !["GET","HEAD"].includes(method) && !permissionRead)invalidateClientCaches();
  return response;
};
