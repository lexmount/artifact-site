"use client";

// The application shell: one horizontal header — wordmark, primary navigation, then the quiet
// language control and the account — and the page. Black on near-white, one hairline under the header, nothing else. The
// viewer (/s, /v) keeps its own full-screen chrome because there the artifact is the page.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import AuthButton from "@/components/auth-button";
import { setLocaleCookie, useLocale, useT } from "@/components/locale-provider";
import { LOCALES } from "@/lib/i18n";
import { useAuth } from "@/lib/use-auth";

/** EN | 中文 as one capsule: the current language is the green half, the other is one click away. */
function LanguageMenu() {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="lang-switch" role="group" aria-label={t("Choose a language")}>
      {LOCALES.map((l) => (
        <button key={l} type="button" aria-pressed={locale === l} onClick={() => { if (l !== locale) setLocaleCookie(l); }} lang={l === "zh-CN" ? "zh-CN" : "en"}>
          {l === "zh-CN" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}

export default function AppShell({ children, section }: { children: ReactNode; section?: "admin" }) {
  const t = useT();
  const path = usePathname();
  // One cached fetch per page load, shared with the account button below.
  const { isAdmin, user, oidcEnabled } = useAuth();

  const nav: { href: string; label: string; active: boolean }[] = [
    { href: "/", label: t("Home"), active: path === "/" },
    { href: "/explore", label: t("Explore"), active: path.startsWith("/explore") },
    { href: "/me", label: t("My sites"), active: path.startsWith("/me") },
    { href: "/for-agents", label: t("Agent guide"), active: path.startsWith("/for-agents") },
  ];
  if (isAdmin && section !== "admin") nav.push({ href: "/admin", label: t("Administration"), active: false });

  return (
    <>
      <header className="site-header">
        <Link className="brand" href="/" aria-label={t("artifact-site home")}>
          {/* The wordmark is a bitmap for now (the designer's), at 2× the 205×68 slot. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a static wordmark, served as is */}
          <img src="/brand/logo.png" alt="artifact-site" width={205} height={68} />
        </Link>
        {section === "admin" ? (
          <>
            <span className="header-section">{t("Administration")}</span>
            <nav aria-label={t("Navigation")}>
              <Link href="/">{t("Back to sites")}</Link>
            </nav>
          </>
        ) : (
          <nav aria-label={t("Navigation")}>
            {nav.map(({ href, label, active }) => (
              <Link key={href} href={href} className={[active && "active", href === "/admin" && user && oidcEnabled && "nav-admin-desktop"].filter(Boolean).join(" ") || undefined} aria-current={active ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
        )}
        <LanguageMenu />
        <AuthButton variant="avatar" />
      </header>
      <main className={`page-main${section === "admin" ? " page-admin" : ""}`}>{children}</main>
      <footer className="page-footer">
        <span>artifact-site</span>
        {/* The in-product guide: file limits, the full publishing spec, the machine-readable version. */}
        <Link href="/for-agents">{t("Help & docs")}</Link>
      </footer>
    </>
  );
}
