// Locale resolution on the server: server components and route handlers. Reads the viewer's
// cookie, then Accept-Language. Kept apart from i18n.ts so that module stays importable from
// client code (next/headers is server-only).
import { cookies, headers } from "next/headers";
import { readCookie } from "@/lib/http";
import { LOCALE_COOKIE, URL_LOCALE_COOKIE, URL_LOCALE_HEADER, resolveLocale, translatorFor, type Locale, type Translator } from "@/lib/i18n";
import "@/locales";

export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale(h.get(URL_LOCALE_HEADER) ?? c.get(URL_LOCALE_COOKIE)?.value ?? c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}

export async function getT(): Promise<Translator> {
  return translatorFor(await getLocale());
}

/** For route handlers that already hold the Request (no need for next/headers). */
export function localeFromRequest(request: Request): Locale {
  return resolveLocale(readCookie(request, URL_LOCALE_COOKIE) ?? readCookie(request, LOCALE_COOKIE), request.headers.get("accept-language"));
}
