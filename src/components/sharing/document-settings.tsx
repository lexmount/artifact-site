"use client";
import { useId, useState } from "react";
import { Info } from "lucide-react";
import { useT } from "@/components/locale-provider";
import type { SharingPolicy, SharingState } from "@/lib/sharing-policy";
import { SharingDialog } from "./scope-dialog";
import SharingHelp from "./sharing-help";
import AudienceCards from "./audience-cards";
import { accessAudience, changeAudience, changeDiscovery, MAIN_ACCESS_LABELS, sharingChangeEffects } from "./main-sharing-model";
import type { DocumentSharingController } from "./use-document-sharing";

export default function DocumentSharingSettings({
  controller, disabled = false, preserveDiscussionVisibility = false, action, onActionChange, onSaved, onUpdating,
}: {
  controller: DocumentSharingController;
  disabled?: boolean;
  preserveDiscussionVisibility?: boolean;
  action: "follow" | "stop" | "private" | null;
  onActionChange: (action: "follow" | "stop" | "private" | null) => void;
  onSaved: (state: SharingState) => void;
  onUpdating: () => void;
}) {
  const t = useT(), id = useId();
  const { data, busy, error, unavailable, load } = controller;
  const [pendingPolicy, setPendingPolicy] = useState<SharingPolicy | null>(null);
  const [failedPolicy, setFailedPolicy] = useState<SharingPolicy | null>(null);
  const blocked = busy || disabled || unavailable;
  async function commit(kind: "custom" | "follow" | "stop" | "reset-passcode", policy?: SharingPolicy) {
    const focused = document.activeElement as HTMLElement | null;
    onUpdating();
    try {
      const saved = await controller.save(kind, policy);
      if (!saved) return;
      setPendingPolicy(null);
      setFailedPolicy(null);
      onActionChange(null);
      onSaved(saved);
      requestAnimationFrame(() => { if (focused?.isConnected) focused.focus({ preventScroll: true }); });
    } catch (e) {
      if (kind === "custom" && policy) setFailedPolicy(policy);
      throw e;
    }
  }
  function change(next: SharingPolicy) {
    if (!data || blocked || (next.audience === data.policy.audience && next.comments === data.policy.comments)) return;
    setFailedPolicy(null);
    if (sharingChangeEffects(data, next).confirm) setPendingPolicy(next);
    else void commit("custom", next).catch(() => {});
  }
  const nextPolicy = pendingPolicy ?? (action === "private" && data ? { ...data.policy, audience: "private" as const } : null);
  const effects = data && nextPolicy ? sharingChangeEffects(data, nextPolicy) : null;
  const close = () => { setPendingPolicy(null); onActionChange(null); };
  const confirmationTitle = action === "stop" ? "Close all sharing?"
    : action === "follow" ? "Resume following?"
    : effects?.publicAccess ? effects.listing ? "Allow access and list in Discover?" : "Allow anyone to access?"
    : effects?.unlist ? "Restrict access and remove from Discover?" : "Use custom settings for this artifact?";
  const confirmLabel = action === "stop" ? "Close all sharing"
    : action === "follow" ? "Confirm restore"
    : effects?.publicAccess ? effects.listing ? "Allow and list" : "Allow access"
    : effects?.unlist ? "Restrict access" : "Use custom settings";
  return <section className="sharing-section sharing-main-policy" aria-busy={busy}>
    {error && <div className="sharing-policy-error" role="alert">
      <p>{t(unavailable ? "Could not refresh access. Retry before changing settings." : "Could not update permissions. Current settings remain in effect.")}</p>
      {!unavailable && <small>{t(error)}</small>}
      <button className="btn sm" disabled={busy || disabled} onClick={() => {
        if (!unavailable && failedPolicy) void commit("custom", failedPolicy).catch(() => {});
        else void load();
      }}>{t("Try again")}</button>
    </div>}
    {!data && !error && <div className="sharing-skeleton sharing-audience-skeleton" role="status" aria-label={t("Loading sharing settings")}><span/><span/></div>}
    {data && <>
      <AudienceCards data={data} disabled={blocked} onChange={audience => change(changeAudience(data.policy, audience))} onReset={() => commit("reset-passcode")}/>
      {data.links > 0 && <p className="sharing-independent-hint"><Info size={14}/>{t("Independent sharing links still use their own settings.")}</p>}
      <div className="sharing-options">
        <div className="sharing-option">
          <label className="sharing-toggle-row" htmlFor={`${id}-comments`}><span>{t("Allow comments")}</span>
            <input id={`${id}-comments`} type="checkbox" role="switch" aria-describedby={`${id}-comments-hint`} checked={data.policy.comments} disabled={blocked}
              onChange={event => change({ ...data.policy, comments: event.target.checked })}/>
          </label>
          <SharingHelp label={t("Allow comments")} id={`${id}-comments-hint`}>{t(preserveDiscussionVisibility ? "This existing artifact keeps its original discussion visibility." : data.policy.comments ? "Readers can see comments. Sign in to post." : "New comments and replies are paused. Existing discussions remain readable.")}</SharingHelp>
        </div>
        {accessAudience(data.policy) === "anyone" && <DiscoverSetting policy={data.policy} disabled={blocked} onChange={change}/>}
      </div>
      {(nextPolicy || action) && <SharingDialog title={t(confirmationTitle)} onClose={close} danger={action === "stop" || effects?.publicAccess} disabled={blocked}
        alert={effects?.publicAccess} description={effects?.publicAccess ? t("Anyone with the link can open this artifact without signing in.") : undefined}
        confirmLabel={t(confirmLabel)} className={`sharing-confirmation${effects?.publicAccess ? " sharing-access-confirmation" : ""}`} onSubmit={() => commit(action === "private" ? "custom" : action ?? "custom", nextPolicy ?? undefined)}>
        {action === "stop" ? <>
          <p>{t("This will:")}</p>
          <ul className="sharing-impact-list">
            <li>{t("Restrict the main link and remove this artifact from Discover.")}</li>
            <li>{t("Remove {n} direct member grants.", { n: data.members })}</li>
            <li>{t("Revoke {n} independent sharing links.", { n: data.links })}</li>
            <li>{t("Stop following shared settings.")}</li>
          </ul>
          <p>{t("Owner and necessary administrative access remain.")}</p>
          <p className="scope-muted">{t("Sharing again requires configuring access again.")}</p>
        </> : action === "follow" ? <>
          <p>{t("This replaces custom settings with the applicable folder, all-sites scope, or current defaults.")}</p>
          {data.follow && <div className="sharing-change-summary">
            <div><span>{t("Current access")}</span><b>{t(MAIN_ACCESS_LABELS[accessAudience(data.policy)])}</b></div>
            <div><span>{t("After this change")}</span><b>{t(MAIN_ACCESS_LABELS[accessAudience(data.follow.policy)])}</b></div>
            {data.follow.policy.audience === "public" && <p>{t("Anyone can open this artifact directly with the link, and also see it in Discover.")}</p>}
            <div><span>{t("Allow comments")}</span><b>{t(data.follow.policy.comments ? "On" : "Off")}</b></div>
          </div>}
        </> : <>
          {effects?.unlist && <p>{t("This also removes the artifact from Discover. Independent sharing links and member grants remain unchanged.")}</p>}
          {nextPolicy && !effects?.publicAccess && <div className="sharing-change-summary">
            <div><span>{t("Current access")}</span><b>{t(MAIN_ACCESS_LABELS[accessAudience(data.policy)])}</b></div>
            <div><span>{t("After this change")}</span><b>{t(MAIN_ACCESS_LABELS[accessAudience(nextPolicy)])}</b></div>
            {effects?.detach && <div><span>{t("Allow comments")}</span><b>{t(nextPolicy.comments ? "On" : "Off")}</b></div>}
          </div>}
          {nextPolicy && accessAudience(nextPolicy) === "anyone" && <DiscoverSetting policy={nextPolicy} disabled={blocked} onChange={setPendingPolicy} explain/>}
        </>}
      </SharingDialog>}
    </>}
  </section>;
}

function DiscoverSetting({ policy, disabled, onChange, explain = false }: {
  policy: SharingPolicy;
  disabled: boolean;
  onChange: (policy: SharingPolicy) => void;
  explain?: boolean;
}) {
  const t = useT(), id = useId();
  const hint = t("When enabled, this artifact can appear in Discover on the home page, and anyone can access it.");
  return <div className="sharing-discovery">
    <div className="sharing-option">
      <label className="sharing-toggle-row" htmlFor={`${id}-discover`}><span>{t("List in Discover")}</span>
        <input id={`${id}-discover`} type="checkbox" role="switch" aria-describedby={`${id}-discover-hint`} checked={policy.audience === "public"} disabled={disabled}
          onChange={event => onChange(changeDiscovery(policy, event.target.checked))}/>
      </label>
      {!explain && <SharingHelp label={t("List in Discover")} id={`${id}-discover-hint`}>{hint}</SharingHelp>}
    </div>
    {explain && <p id={`${id}-discover-hint`}>{t("Also make this artifact discoverable on the home page.")}</p>}
  </div>;
}
