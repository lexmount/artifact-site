"use client";
// Post-login acknowledgement. Signing in is the moment a pile of anonymous drops becomes *yours*,
// and that is invisible in the data — so it gets said out loud, once, then never again.
//
// The count arrives as ?welcome=<n> from the auth callback. It is a presentation hint only; the
// component strips it from the URL immediately so a reload or a shared link cannot replay it.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { refreshAuth } from "@/lib/auth-store";
import { useAuth } from "@/lib/use-auth";
import { useT } from "@/components/locale-provider";

export default function WelcomeBurst() {
  const t = useT();
  const router = useRouter();
  const { user, error } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const arrival = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const url = new URL(window.location.href);
    // Retain the hint across Strict Mode effect cleanup/replay after stripping the URL.
    if (arrival.current === undefined) arrival.current = url.searchParams.get("welcome");
    const raw = arrival.current;
    if (raw == null) return;

    const n = Number.parseInt(raw, 10);
    // Strip first: a burst that survives a refresh reads as a bug, not a celebration.
    url.searchParams.delete("welcome");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);

    // The callback hint is not proof that the browser accepted its session cookie.
    let cancelled = false;
    let t1 = 0, t2 = 0;
    void refreshAuth().then((auth) => {
      if (cancelled || auth.error || !auth.user) return;
      setLeaving(false);
      setCount(Number.isFinite(n) ? n : 0);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const hold = reduced ? 1400 : 2200;
      t1 = window.setTimeout(() => setLeaving(true), hold);
      t2 = window.setTimeout(() => { setCount(null); router.refresh(); }, hold + 420);
    });
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); };
  }, [router]);

  if (count == null || !user || error) return null;

  return (
    <div
      className={`welcome-burst${leaving ? " leaving" : ""}`}
      role="status"
      aria-live="polite"
      onClick={() => setLeaving(true)}
    >
      <div className="welcome-burst-ring" aria-hidden="true" />
      <div className="welcome-burst-body">
        <Sparkles size={28} aria-hidden="true" />
        {count > 0 ? (
          <>
            <strong>{count}</strong>
            <p>{t("sites are now yours")}</p>
            <small>{t("The sites this browser created anonymously now belong to you")}</small>
          </>
        ) : (
          <>
            <p className="welcome-burst-plain">{t("Signed in")}</p>
            <small>{t("Sites you create from now on will be yours")}</small>
          </>
        )}
      </div>
    </div>
  );
}
