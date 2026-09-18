"use client";
import { track } from "@/lib/analytics";
// Share links: a site can have several, each with its own policy, expiry, people list and view log, and each can be revoked on its own.
//
// Share URLs can be retrieved by managers; generated passcodes are shown once.
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Eye, Link2, Loader2, Plus, ShieldAlert } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import PeoplePicker from "@/components/people-picker";
import ShareSaveDialog, { type ShareSettingChange } from "@/components/share-save-dialog";
import ShareViews from "@/components/share-views";
import {
  EXPIRY_CHOICES, NO_NOTIFY_NOTICE, POLICY_HINT, POLICY_SHORT, SHARE_POLICY_MENU,
  SHARE_STATE_LABEL, LINK_REUSE_NOTICE, type ExpiryChoice, type MintedShare, type PickedPerson,
  type ShareSettingsDraft, shareSettingsPatch, type ShareListItem, personLabel, addPerson, errorText, expiryChoiceOf, expiryDaysFor, expiryText,
  needsPrivateNudge, privateNudgeText, readFreshPasscode, readGrantResult,
  shareConflictCode, readListedGrants, readMinted, readShares, relTime, removePerson, shareStateOf,
} from "@/components/share-model";
import type { SharePolicy, Visibility } from "@/lib/types";

/** All write routes are cookie-authenticated; the server checks Origin exactly on every one. */
const writeHeaders = () => ({ "content-type": "application/json", origin: window.location.origin });

/**
 * Freshly issued links and passcodes, retained while this panel is mounted.
 * `url` may be empty: when an existing share is switched to the "Passcode" tier, the server only
 * issues the passcode; the link stays the same (the token is unchanged), and its plaintext went out
 * with the response back when it was created.
 */
interface HeldSecret { url: string | null; passcode: string | null }

function CopyButton({ value, label, passcode = false }: { value: string; label: string; passcode?: boolean }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
    <button
      type="button" className="btn sm" aria-label={label}
      onClick={() => {
        void (async () => {
          setFailed(false);
          try { await navigator.clipboard.writeText(value); } catch { setFailed(true); return; }
          track("share_link_copy", { share_type: "share_link" });
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        })();
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? t("Copied") : t(passcode ? "Copy passcode" : "Copy link")}
    </button>
    {failed && <span className="share-copy-error" role="status">{t("Copy failed. Select the address to copy it manually.")}</span>}
    </>
  );
}

