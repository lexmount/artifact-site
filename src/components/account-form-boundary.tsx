"use client";
import { Fragment, type ReactNode } from "react";
import { useAuth, loginHref } from "@/lib/use-auth";
import { refreshAuth } from "@/lib/auth-store";
import { useT } from "@/components/locale-provider";

/** Discard account-owned drafts and pending effects as soon as identity changes. */
export default function AccountFormBoundary({ children }: { children: ReactNode }) {
  const { user, loading, error, oidcEnabled } = useAuth();
  const t = useT();
  if (loading) return <div className="tenant-skeleton" aria-label={t("Loading…")} aria-busy="true" />;
  if (error) return <button className="btn" onClick={() => void refreshAuth()}>{t("Retry account check")}</button>;
  if (!user) {
    return oidcEnabled ? <a className="btn" href={loginHref()}>{t("Sign in / Sign up")}</a> : null;
  }
  return <Fragment key={user.id}>{children}</Fragment>;
}
