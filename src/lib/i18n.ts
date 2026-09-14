// Minimal message translation. English is the source language: code calls `t("Upload")` with the
// English text itself as the key, and a locale dictionary maps that text to a translation. A
// missing entry falls back to the English key, so an untranslated string is never a crash and
// never a blank — it is just English. No build step, no extraction tool, no message ids to keep
// in sync: the key IS the English copy, which is also what reviewers read in the diff.
//
// Locale resolution lives elsewhere (i18n-server.ts for server components and route handlers,
// locale-provider.tsx for client components); this module is pure and safe to import anywhere.

export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie a viewer's explicit choice is remembered in; absent → Accept-Language → English. */
export const LOCALE_COOKIE = "ah_locale";

export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;

const dictionaries: Partial<Record<Locale, Messages>> = {};

/** Register (merge) a dictionary for a locale. Feature areas each contribute their own file so
 *  translations live next to the code they belong to and never conflict in a merge. */
export function registerMessages(locale: Locale, messages: Messages): void {
  dictionaries[locale] = { ...(dictionaries[locale] ?? {}), ...messages };
}

/** `{name}` placeholders are filled from params; an unknown placeholder is left as-is so a typo
 *  shows up in the UI instead of silently vanishing. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function translate(locale: Locale, key: string, params?: Params): string {
  const text = locale === DEFAULT_LOCALE ? key : (dictionaries[locale]?.[key] ?? key);
  return interpolate(text, params);
}

export type Translator = (key: string, params?: Params) => string;

/** "1 version" / "3 versions": English needs the singular/plural split, Chinese does not — both
 *  keys map to the same zh-CN text. `{n}` is the count in both keys. */
export function countText(t: Translator, count: number, one: string, other: string): string {
  return t(count === 1 ? one : other, { n: count });
}

/** Locale-aware calendar date (no time). The locale is the viewer's UI locale, so server and client
 *  render the same text — `toLocaleDateString()` with no argument would follow the machine instead. */
export function formatDate(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US");
}

export function translatorFor(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

/** Pick a supported locale from an explicit value (cookie / query) or an Accept-Language header. */
export function resolveLocale(explicit: string | null | undefined, acceptLanguage?: string | null): Locale {
  const fromExplicit = normalise(explicit);
  if (fromExplicit) return fromExplicit;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim();
    const l = normalise(tag);
    if (l) return l;
  }
  return DEFAULT_LOCALE;
}

function normalise(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (lower === "en" || lower.startsWith("en-")) return "en";
  // Only Simplified Chinese has a dictionary. Traditional (zh-TW / zh-HK / zh-Hant) is a
  // different written language, not a dialect of this one — it falls through to English rather
  // than being served Simplified text it did not ask for.
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg" || lower.startsWith("zh-hans")) return "zh-CN";
  return null;
}

/** Test/ops hook: forget every registered dictionary. */
export function __resetMessagesForTests(): void {
  for (const k of Object.keys(dictionaries)) delete dictionaries[k as Locale];
}
