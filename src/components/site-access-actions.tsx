"use client";

import { useState } from "react";
import { useT } from "@/components/locale-provider";
import { loginHref } from "@/lib/use-auth";
import { logoutAuth } from "@/lib/auth-store";
import { setAnalyticsUser } from "@/lib/analytics";

/** Read the destination at click time, including query credentials and the browser-only fragment. */
export async function retrySiteAccess(switchAccount = false): Promise<void> {
  const destination = loginHref(undefined, switchAccount);
  if (switchAccount) {
    await logoutAuth();
    setAnalyticsUser(null);
  }
  window.location.assign(destination);
}

export default function SiteAccessActions({ signedIn, loginEnabled }: { signedIn: boolean; loginEnabled: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signIn(switchAccount: boolean) {
    setBusy(true);
    setFailed(false);
    try { await retrySiteAccess(switchAccount); }
    catch { setFailed(true); setBusy(false); }
  }
  return <>
    {!signedIn && loginEnabled
      ? <button className="btn solid" disabled={busy} onClick={() => void signIn(false)}>{t("Sign in and retry")}</button>
      : <button className="btn solid" disabled={busy} onClick={() => window.location.reload()}>{t("Retry access")}</button>}
    {signedIn && loginEnabled && <button className="btn" disabled={busy} onClick={() => void signIn(true)}>{t("Switch account")}</button>}
    {failed && <p role="alert">{t("Could not sign out. Please try again.")}</p>}
  </>;
}
