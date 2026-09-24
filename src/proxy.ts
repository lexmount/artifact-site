import { NextResponse, type NextRequest } from "next/server";
import { localeFromSearch, URL_LOCALE_COOKIE, URL_LOCALE_HEADER } from "@/lib/i18n";

/** Carry the query override into Server Components and the current browser session. */
export function proxy(request: NextRequest) {
  const locale = localeFromSearch(request.nextUrl.search);
  const requestHeaders = new Headers(request.headers);
  // This is an internal transport header: never trust a value supplied by the client.
  requestHeaders.delete(URL_LOCALE_HEADER);
  if (locale) requestHeaders.set(URL_LOCALE_HEADER, locale);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Keep the override coherent across client-side navigation. This is deliberately a session
  // cookie: following somebody's localized URL must not permanently replace a saved preference.
  if (locale) response.cookies.set(URL_LOCALE_COOKIE, locale, { sameSite: "lax", path: "/" });
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|vendor).*)"],
};
