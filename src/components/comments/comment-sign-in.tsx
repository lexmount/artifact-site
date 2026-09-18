"use client";
import { useT } from "@/components/locale-provider";
import { loginHref } from "@/lib/use-auth";

/** Reauthenticate elsewhere so this tab's in-memory draft is never replaced by the login page. */
export default function CommentSignIn({ onRefresh, busy = false, returnTo }: {
  onRefresh: () => void; busy?: boolean; returnTo?: string;
}) {
  const t = useT();
  return <div className="comment-login">
    <a href={loginHref(returnTo)} target="_blank" rel="noreferrer">{t("Sign in to comment (opens a new tab)")}</a>
    <p>{t("Your draft stays here. After signing in, return to this tab and refresh access.")}</p>
    <button type="button" className="btn sm" disabled={busy} onClick={onRefresh}>{t("Refresh access")}</button>
  </div>;
}
