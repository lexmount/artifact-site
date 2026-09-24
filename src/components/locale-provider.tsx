"use client";

// Client half of i18n: the root layout resolves the locale on the server and hands it down here,
// so client components render the same language on the server and after hydration. Without a
// provider (unit tests, storybook-style isolation) `useT` is plain English — never a crash.
import { createContext, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, URL_LOCALE_COOKIE, translatorFor, type Locale, type Translator } from "@/lib/i18n";
import "@/locales";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): Translator {
  const locale = useLocale();
  return useMemo(() => translatorFor(locale), [locale]);
}

/** Remember an explicit choice for a year and reload so server-rendered copy follows. */
export function setLocaleCookie(locale: Locale): void {
  // `Secure` only over HTTPS: a plain-http deployment (an IP behind a load balancer, say) would
  // otherwise never get the cookie back and the switch would appear to do nothing.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  document.cookie = `${URL_LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  const url = new URL(window.location.href);
  // A URL override is intentionally stronger than the saved preference. Remove it when the user
  // explicitly chooses a language, otherwise the menu would appear to do nothing after reload.
  const hadOverride = url.searchParams.has("lang");
  url.searchParams.delete("lang");
  if (hadOverride) window.location.assign(url.toString());
  else window.location.reload();
}
