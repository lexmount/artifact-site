import { type Translator, formatDate, type Locale } from "@/lib/i18n";

/** "Just now" … "{n} days ago", then the date: how a list shows when something last changed. */
export function relTime(ts: number, t: Translator, locale: Locale = "en"): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t("Just now");
  const m = Math.round(s / 60);
  if (m < 60) return t("{n} minutes ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n} hours ago", { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return t("{n} days ago", { n: d });
  return formatDate(ts, locale);
}
