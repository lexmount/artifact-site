"use client";
import { useLinkStatus } from "next/link";
import { useT } from "@/components/locale-provider";
export default function NavigationStatus() {
  const { pending } = useLinkStatus();
  const t = useT();
  return <span className={`nav-pending${pending ? " is-pending" : ""}`} role={pending ? "status" : undefined} aria-label={pending ? t("Loading…") : undefined} aria-hidden={pending ? undefined : true} />;
}
