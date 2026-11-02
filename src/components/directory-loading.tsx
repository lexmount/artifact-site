"use client";
import { LoaderCircle } from "lucide-react";
import { useT } from "@/components/locale-provider";

export default function DirectoryLoading() {
  const t = useT();
  return <div className="directory-loading" role="status" aria-label={t("Loading…")}>
    <LoaderCircle className="spin" size={30} strokeWidth={1.8} aria-hidden="true" />
    <span className="sr-only">{t("Loading…")}</span>
  </div>;
}
