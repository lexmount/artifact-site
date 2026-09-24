"use client";
// Header auth affordance. Renders NOTHING while no IdP is configured — an unconfigured deployment
// should be indistinguishable from the product before identity existed, not show a dead button.
//
// Signed in, this is ONE control, not two: the name is the button, and "Sign out" lives in the menu it
// opens. That shape is what leaves room for "User settings" and everything else that will want to hang off
// an identity — a second top-level button per account action does not scale, and "Sign out" sitting
// permanently in the toolbar gives the least-used action the most prominent slot.
import { setAnalyticsUser } from "@/lib/analytics";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Check, ChevronDown, ChevronRight, Globe2, LogIn, LogOut, ShieldCheck, User2 } from "lucide-react";
import { loginHref, resetAuthCache, useAuth } from "@/lib/use-auth";
import { setLocaleCookie, useLocale, useT } from "@/components/locale-provider";
import { useAuthConfig } from "@/components/auth-config-provider";

const AUTH_ARRIVAL_STATE_KEY = "artifact-site:auth-arrival-state";

/** Keep the playful arrival tied to an actual account-state reveal, not routine navigation. */
export function shouldAnimateAuthArrival(path: string, current: string, previous: string | null): boolean {
  if (path !== "/") return false;
  if (current === "signed-out") return previous !== null && previous !== current;
  return previous !== current;
}

function AuthArrival({ path, current, children }: { path: string; current: string; children: (animate: boolean) => ReactNode }) {
  // useAuth exposes its loading server snapshot during SSR and hydration, so AuthArrival is first
  // mounted in the browser after the account request resolves. Decide once at that mount: routine
  // route changes neither hide the control for a frame nor replay the arrival animation.
  const [animate] = useState(() => {
    let previous: string | null = null;
    try {
      previous = window.sessionStorage.getItem(AUTH_ARRIVAL_STATE_KEY);
    } catch {
      // Storage can be unavailable; a first signed-in reveal still gets home-page feedback.
    }
    return shouldAnimateAuthArrival(path, current, previous);
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(AUTH_ARRIVAL_STATE_KEY, current);
    } catch {
      // The animation is optional; account access must not depend on browser storage.
    }
  }, [current]);

  return children(animate && path === "/");
}