export default function ShareLinks({ slug, visibility, onRequestPrivate, onDirtyChange }: {
  slug: string;
  onDirtyChange?: (dirty: boolean) => void;
  visibility: Visibility;
  /** The "switch to private" button in the warning — the visibility dropdown in the upper half is what actually persists it. */
  onRequestPrivate: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [shares, setShares] = useState<ShareListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ShareListItem | null>(null);
  const [pending, setPending] = useState<{ share: ShareListItem; patch: Record<string, unknown>; changes: ShareSettingChange[] } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ShareSettingsDraft>>({});
  const [held, setHeld] = useState<Record<string, HeldSecret>>({});
  const [minted, setMinted] = useState<MintedShare | null>(null);
  const [grants, setGrants] = useState<Record<string, PickedPerson[]>>({});
  // The reference instant for "days left" is THE MOMENT OF FETCHING: calling Date.now() during render
  // is impure, and it would let "active / expired" silently flip on any re-render. The list is a
  // snapshot "as of the last refresh" anyway.
  const [asOf, setAsOf] = useState(0);

  // The create form. Defaults to "Signed-in users" — the most common intent, and tighter than public.
  const [creating, setCreating] = useState(false);
  const [policy, setPolicy] = useState<SharePolicy>("login");
  const [mode,setMode] = useState<"view"|"comment"|"edit">("view");
  const [versionId,setVersionId] = useState("");
  const [versions,setVersions] = useState<{id:string;createdAt:number;number?:number;official?:boolean}[]>([]);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [draftPeople, setDraftPeople] = useState<PickedPerson[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sites/${slug}/shares`, { cache: "no-store" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, t("Failed to load share links")));
      const list = readShares(body);
      setAsOf(Date.now());
      setShares(list);
      const versionResponse = await fetch(`/api/sites/${slug}/versions`, {cache:"no-store"});
      if (versionResponse.ok) setVersions((await versionResponse.json()).versions);
      // The people list comes with the list response (every "people" share carries its grants); there is no separate GET to pull.
      setGrants(Object.fromEntries(list.map((s) => [s.id, readListedGrants(s)])));
      setAsOf(Date.now());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load share links"));
      setShares(previous => previous ?? []);
      setAsOf(Date.now());
      return false;
    }
  }, [slug, t]);

  // Wrapped in an immediately-invoked async: setState must land in an async continuation; calling
  // it directly in the effect body (even via an async function) is flagged as a synchronous cascading
  // render by react-hooks/set-state-in-effect.
  useEffect(() => { void (async () => { await load(); })(); }, [load]);

  async function createShare() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${slug}/shares`, {
        method: "POST",
        headers: writeHeaders(),
        // expiresInDays, not a timestamp — with the wrong field name the API does not complain, it just treats the expiry as unset.
        body: JSON.stringify({ mode, versionId: versionId.trim() || null, policy, label: label.trim() || null, expiresInDays: expiryDaysFor(expiry) }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, t("Failed to create")));

      const fresh = readMinted(body, window.location.origin);
      if (!fresh) throw new Error(t("The share was created, but the link could not be read from the response. Revoke it and create a new one."));
      const shareId = fresh.shareId;
      setMinted(fresh);
      if (shareId) setHeld((h) => ({ ...h, [shareId]: { url: fresh.url, passcode: fresh.passcode } }));

      // The people list is a separate endpoint and can only be added to one by one once we have the
      // shareId. The ones that fail must be named, or the user will assume the whole list went in.
      const failed: string[] = [];
      if (policy === "people" && shareId) {
        for (const p of draftPeople) {
          try { await putGrant(shareId, p); } catch { failed.push(p.email ?? p.userId ?? "?"); }
        }
      }
      setDraftPeople([]);
      setLabel("");
      setCreating(false);
      await load();
      if (shareId) requestAnimationFrame(() => document.getElementById(`share-card-${shareId}`)?.scrollIntoView({ block: "nearest" }));
      if (failed.length) setError(t("The link was created, but these people could not be added to the list: {names}", { names: failed.join(", ") }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to create"));
    } finally {
      setBusy(false);
    }
  }

  async function putGrant(shareId: string, person: PickedPerson): Promise<{ pending: boolean }> {
    const res = await fetch(`/api/sites/${slug}/shares/${shareId}/grants`, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify(person.userId ? { userId: person.userId } : { email: person.email }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(body, t("Failed to add")));
    const result = readGrantResult(body, person);
    setGrants((g) => ({ ...g, [shareId]: addPerson(g[shareId] ?? [], result.person) }));
    return { pending: result.pending };
  }

  function requestSave(share: ShareListItem, patch: Record<string, unknown>) {
    if (saving || !Object.keys(patch).length) return;
    const changes: ShareSettingChange[] = [];
    const add = (label: string, before: string, after: string) => changes.push({ label, before, after });
    if ("label" in patch) add(t("Link name"), linkName(share), linkName({ ...share, label: typeof patch.label === "string" ? patch.label : null }));
    if (patch.policy) add(t("Who can open"), t(POLICY_SHORT[share.policy]), t(POLICY_SHORT[patch.policy as SharePolicy]));
    const modeLabel = (value: unknown) => t(value === "edit" ? "Can edit" : value === "comment" ? "Can comment" : "View only");
    if (patch.mode) add(t("Link permissions"), modeLabel(share.mode), modeLabel(patch.mode));
    if ("expiresInDays" in patch) add(t("Expiry"), expiryText(share.expiresAt, asOf, t), t(EXPIRY_CHOICES.find(c => expiryDaysFor(c.value) === patch.expiresInDays)!.label));
    if (Array.isArray(patch.grants)) add(t("Invited people"), readListedGrants(share).map(person => personLabel(person, t)).join(", ") || t("Nobody"), (drafts[share.id]?.people ?? []).map(person => personLabel(person, t)).join(", ") || t("Nobody"));
    if ("allowAi" in patch) add(t("AI assistant"), t(share.allowAi ? "Allowed" : "Not allowed"), t(patch.allowAi ? "Allowed" : "Not allowed"));
    setError(null);
    setPending({ share, patch, changes });
  }

  async function patchShare(share: ShareListItem, patch: Record<string, unknown>) {
    if (saving) return;
    setError(null);
    setSaved(null);
    setSaving(true);
    try {
      // Persist first, then update local state: the other way round produces undiagnosable divergence like "the UI says 30 days, the server still says forever".
      const res = await fetch(`/api/sites/${slug}/shares/${share.id}`, {
        method: "PATCH", headers: writeHeaders(), body: JSON.stringify({ ...patch, expectedRevision: share.revision }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && shareConflictCode(body)) {
          await load();
          setDrafts(current => { const next = { ...current }; delete next[share.id]; return next; });
          setPending(null);
          setError(shareConflictCode(body) === "share_revoked"
            ? t("This link has been revoked. Create a new link to share again.")
            : t("This link changed. Review the refreshed settings before saving again."));
        } else setError(errorText(body, t("Failed to save")));
        return;
      }
      // Switching to the "Passcode" tier makes the server mint a code on the spot, and it appears in
      // this one response only. Fail to catch it and the user is left holding a link even they cannot
      // open.
      const code = readFreshPasscode(body);
      if (code) setHeld((h) => ({ ...h, [share.id]: { url: h[share.id]?.url ?? null, passcode: code } }));
      setPending(null);
      if (minted?.shareId === share.id) setMinted(null);
      setDrafts(current => { const next = { ...current }; delete next[share.id]; return next; });
      if (await load()) setSaved(share.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to save"));
    } finally { setSaving(false); }
  }

  async function revoke(share: ShareListItem) {
    if (saving) return;
    setSaving(true);
    try {
    setError(null);
    const res = await fetch(`/api/sites/${slug}/shares/${share.id}`, { method: "DELETE", headers: writeHeaders() });
    if (!res.ok) {
      setError(errorText(await res.json().catch(() => ({})), t("Failed to revoke")));
      return;
    }
    setHeld((h) => { const next = { ...h }; delete next[share.id]; return next; });
    if (minted?.shareId === share.id) setMinted(null);
    setRevoking(null);
    setDrafts(current => { const next = { ...current }; delete next[share.id]; return next; });
    await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("Failed to revoke")); }
    finally { setSaving(false); }
  }

  const now = asOf;
  const list = shares ?? [];
  const nudge = needsPrivateNudge(visibility, list, now);
  const createDirty = creating && Boolean(label.trim() || draftPeople.length || policy !== "login" || mode !== "view" || versionId || expiry !== "never");
  const dirty = createDirty || list.some(s => Object.keys(shareSettingsPatch(s, drafts[s.id] ?? {}, now)).length > 0);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function editDraft(id: string, patch: ShareSettingsDraft) {
    setSaved(null);
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  function linkName(share: ShareListItem) { return share.label?.trim() || (share.source === "publish" ? t("Publication link") : t("Share link · {id}", { id: share.id.slice(-6) })); }
  function cancelCreate() {
    if (createDirty && !window.confirm(t("Discard this new link draft? No link will be created."))) return;
    setCreating(false); setDraftPeople([]); setLabel(""); setMode("view"); setPolicy("login"); setVersionId(""); setExpiry("never");
  }
  const renderShare = (s: ShareListItem) => {
            const state = shareStateOf(s, now);
            const secret = held[s.id];
            const url = s.url || secret?.url;
            const draft = drafts[s.id] ?? {};
            const patch = shareSettingsPatch(s, draft, now);
            const changed = Object.keys(patch).length > 0;
            return (
              <li key={s.id} id={`share-card-${s.id}`} className={`share-link is-${state}${minted?.shareId === s.id ? " is-new" : ""}`}>
                {minted?.shareId === s.id && <p className="share-save-status" role="status">{t("Link created")} · {t(LINK_REUSE_NOTICE)}</p>}
                {saved === s.id && <p className="share-save-status" role="status"><Check size={14} />{t("Saved · applies to the existing link")}</p>}
                <div className="share-link-head">
                  <b>{linkName(s)}</b>
                  <span className={`share-link-state is-${state}`}>{t(SHARE_STATE_LABEL[state])}</span>
                </div>
                {s.source && <span className="share-created">{t(s.source === "publish" ? "Created during publication" : "Created separately")}</span>}
                <div className="share-link-meta">
                  <span>{t(POLICY_SHORT[s.policy])}</span><span className="dot" aria-hidden="true" />
                  <span>{t(s.mode === "edit" ? "Can edit" : s.mode === "comment" ? "Can comment" : "View only")}</span>
                  <span className="dot" aria-hidden="true" /><span>{s.versionId ? t("Fixed version · {version}", { version: versions.find(v => v.id === s.versionId)?.number ?? s.versionId }) : t("Follow latest version")}</span>
                  <span className="dot" aria-hidden="true" /><span>{expiryText(s.expiresAt, now, t)}</span>

                </div>

                {url ? (
                  <div className="copy-field">
                    <code className="copy-field-value" title={url}>{url}</code>
                    <CopyButton value={url} label={t("Copy the link for {label}", { label: linkName(s) })} />
                  </div>
                ) : (
                  <p className="share-hint">{t("This link was created earlier. Its address was not saved by the older version and cannot be recovered. Its access rules still apply; create a new link if you have lost the address.")}</p>
                )}
                {/* The passcode issued on a tier switch — likewise shown only this once. */}
                {secret?.passcode && (
                  <div className="share-minted-code">
                    <span className="micro">{t("Passcode")}</span>
                    <code>{secret.passcode}</code>
                    <CopyButton value={secret.passcode} label={t("Copy passcode")} passcode />
                    <p className="share-hint">{t("Save this passcode now. It cannot be retrieved after closing this panel.")}</p>
                  </div>
                )}

                {state === "live" && (
                  <details className="share-link-settings">
                    <summary><span>{t("Edit link settings")}</span><span className="share-settings-summary">{changed && <span>{t("Unsaved changes")}</span>}<ChevronDown size={14} aria-hidden="true" /></span></summary>
                    <div className="share-settings-editor">
                    <p className="share-created">{t("Created {when}", { when: relTime(s.createdAt, now, t, locale) })}</p>
                  <fieldset disabled={saving} className="share-link-controls">
                    <label className="share-name-field"><span className="micro">{t("Link name")}</span><input maxLength={60} value={draft.label ?? s.label ?? ""} placeholder={linkName(s)} onChange={e => editDraft(s.id, {label: e.target.value})} /></label>
                    <label>
                      <span className="micro">{t("Link permissions")}</span>
                      <select aria-label={t("Link permissions")} value={draft.mode ?? s.mode ?? "view"} onChange={e=>editDraft(s.id,{mode:e.target.value as "view" | "comment" | "edit"})}><option value="view">{t("View only")}</option><option value="comment">{t("Can comment")}</option><option value="edit" disabled={!!s.versionId}>{t("Can edit")}</option></select>
                    </label>
                    <label>
                      <span className="micro">{t("Who can open")}</span>
                      <select value={draft.policy ?? s.policy} onChange={(e) => editDraft(s.id, { policy: e.target.value as SharePolicy })}>
                        {SHARE_POLICY_MENU.map((p) => <option key={p} value={p}>{t(POLICY_SHORT[p])}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="micro">{t("Expiry")}</span>
                      <select
                        value={draft.expiry ?? expiryChoiceOf(s.expiresAt, now)}
                        onChange={(e) => editDraft(s.id, { expiry: e.target.value as ExpiryChoice })}
                      >
                        {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
                      </select>
                    </label>
                    {/* Q&A mode: the reader uses their own cloud desk (their own sign-in, their own
                        compute), and the exposed surface is only content they could already see — so
                        this is a pure product switch, not a security switch; editing is not opened up
                        by it. */}
                    <label className="share-allow-ai">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-labelledby={`share-ai-title-${s.id}`}
                        aria-describedby={`share-ai-help-${s.id}`}
                        checked={draft.allowAi ?? s.allowAi === true}
                        onChange={(e) => editDraft(s.id, { allowAi: e.target.checked })}
                      />
                      <span className="share-ai-copy">
                        <span id={`share-ai-title-${s.id}`} className="share-ai-title">{t("Allow AI Q&A")}</span>
                        <span id={`share-ai-help-${s.id}`} className="share-ai-help">{t("Takes effect after saving.")} {t("Visitors can use their own AI assistant to ask about content they can access through this link. This does not grant editing access.")}</span>
                      </span>
                    </label>
                  </fieldset>

                  {(draft.policy ?? s.policy) === "people" && (
                    <PeoplePicker
                      idPrefix={`share-${s.id}`}
                      disabled={saving}
                      people={draft.people ?? grants[s.id] ?? []}
                      onAdd={(p) => editDraft(s.id, { people: addPerson(draft.people ?? grants[s.id] ?? [], p) })}
                      onRemove={(p) => editDraft(s.id, { people: removePerson(draft.people ?? grants[s.id] ?? [], p) })}
                    />
                  )}
                  <div className="share-settings-footer">
                    <button type="button" className="btn sm ghost danger" disabled={saving} onClick={() => { setError(null); setRevoking(s); }}>{t("Revoke")}</button>
                    <div className="share-link-actions">
                      <button type="button" className="btn sm" disabled={saving || !changed} onClick={() => setDrafts(current => { const next = { ...current }; delete next[s.id]; return next; })}>{t("Discard changes")}</button>
                      <button type="button" className="btn sm solid" disabled={saving || !changed} onClick={() => requestSave(s, patch)}>{t("Save link settings")}</button>
                    </div>
                  </div>
                  </div>
                  </details>
                )}
              </li>
            );

  };
  return (
    <section className="share-sec">
      {pending && <ShareSaveDialog label={linkName(pending.share)} changes={pending.changes}
        note={Object.keys(pending.patch).every(key => key === "label") ? t("Only the name changes. The link address and access permissions stay the same.") : undefined}
        expiryChanged={"expiresInDays" in pending.patch} busy={saving} error={error}
        onConfirm={() => void patchShare(pending.share, pending.patch)} onClose={() => setPending(null)} />}
      <p className="share-intro">{t("Create a separate link for each audience, with its own permissions and expiry.")}</p>

      {nudge && (
        <div className="share-nudge" role="status">
          <ShieldAlert size={15} aria-hidden="true" />
          <details>
            <summary>{t("The site address is still public")}</summary>
            <p>{privateNudgeText(slug, t)}</p>
            <button type="button" className="btn sm" onClick={onRequestPrivate}>{t("Review site visibility")}</button>
          </details>
        </div>
      )}

      {revoking && <ShareSaveDialog label={linkName(revoking)} title={t("Revoke share link")} confirmLabel={t("Revoke")} changes={[]} expiryChanged={false} busy={saving} error={error}
        note={t("Links already sent out will stop working immediately. This cannot be undone.")}
        onClose={() => setRevoking(null)} onConfirm={() => void revoke(revoking)} />}
      {error && <p className="share-error" role="alert">{error}</p>}

      {shares == null ? (
        <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="share-hint">{t("No share links yet.")}</p>
      ) : (
        <>
        <ul className="share-links">
          {list.filter(s => shareStateOf(s, now) === "live").map(renderShare)}
        </ul>
        {list.some(s => shareStateOf(s, now) !== "live") && <details className="share-history"><summary>{t("Expired and revoked links")} ({list.filter(s => shareStateOf(s, now) !== "live").length})</summary><ul className="share-links">{list.filter(s => shareStateOf(s, now) !== "live").map(renderShare)}</ul></details>}
        </>
      )}

      {creating ? (
        <div className="share-new">
          <div className="field">
            <label htmlFor="share-mode">{t("Link permissions")}</label>
            <select id="share-mode" value={mode} onChange={e=>{setMode(e.target.value as typeof mode);if(e.target.value === "edit")setVersionId("");}}><option value="view">{t("View only")}</option><option value="comment">{t("Can comment")}</option><option value="edit">{t("Can edit")}</option></select>
            {mode === "edit" && <p className="share-hint">{t("Editable links change this site for everyone following its latest version.")}</p>}
            <label htmlFor="share-version">{t("Shared version")}</label><select id="share-version" value={versionId} disabled={mode === "edit"} onChange={e=>setVersionId(e.target.value)}><option value="">{t("Follow latest version")}</option>{versions.map((v,i)=><option key={v.id} value={v.id}>{t("Version {n}",{n:v.number ?? versions.length-i})}{v.official ? ` · ${t("Official version")}` : ""} · {new Date(v.createdAt).toLocaleString(locale)}</option>)}</select>
            <label htmlFor="share-new-policy">{t("Who can open this link")}</label>
            <select id="share-new-policy" value={policy} onChange={(e) => setPolicy(e.target.value as SharePolicy)}>
              {SHARE_POLICY_MENU.map((p) => <option key={p} value={p}>{t(POLICY_SHORT[p])}</option>)}
            </select>
            <p className="share-hint">{t(POLICY_HINT[policy])}</p>
          </div>

          {policy === "people" && (
            <PeoplePicker
              idPrefix="share-draft"
              people={draftPeople}
              onAdd={(p) => { setDraftPeople((list) => addPerson(list, p)); }}
              onRemove={(p) => { setDraftPeople((list) => removePerson(list, p)); }}
            />
          )}

          {policy === "passcode" && (
            <p className="share-hint">
              {t("A 6-character passcode is generated on creation (without the easily confused 0/O/1/I). The passcode is")} <b>{t("shown only once")}</b>{t("; after that not even you can look it up — only its hash is stored.")}
            </p>
          )}

          <div className="field">
            <label htmlFor="share-new-label">{t("Link name")}</label>
            <input
              id="share-new-label" type="text" placeholder={t("e.g. for the client / weekly demo")} value={label}
              onChange={(e) => setLabel(e.target.value)} maxLength={60}
            />
          </div>

          <div className="field">
            <label htmlFor="share-new-expiry">{t("Expiry")}</label>
            <select id="share-new-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
              {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
            </select>
          </div>

          <p className="share-warn">{t(NO_NOTIFY_NOTICE)}</p>

          <div className="share-new-actions">
            <button type="button" className="btn sm solid" disabled={busy} onClick={() => void createShare()}>
              {busy ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />} {t("Create")}
            </button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={cancelCreate}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn sm" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t("New share link")}
        </button>
      )}

      <ShareViews slug={slug} shares={list} icon={<Eye size={13} />} />
    </section>
  );
}
