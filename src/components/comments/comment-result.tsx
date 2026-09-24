"use client";
import { useEffect, useEffectEvent, useState } from "react";
import { useT } from "@/components/locale-provider";
import type { CommentThreadDetail } from "@/lib/comments/contracts";
import { commentRequest } from "./comment-client";
/** An explicit editorial association; never changes the comment's original version. */
export function CommentResult({detail, endpoint, token, busy, versions, onChange, onError}: {
  detail: CommentThreadDetail; endpoint: string; token?: string;
  busy:boolean;
  versions?: {id:string;createdAt:number;number:number}[];
  onChange: () => void; onError: (error: unknown) => void;
}) {
  const t=useT();
  const [saving,setSaving]=useState(false);
  const [available,setAvailable]=useState<{id:string;createdAt:number;number:number}[]>([]);
  const [expanded,setExpanded]=useState(false);
  const reportError=useEffectEvent(onError);
  useEffect(()=>{
    if(!expanded || versions || !detail.permissions.canAssociateResult) return;
    let active=true, sequence=0;
    const refresh=()=>{
      const current=++sequence;
      void commentRequest<{versions:typeof available}>(`${endpoint}/${detail.thread.id}/result`,token)
        .then(result=>{if(active && current===sequence)setAvailable(result.versions);})
        .catch(error=>{if(active && current===sequence)reportError(error);});
    };
    refresh();
    // Do not retain site-wide grants across accounts or link scopes. Editors load on
    // disclosure and revalidate on return; owners reuse the existing authorized options.
    window.addEventListener("focus",refresh);
    return ()=>{active=false;window.removeEventListener("focus",refresh);};
  },[detail.thread.id,detail.permissions.canAssociateResult,endpoint,token,expanded,versions]);
  const label=detail.thread.resultVersionNumber ? `v${detail.thread.resultVersionNumber}` : t("Linked version");
  return <div className="comment-result">
    {detail.thread.resultVersionId && <span>{t("Addressed in")} {label}{detail.thread.resultAssociation?.actorKind === "agent" && ` · ${t("Agent")}`}</span>}
    {detail.permissions.canAssociateResult && <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{t("Link an adjusted version")}</summary>
      <p>{t("The original discussion stays on its version and remains open until explicitly ended.")}</p>
      <label>{t("Adjusted version")}<select disabled={busy || saving} value={detail.thread.resultVersionId ?? ""} onChange={async event=>{
        const versionId=event.target.value || null;
        setSaving(true);
        try { await commentRequest(`${endpoint}/${detail.thread.id}/result`,token,{method:"PATCH",body:JSON.stringify({versionId,expectedRevision:detail.thread.revision})}); onChange(); }
        catch(error){onError(error);} finally{setSaving(false);}
      }}><option value="">{t("No linked version")}</option>{(versions ?? available).map((version)=><option key={version.id} value={version.id}>v{version.number}</option>)}</select></label>
    </details>}
  </div>;
}
