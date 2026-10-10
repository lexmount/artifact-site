import "server-only";
import { config } from "@/lib/config";
import { appBasePath } from "@/lib/app-path";
import { forwardedProto, type HeaderBag } from "@/lib/http";

/** Explicit endpoints, not origins: a path is part of the deployment's identity. */
export function parsePublicUrl(raw: string): string {
  const value = raw.trim();
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      !/^(?:\/[a-zA-Z0-9_-]+)*$/.test(url.pathname === "/" ? "" : url.pathname) ||
      url.href.replace(/\/$/, "") !== value) throw new Error("Public URLs must be normalized http(s) addresses with an optional path and no credentials, query or fragment");
  return value;
}

export function baseFromHeaders(headers: HeaderBag, fallback?: string): string | null {
  // Every durable link, callback and OAuth issuer uses the one configured address.
  if (config.publicUrl) return parsePublicUrl(config.publicUrl);
  const url = fallback ? new URL(fallback) : null;
  const host = headers.get("host") || url?.host;
  if (!host || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(host)) {
    return null;
  }
  const protocol = forwardedProto(headers) || url?.protocol.slice(0, -1) || "http";
  if (protocol !== "https" && protocol !== "http") throw new Error("Invalid public protocol");
  const candidate = `${protocol}://${host.toLowerCase()}${appBasePath()}`;
  return candidate;
}

export function requestBase(request: Request): string {
  return baseFromHeaders(request.headers, request.url) ?? new URL(request.url).origin + appBasePath();
}
