import { type Translator, countText, formatDate, type Locale } from "@/lib/i18n";

/** "Just now" … "1 day ago" / "{n} days ago", then the date: how a list shows when something last
 *  changed. `now` is injectable so server and client agree on the text during hydration. */
export function relTime(ts: number, t: Translator, locale: Locale = "en", now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t("Just now");
  const m = Math.round(s / 60);
  if (m < 60) return countText(t, m, "{n} minute ago", "{n} minutes ago");
  const h = Math.round(m / 60);
  if (h < 24) return countText(t, h, "{n} hour ago", "{n} hours ago");
  const d = Math.round(h / 24);
  if (d < 30) return countText(t, d, "{n} day ago", "{n} days ago");
  return formatDate(ts, locale);
}
