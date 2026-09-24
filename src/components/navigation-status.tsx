"use client";
import { useLinkStatus } from "next/link";
import { useT } from "@/components/locale-provider";
export default function NavigationStatus() {
  const { pending } = useLinkStatus();
  const t = useT();
  return pending ? (
    <span className="nav-pending" role="status" aria-label={t("Loading…")} />
  ) : null;
}
