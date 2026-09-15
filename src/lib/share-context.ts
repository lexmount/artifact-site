"use client";
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
export const siteFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const next = withShareContext(url);
  return globalThis.fetch(
    input instanceof Request
      ? new Request(new URL(next, window.location.origin), input)
      : next,
    init,
  );
};
