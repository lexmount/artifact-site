"use client";
// Header auth affordance. Renders NOTHING while no IdP is configured — an unconfigured deployment
// should be indistinguishable from the product before identity existed, not show a dead button.
//
// Signed in, this is ONE control, not two: the name is the button, and "Sign out" lives in the menu it
// opens. That shape is what leaves room for "User settings" and everything else that will want to hang off
// an identity — a second top-level button per account action does not scale, and "Sign out" sitting
// permanently in the toolbar gives the least-used action the most prominent slot.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogIn, LogOut, ShieldCheck, User2 } from "lucide-react";
import { loginHref, resetAuthCache, useAuth } from "@/lib/use-auth";
import { useT } from "@/components/locale-provider";

export default function AuthButton({ variant = "button" }: { variant?: "button" | "avatar" } = {}) {
  const t = useT();
  const { user, oidcEnabled, isAdmin, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click and on Escape. Both are registered only while open, so a closed menu
  // costs nothing — this component renders on every page with a header.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (loading || !oidcEnabled) return null;

  if (!user) {
    return variant === "avatar" ? (
      <a className="primary nav-signin" href={loginHref()}><LogIn size={15} aria-hidden="true" /> {t("Sign in")}</a>
    ) : (
      <a className="btn" href={loginHref()}>
        <LogIn size={14} /> {t("Sign in")}
      </a>
    );
  }

  const label = user.displayName || user.email || t("Me");
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "?";
  return (
    <div className="auth-chip" ref={wrapRef}>
      <button
        type="button"
        className={variant === "avatar" ? "avatar" : "btn"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === "avatar" ? label : undefined}
        title={user.email ?? undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {variant === "avatar" ? initial : <><User2 size={14} /> {label} <ChevronDown size={12} aria-hidden="true" /></>}
      </button>
      {open && (
        <div className="auth-menu" role="menu">
          {/* The email is the one thing the collapsed chip cannot show, and it is what tells you
              WHICH account you are on when several exist. */}
          {user.email && <p className="auth-menu-id">{user.email}</p>}
          <Link className="auth-menu-item" role="menuitem" href="/me" onClick={() => setOpen(false)}>
            <User2 size={14} /> {t("My sites")}
          </Link>
          {/* Only administrators see the entry; /admin itself answers 404 to anyone else. */}
          {isAdmin && (
            <Link className="auth-menu-item" role="menuitem" href="/admin" onClick={() => setOpen(false)}>
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
              await fetch("/api/auth/logout", { method: "POST", headers: { origin: window.location.origin } })
                .catch(() => {});
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
}
