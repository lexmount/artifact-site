// Small display helpers for the administration console (client side).
import type { Locale } from "@/lib/i18n";

/** 0 → "0 B", 1536 → "1.5 KB", … up to TB. Digits kept short: this sits in a table column. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatWhen(ts: number | null, locale: Locale): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * fetch() against /api/admin/*: JSON in, JSON out, the server's `error` line as the thrown message.
 * CSRF: the server's csrfSafe() wants a same-origin `Origin` on every cookie-authenticated write.
 * Browsers attach it themselves on non-GET requests (and `Origin` is a forbidden header name —
 * a script cannot set it), so nothing is added here; a non-browser caller would have to send it.
 */
export async function adminFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}