export default function AuthButton({ variant = "button" }: { variant?: "button" | "avatar" } = {}) {
  const t = useT();
  const locale = useLocale();
  const path = usePathname();
  const { user, oidcEnabled, isAdmin, loading } = useAuth();
  const { enabled: configured, hasSessionHint } = useAuthConfig();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  const closeLanguageMenu = useCallback(() => {
    setLanguageOpen(false);
    languageTriggerRef.current?.focus();
  }, []);

  const closeMenu = useCallback(() => {
    setLanguageOpen(false);
    setOpen(false);
  }, []);

  // Dismiss on outside click and on Escape. Both are registered only while open, so a closed menu
  // costs nothing — this component renders on every page with a header.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (languageOpen) closeLanguageMenu();
      else { closeMenu(); accountTriggerRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, languageOpen, closeMenu, closeLanguageMenu]);

  if (loading) {
    if (path === "/" && configured && !hasSessionHint && variant === "avatar") {
      return <span className="auth-slot is-ready is-signed-out"><a className="primary nav-signin" href={loginHref()}><LogIn size={15} aria-hidden="true" /> {t("Sign in / Sign up")}</a></span>;
    }
    return variant === "avatar"
      ? <span className="auth-slot is-loading" role="status" aria-label={t("Checking account")}><span className="auth-placeholder" /></span>
      : null;
  }

  // Keep the server-confirmed sign-in entry usable even if account detection fails offline.
  if (!oidcEnabled && !configured) return variant === "avatar" ? <span className="auth-slot is-empty" aria-hidden="true" /> : null;

  if (!user) {
    return variant === "avatar" ? (
      <AuthArrival key="signed-out" path={path} current="signed-out">{(animateArrival) => (
        <span className={`auth-slot is-ready is-signed-out${animateArrival ? " should-animate" : ""}`}>
          <a className={`primary nav-signin${animateArrival ? " auth-arrival" : ""}`} href={loginHref()}><LogIn size={15} aria-hidden="true" /> {t("Sign in / Sign up")}</a>
        </span>
      )}</AuthArrival>
    ) : (
      <a className="btn" href={loginHref()}>
        <LogIn size={14} /> {t("Sign in / Sign up")}
      </a>
    );
  }

  const label = user.displayName || user.email || t("Me");
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "?";
  const renderChip = (animateArrival: boolean) => (
    <div className={`auth-chip${animateArrival ? " auth-arrival" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={variant === "avatar" ? "avatar" : "btn"}
        aria-haspopup="menu"
        ref={accountTriggerRef}
        aria-expanded={open}
        aria-label={variant === "avatar" ? label : undefined}
        title={user.email ?? undefined}
        onClick={() => { if (open) setLanguageOpen(false); setOpen(!open); }}
      >
        {variant === "avatar" ? initial : <><User2 size={14} /> {label} <ChevronDown size={12} aria-hidden="true" /></>}
      </button>
      {open && (
        <div className="auth-menu" role="menu">
          {/* The email is the one thing the collapsed chip cannot show, and it is what tells you
              WHICH account you are on when several exist. */}
          {user.email && <p className="auth-menu-id" title={user.email}>{user.email}</p>}
          <Link className="auth-menu-item" role="menuitem" href="/me" onClick={closeMenu}>
            <User2 size={14} /> {t("My sites")}
          </Link>
          <Link className="auth-menu-item" role="menuitem" href="/notifications" onClick={closeMenu}>
            <Bell size={14} /> {t("Notification center")}
          </Link>
          <div className="auth-language">
            <button ref={languageTriggerRef} type="button" className="auth-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={languageOpen} onClick={() => setLanguageOpen(value => !value)}>
              <Globe2 size={14} /> <span>{t("Language")}</span><ChevronRight className="auth-menu-tail" size={13} aria-hidden="true" />
            </button>
            {languageOpen && <div className="auth-language-menu" role="menu" aria-label={t("Language")}>
              <button type="button" className="auth-menu-item" role="menuitemradio" aria-checked={locale === "zh-CN"} onClick={() => { closeLanguageMenu(); if (locale !== "zh-CN") setLocaleCookie("zh-CN"); }}>
                <span className="auth-menu-check">{locale === "zh-CN" && <Check size={13} />}</span>{t("Simplified Chinese")}
              </button>
              <button type="button" className="auth-menu-item" role="menuitemradio" aria-checked={locale === "en"} onClick={() => { closeLanguageMenu(); if (locale !== "en") setLocaleCookie("en"); }}>
                <span className="auth-menu-check">{locale === "en" && <Check size={13} />}</span>English
              </button>
            </div>}
          </div>
          {/* Only administrators see the entry; /admin itself answers 404 to anyone else. */}
          {isAdmin && (
            <Link className="auth-menu-item" role="menuitem" href="/admin" onClick={closeMenu}>
              <ShieldCheck size={14} /> {t("Admin")}
            </Link>
          )}
          <hr className="hairline" />
          <button
            type="button"
            className="auth-menu-item"
            role="menuitem"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              // Origin is checked server-side on every cookie-authenticated write, including this one.
              const response = await fetch("/api/auth/logout", { method: "POST", headers: { origin: window.location.origin } })
                .catch(() => null);
              // Clear gtag's identity before unload events, not just the in-memory app state.
              if (response?.ok) setAnalyticsUser(null);
              resetAuthCache();
              window.location.reload();
            }}
          >
            <LogOut size={14} /> {t("Sign out")}
          </button>
        </div>
      )}
    </div>
  );
  return variant === "avatar" ? (
    <AuthArrival key={`user:${user.id}`} path={path} current={`user:${user.id}`}>{(animateArrival) => (
      <span className={`auth-slot is-ready is-user${animateArrival ? " should-animate" : ""}`}>
        {renderChip(animateArrival)}
      </span>
    )}</AuthArrival>
  ) : renderChip(false);
}
