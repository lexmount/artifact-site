"use client";
import { useId } from "react";
import { Building2, ChevronDown, Globe, LockKeyhole, Users } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { accessAudiences, AUDIENCE_LABELS, type SharingPolicy } from "@/lib/sharing-policy";
import SharingHelp from "./sharing-help";
import { MAIN_ACCESS_HINTS } from "./main-sharing-model";

export function PolicySummary({ policy }: { policy: SharingPolicy }) {
  const t = useT();
  return <>{t(AUDIENCE_LABELS[policy.audience])}{policy.audience !== "private" && <> · {t(policy.comments ? "Can comment" : "Can view")}</>}</>;
}

export default function PolicyFields({ value, onChange, disabled = false, includePublic = false, includeOrganization = true }: {
  value: SharingPolicy;
  onChange: (p: SharingPolicy) => void;
  disabled?: boolean;
  includePublic?: boolean;
  includeOrganization?: boolean;
}) {
  const t = useT(), id = useId();
  const unavailable = value.audience === "tenant" && !includeOrganization;
  const Icon = value.audience === "private" ? LockKeyhole : value.audience === "tenant" ? Building2 : value.audience === "login" ? Users : Globe;
  const hint = value.audience === "tenant" ? "Access is checked against each artifact's organization."
    : value.audience === "public" ? "Anyone can open this artifact directly with the link, and also see it in Discover."
    : MAIN_ACCESS_HINTS[value.audience];
  return <div className="scope-policy-fields">
    <label htmlFor={id}>{t("Who can access through this link")}</label>
    <div className="scope-audience-select">
      <Icon size={18} aria-hidden="true"/>
      <select id={id} value={unavailable ? "" : value.audience} disabled={disabled} aria-describedby={`${id}-hint`}
        onChange={e => onChange({ ...value, audience: e.target.value as SharingPolicy["audience"] })}>
        {unavailable && <option value="" disabled>{t("Choose access")}</option>}
        {[...accessAudiences(includeOrganization), ...(includePublic || value.audience === "public" ? ["public" as const] : [])].map(audience =>
          <option key={audience} value={audience}>{t(AUDIENCE_LABELS[audience])}</option>)}
      </select>
      <ChevronDown size={15} aria-hidden="true"/>
    </div>
    <p id={`${id}-hint`}>{unavailable && <>{t("Current access")}: {t(AUDIENCE_LABELS.tenant)}. </>}{t(hint)}</p>
    <div className="scope-toggle">
      <span><label htmlFor={`${id}-comments`}>{t("Allow comments")}</label><SharingHelp label={t("Allow comments")}>
        {t(value.comments ? "Readers can see comments. Sign in to post." : "New comments and replies are paused. Existing discussions remain readable.")}
      </SharingHelp></span>
      <input id={`${id}-comments`} role="switch" type="checkbox" checked={value.comments} disabled={disabled}
        onChange={e => onChange({ ...value, comments: e.target.checked })}/>
    </div>
  </div>;
}
