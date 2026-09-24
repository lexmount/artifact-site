"use client";
import { useT } from "@/components/locale-provider";
export default function PageError({ reset }: { reset: () => void }) {
  const t = useT();
  return (
    <div className="empty" role="alert">
      <h2>{t("Failed to load")}</h2>
      <button className="btn" onClick={reset}>
        {t("Try again")}
      </button>
    </div>
  );
}
