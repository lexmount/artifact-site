"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "@/components/locale-provider";
import { countText } from "@/lib/i18n";
import { appFetch } from "@/lib/app-path";
import { accessAudiences } from "@/lib/sharing-policy";
import { bulkSharingEffects, type BulkSharingChanges, type BulkSharingPreview } from "@/lib/bulk-sharing-model";
import { accessAudience, MAIN_ACCESS_LABELS } from "./main-sharing-model";
import AudienceChoice from "./audience-choice";
import { SharingDialog } from "./scope-dialog";
import BulkSharingConfirmation from "./bulk-confirmation";

async function requestBatch(body: object) {
  const response = await appFetch("/api/me/sharing/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: response.status });
  return data as BulkSharingPreview;
}
export default function BulkSharingDialog({ slugs, onClose, onSaved }: {
  slugs: string[]; onClose: () => void; onSaved: (result: BulkSharingPreview) => void;
}) {
  const t = useT(), id = useId();
  const [data, setData] = useState<BulkSharingPreview | null>(null);
  const [changes, setChanges] = useState<BulkSharingChanges>({});
  const [review, setReview] = useState<BulkSharingPreview | null>(null);
  const [listInDiscover, setListInDiscover] = useState<boolean | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(true), [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const slugKey = JSON.stringify(slugs);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await requestBatch({ slugs: JSON.parse(slugKey), changes: {} });
      if (signal?.aborted) return;
      setData(next); setUnavailable(false); setError("");
    } catch (cause) {
      if (!signal?.aborted) {
        setUnavailable(true);
        const status = (cause as { status?: number })?.status;
        setError(status === 403 || status === 404 ? "You cannot manage sharing for every selected site. Close this dialog and update your selection." : "Could not load sharing settings. Refresh to try again.");
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [slugKey]);
  useEffect(() => { const controller = new AbortController(); void Promise.resolve().then(() => load(controller.signal)); return () => controller.abort(); }, [load]);
  const requestedChanges = changes.audience === "anyone" && listInDiscover !== undefined ? { ...changes, listInDiscover } : changes;
  async function save(confirmed = false) {
    if (!data || unavailable) return;
    let committing = false;
    try {
      const body = { slugs, changes: requestedChanges, expectedSnapshot: data.snapshot };
      const preview = await requestBatch(body);
      if (changes.audience === "anyone" && !confirmed) { setReview(preview); return; }
      committing = true;
      const result = await requestBatch({ ...body, confirmation: preview.confirmation });
      onSaved(result);
    } catch (cause) {
      setReview(null);
      setUnavailable(true);
      const status = (cause as { status?: number })?.status;
      setError(committing && (!status || status >= 500)
        ? "Could not confirm whether sharing was updated. Refresh current settings before trying again."
        : status === 409 ? "Sharing settings changed. Refresh before applying your changes."
        : status === 403 || status === 404 ? "You cannot manage sharing for every selected site. Close this dialog and update your selection."
        : "Sharing was not updated. Refresh current settings to try again.");
    }
  }
  const effects = bulkSharingEffects(data?.items ?? [], requestedChanges);
  const policies = data?.items.map(item => item.requestedPolicy ?? item.policy) ?? [];
  const audiences = new Set(policies.map(accessAudience)), comments = new Set(policies.map(policy => policy.comments));
  const currentAccess = audiences.size === 1 ? t(MAIN_ACCESS_LABELS[[...audiences][0]]) : t("Settings differ across selected sites");
  const currentComments = comments.size === 1 ? t([...comments][0] ? "On" : "Off") : t("Settings differ across selected sites");
  const inaccessible = error === "You cannot manage sharing for every selected site. Close this dialog and update your selection.";
  const dirty = changes.audience !== undefined || changes.comments !== undefined;
  return <><SharingDialog title={countText(t, slugs.length, "Share {n} site", "Share {n} sites")} description={t("Your changes will apply to all selected sites.")}
    className="bulk-sharing-dialog" confirmLabel={countText(t, slugs.length, "Apply to {n} site", "Apply to {n} sites")} disabled={!data || unavailable || loading || !dirty} onClose={onClose} onSubmit={save}>
    {error && <div className="sharing-policy-error" role="alert"><p>{t(error)}</p><button type="button" className="btn sm" disabled={loading} onClick={() => inaccessible ? onClose() : void load()}>{t(inaccessible ? "Close and update selection" : "Refresh current settings")}</button></div>}
    {loading && <p role="status">{t("Loading sharing settings")}</p>}
    {data && <section className="sharing-section">
      <details className="bulk-sharing-selection"><summary>{t("View selected sites")}</summary><ul>{data.items.map(item => <li key={item.slug}><span>{item.title}</span><small>{t(MAIN_ACCESS_LABELS[accessAudience(item.policy)])}</small></li>)}</ul></details>
      <fieldset className="sharing-audiences" disabled={unavailable || loading}>
        <legend>{t("Who can access through each site's link")}</legend>
        <div className="sharing-audience-list">
          <AudienceChoice id={id} audience="keep" checked={changes.audience === undefined} hint={currentAccess} onChange={() => { setListInDiscover(undefined); setChanges(({ comments }) => comments === undefined ? {} : { comments }); }}/>
          {accessAudiences(data.canSelectOrganization).filter(audience => audience !== "passcode").map(audience => <AudienceChoice key={audience} id={id} audience={audience} hint={audience === "tenant" ? t("Sign in with an account in each site’s organization.") : undefined} checked={changes.audience === audience} onChange={() => { setListInDiscover(undefined); setChanges(value => ({ ...value, audience })); }}/>)}
        </div>
      </fieldset>
      <label className="bulk-sharing-comments" htmlFor={`${id}-comments`}><span>{t("Allow comments")}</span>
        <select id={`${id}-comments`} value={changes.comments === undefined ? "keep" : String(changes.comments)} disabled={unavailable || loading} onChange={event => {
          const value = event.target.value;
          setChanges(({ audience }) => ({ ...(audience ? { audience } : {}), ...(value === "keep" ? {} : { comments: value === "true" }) }));
        }}>
          <option value="keep">{t("Keep current settings")} — {currentComments}</option><option value="true">{t("On")}</option><option value="false">{t("Off")}</option>
        </select>
      </label>
      <div className="bulk-sharing-effects" aria-live="polite">
        {effects.anyone > 0 && <p>{countText(t, effects.anyone, "Anyone with the link can access this site without signing in.", "Anyone with a link can access these {n} sites without signing in.")}</p>}
        {effects.detach > 0 && <p>{countText(t, effects.detach, "One site will use custom settings and stop following folder or all-sites sharing settings.", "{n} sites will use custom settings and stop following folder or all-sites sharing settings.")}</p>}
        {effects.unlist > 0 && <p>{countText(t, effects.unlist, "One site will also be removed from Discover.", "{n} sites will also be removed from Discover.")}</p>}
        {changes.audience === "private" && <p>{t("Existing members and independent sharing links keep their access.")}</p>}
        {changes.audience === "anyone" && <p className="scope-muted">{t("You will confirm access and choose whether to list sites in Discover in the next step.")}</p>}
      </div>
    </section>}
  </SharingDialog>
    {review && <BulkSharingConfirmation items={review.items} listInDiscover={listInDiscover} onListingChange={setListInDiscover}
      onClose={() => setReview(null)} onSubmit={() => save(true)}/>}
  </>;
}
