"use client";
// Post-login acknowledgement. Signing in is the moment a pile of anonymous drops becomes *yours*,
// and that is invisible in the data — so it gets said out loud, once, then never again.
//
// The count arrives as ?welcome=<n> from the auth callback. It is a presentation hint only; the
// component strips it from the URL immediately so a reload or a shared link cannot replay it.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { adoptStoredSites } from "@/lib/adoption";
import { useT } from "@/components/locale-provider";

export default function WelcomeBurst() {
  const t = useT();
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("welcome");
    if (raw == null) return;

    const n = Number.parseInt(raw, 10);
    // Strip first: a burst that survives a refresh reads as a bug, not a celebration.
    url.searchParams.delete("welcome");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);

    // Start on the next frame rather than synchronously in the effect. Correct for an entrance
    // animation anyway — the page paints once before anything moves — and it keeps the state
    // update out of the commit phase.
    let t1 = 0, t2 = 0;
    const frame = requestAnimationFrame(async () => {
      // Settle ownership here, because this is the one moment we know a sign-in just happened.
      // The callback already adopted whatever the anon cookie covered; this reaches everything
      // older, where the browser's stored edit tokens are the only surviving evidence of who
      // made the site. A failure is silent on purpose — the sign-in itself still succeeded.
      const byToken = await adoptStoredSites();

      setCount((Number.isFinite(n) ? n : 0) + byToken);
      // Reduced motion still gets the message, just without the sweep: the information is the
      // point, the animation is decoration.
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const hold = reduced ? 1400 : 2200;
      t1 = window.setTimeout(() => setLeaving(true), hold);
      t2 = window.setTimeout(() => { setCount(null); router.refresh(); }, hold + 420);
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(t1); clearTimeout(t2); };
  }, [router]);

  if (count == null) return null;

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
