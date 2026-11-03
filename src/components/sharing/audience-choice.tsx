"use client";
import type { ReactNode } from "react";
import { Building2, Globe, KeyRound, LockKeyhole, UserRoundCheck, Minus } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { MAIN_ACCESS_HINTS, MAIN_ACCESS_LABELS, type AccessAudience } from "./main-sharing-model";
const icons = { private: LockKeyhole, login: UserRoundCheck, passcode: KeyRound, tenant: Building2, anyone: Globe, keep: Minus };
/** The same audience card is used for individual settings and explicit batch edits. */
export default function AudienceChoice({ id, audience, checked, onChange, organization, hint, children }: {
  id: string; audience: AccessAudience | "keep"; checked: boolean; onChange: () => void;
  organization?: string; hint?: string; children?: ReactNode;
}) {
  const t = useT(), Icon = icons[audience];
  return <div className={`sharing-audience-card${checked ? " is-selected" : ""}`}>
    <label className="sharing-audience-label" htmlFor={`${id}-${audience}`}>
      <Icon size={20} aria-hidden="true"/>
      <span className="sharing-audience-text"><span className="sharing-audience-title">{t(audience === "keep" ? "Keep current settings" : MAIN_ACCESS_LABELS[audience])}</span>
        <span className="sharing-audience-hint" id={`${id}-${audience}-hint`}>{hint ?? t(audience === "keep" ? "Each site keeps its own access settings." : MAIN_ACCESS_HINTS[audience])}</span>
        {organization && <span className="sharing-organization">{organization}</span>}
      </span>
      <input id={`${id}-${audience}`} type="radio" name={`${id}-audience`} value={audience} checked={checked} aria-describedby={`${id}-${audience}-hint`} onChange={onChange}/>
    </label>
    {children}
  </div>;
}
