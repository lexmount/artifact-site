"use client";
import { useT } from "@/components/locale-provider";
export default function PageSkeleton() {
  const t = useT();
  return (
    <div className="page-skeleton" role="status" aria-label={t("Loading…")}>
      <span>{t("Loading…")}</span>
      <div />
      <div />
      <div />
    </div>
  );
}
