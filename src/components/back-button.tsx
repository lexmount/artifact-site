// "← Back" — one level up, not "home". Pages like /me, /activate and /s/… are reached from
// somewhere (a claim link, an authorize link, a card), and the only way back used to be the brand
// logo — which drops you at the home page even when you came from a site. Falls back to home when
// this tab HAS no history (a link opened fresh in a new tab).
"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/components/locale-provider";

export default function BackButton() {
  const t = useT();
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn sm ghost back-btn"
      aria-label={t("Go back")}
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push("/");
      }}
    >
      <ArrowLeft size={13} /> {t("Back")}
    </button>
  );
}
