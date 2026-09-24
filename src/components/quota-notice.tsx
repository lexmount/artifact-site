"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useT } from "@/components/locale-provider";
import type { QuotaDetails } from "@/lib/quota-client";

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`;
  return `${Math.round(bytes / 1024 / 1024 / 1024 * 10) / 10} GB`;
}

export default function QuotaNotice({ details }: { details: QuotaDetails }) {
  const t = useT();
  const sites = details.kind === "sites";
  return (
    <div className="quota-notice" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>{t(sites ? "You’ve reached your site limit" : "Not enough storage for this upload")}</strong>
        <p>{sites
          ? t("You’re using {used} of {limit} sites. Delete a site you no longer need, or publish a new version of an existing site.", { used: details.used, limit: details.limit })
          : t("You’re using {used} of {limit}; this upload needs {requested} more. Delete sites or trim files to free space.", { used: size(details.used), limit: size(details.limit), requested: size(details.requested) })}</p>
        <div className="quota-notice-actions">
          <Link className="btn" href="/me">{t("View my sites")}</Link>
          <span>{t("Capacity upgrades are in development.")}</span>
        </div>
      </div>
    </div>
  );
}
