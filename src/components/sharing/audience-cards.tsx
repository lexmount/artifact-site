"use client";
import { useId, useState } from "react";
import { Copy } from "lucide-react";
import AudienceChoice from "./audience-choice";
import { useT } from "@/components/locale-provider";
import { accessAudiences } from "@/lib/sharing-policy";
import { SharingDialog } from "./scope-dialog";
import { accessAudience, MAIN_ACCESS_LABELS, type AccessAudience, type DocumentSharingState } from "./main-sharing-model";
export default function AudienceCards({ data, disabled, onChange, onReset }: {
  data: DocumentSharingState; disabled: boolean; onChange: (value: AccessAudience) => void; onReset: () => Promise<void>;
}) {
  const t = useT(), id = useId();
  const [reset, setReset] = useState(false), [copyNotice, setCopyNotice] = useState("");
  const selected = accessAudience(data.policy);
  const audiences = accessAudiences(Boolean(data.organization?.canSelect), true);
  return <fieldset className="sharing-audiences" disabled={disabled}>
    <legend>{t("Who can access through this link")}</legend>
    {selected === "tenant" && !data.organization?.canSelect && <p className="scope-muted">{t("Current access")}: {t(MAIN_ACCESS_LABELS.tenant)}. {t("Choose another option to change access.")}</p>}
    <div className="sharing-audience-list">
      {audiences.map(audience => {
        const checked = selected === audience;
        return <AudienceChoice key={audience} id={id} audience={audience} checked={checked} onChange={() => onChange(audience)} organization={audience === "tenant" ? data.organization?.name : undefined}>
          {audience === "passcode" && checked && <div className="sharing-passcode">
            <label htmlFor={`${id}-code`}>{t("Passcode")}</label>
            <div className="sharing-passcode-controls">
              <input id={`${id}-code`} value={data.passcode ?? ""} readOnly onFocus={event => event.currentTarget.select()} aria-describedby={`${id}-code-hint`}/>
              <button type="button" className="btn sm" disabled={!data.passcode || disabled} onClick={async () => {
                try { await navigator.clipboard.writeText(data.passcode!); setCopyNotice(t("Copied")); }
                catch { setCopyNotice(t("Copy failed. Select the passcode to copy it manually.")); }
              }}><Copy size={15}/>{t("Copy")}</button>
              <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => setReset(true)}>{t("Reset")}</button>
            </div>
            <p id={`${id}-code-hint`}>{t("Automatically generated, case-insensitive, always available to view.")}</p>
            {copyNotice && <p role="status">{copyNotice}</p>}
          </div>}
        </AudienceChoice>;
      })}
    </div>
    {reset && <SharingDialog title={t("Reset passcode?")} confirmLabel={t("Reset passcode")} disabled={disabled} onClose={() => setReset(false)} onSubmit={async () => { await onReset(); setReset(false); setCopyNotice(""); }}>
      <p>{t("The old passcode will stop working. People using it will need the new passcode to regain access.")}</p>
    </SharingDialog>}
  </fieldset>;
}
