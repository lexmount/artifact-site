// /activate — the human half of device authorization: sign in, see the code, press allow.
//
// The user code arrives via ?code= (low-sensitivity: it can only be approved by the person who is
// signed in here, and approving binds the token to THAT person — knowing a code steals nothing).
// The page still shows the code and who you are before the button, because the one real risk is
// social: someone sending you THEIR code hoping you'll bless it. Make what's happening legible.
"use client";

import AppShell from "@/components/app-shell";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import BackButton from "@/components/back-button";
import { useT } from "@/components/locale-provider";
import { loginHref, useAuth } from "@/lib/use-auth";

/** A sentence with one inline element in it (a name, a link) is ONE translation key with a
 *  placeholder; the element is spliced in where the placeholder landed, so each language keeps
 *  its own word order and punctuation around it. */
const SLOT = "\u0000";
function slot(text: string, node: ReactNode): ReactNode {
  const [before, after] = text.split(SLOT);
  return <>{before}{node}{after}</>;
}

export default function ActivatePage() {
  const t = useT();
  const { user, oidcEnabled, loading } = useAuth();
  // Read once from the URL; useSearchParams would demand a Suspense boundary for no benefit.
  const [code, setCode] = useState(() =>
    typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("code") ?? ""),
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? t("Authorization failed"));
      }
    } catch {
      setError(t("Network error. Please try again later."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>

      <div className="narrow-page">
        <div className="page-back"><BackButton /></div>
        {loading && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}

        {!loading && !oidcEnabled && (
          <section className="narrow-hero">
            <p className="eyebrow">{t("Sign-in not enabled")}</p>
            <h1>{t("This deployment has no identity provider yet")}</h1>
            <p className="deck">{t("Without an identity there are no publish tokens.")} <Link href="/">{t("Back to home")}</Link></p>
          </section>
        )}

        {!loading && oidcEnabled && !user && (
          <section className="narrow-hero">
            <p className="eyebrow">{t("Sign-in required")}</p>
            <h1>{t("Sign in to complete device authorization")}</h1>
            <p className="deck">{t("A terminal / agent session is asking to publish as you. Sign in to confirm.")}</p>
            <p><a className="primary" href={loginHref(`/activate${code ? `?code=${encodeURIComponent(code)}` : ""}`)}>{t("Sign in")}</a></p>
          </section>
        )}

        {user && !done && (
          <section className="narrow-hero">
            <p className="eyebrow">{t("Device authorization")}</p>
            <h1>{t("Allow this session to publish as you?")}</h1>
            <p className="deck">
              {slot(
                t("A terminal / agent session is requesting a publish token. If you allow it, the sites it publishes belong to {name}; the token is long-lived and can be revoked at any time from your account page.", { name: SLOT }),
                <b>{user.displayName || user.email}</b>,
              )}
              {slot(
                t("{rule} — never authorize a code someone else sent you.", { rule: SLOT }),
                <b>{t("Only click Allow when the code comes from a session you started yourself")}</b>,
              )}
            </p>
            <div className="claim-form">
              <div className="field">
                <label htmlFor="activate-code">{t("Authorization code")}</label>
                <input
                  id="activate-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <button type="button" className="primary" onClick={approve} disabled={busy || !code.trim()}>
                {busy && <Loader2 size={14} className="spin" />} {t("Allow")}
              </button>
            </div>
            {error && <p className="drawer-error" role="alert">{error}</p>}
          </section>
        )}

        {user && done && (
          <section className="narrow-hero">
            <p className="eyebrow">{t("Authorized")}</p>
            <h1>{t("Back to your terminal")}</h1>
            <p className="deck">
              {slot(
                t("Authorization is complete; that side will pick up the token and continue within seconds. You can close this page. The token can be revoked at any time from your {accountPage}.", { accountPage: SLOT }),
                <Link href="/me">{t("account page")}</Link>,
              )}
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
