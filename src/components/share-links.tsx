"use client";
// Share links: a site can have several, each with its own policy, expiry, people list and view log, and each can be revoked on its own.
//
// Three things on this screen MUST NOT be gotten wrong; everything else is decoration:
//
//   1. The plaintext link appears exactly once, in the create response (the DB holds only the hash).
//      So after creation it must be pushed to the most prominent spot, with a clear "shown only this
//      once". For rows in the list that were not created in this session, say honestly that the link
//      cannot be retrieved — a "Copy link" that does nothing when clicked is worse than none.
//   2. While the site is still public/unlisted, a restricted share is decoration: the single address
//      `/s/<slug>` bypasses it. A warning is mandatory then, with a direct way to switch to private.
//   3. On the add-people path, "email not registered" is not an error but a normal outcome — yet the
//      user must learn on the spot that a mistyped email will never be reported by anyone. See
//      people-picker and share-model.EMAIL_EXACT_NOTICE.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Eye, Link2, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useLocale, useT } from "@/components/locale-provider";
import PeoplePicker from "@/components/people-picker";
import ShareViews from "@/components/share-views";
import {
  EXPIRY_CHOICES, NO_NOTIFY_NOTICE, POLICY_HINT, POLICY_LABEL, POLICY_SHORT, SHARE_POLICY_MENU,
  SHARE_STATE_LABEL, TOKEN_ONCE_NOTICE, type ExpiryChoice, type MintedShare, type PickedPerson,
  type ShareListItem, addPerson, errorText, expiryChoiceOf, expiryDaysFor, expiryText,
  needsPrivateNudge, privateNudgeText, readFreshPasscode, readGrantResult, readGrants,
  readListedGrants, readMinted, readShares, relTime, removePerson, shareStateOf,
} from "@/components/share-model";
import type { SharePolicy, Visibility } from "@/lib/types";

/** All write routes are cookie-authenticated; the server checks Origin exactly on every one. */
const writeHeaders = () => ({ "content-type": "application/json", origin: window.location.origin });

/**
 * Plaintext minted in this session. Gone on refresh, and like the server we keep no copy.
 * `url` may be empty: when an existing share is switched to the "Passcode" tier, the server only
 * issues the passcode; the link stays the same (the token is unchanged), and its plaintext went out
 * with the response back when it was created.
 */
interface HeldSecret { url: string | null; passcode: string | null }

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="btn sm" aria-label={label}
      onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(value); } catch { return; } // insecure context / refused: the text can still be selected by hand
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        })();
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? t("Copied") : t("Copy link")}
    </button>
  );
}

export default function ShareLinks({ slug, visibility, onRequestPrivate }: {
  slug: string;
  visibility: Visibility;
  /** The "switch to private" button in the warning — the visibility dropdown in the upper half is what actually persists it. */
  onRequestPrivate: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [shares, setShares] = useState<ShareListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [draftPeople, setDraftPeople] = useState<PickedPerson[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sites/${slug}/shares`, { cache: "no-store" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(body, t("Failed to load share links")));
      const list = readShares(body);
      setShares(list);
      // The people list comes with the list response (every "people" share carries its grants); there is no separate GET to pull.
      setGrants(Object.fromEntries(list.map((s) => [s.id, readListedGrants(s)])));
      setAsOf(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to load share links"));
      setShares([]);
      setAsOf(Date.now());
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
        body: JSON.stringify({ policy, label: label.trim() || null, expiresInDays: expiryDaysFor(expiry) }),
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

  async function dropGrant(shareId: string, person: PickedPerson) {
    const q = person.userId ? `userId=${encodeURIComponent(person.userId)}` : `email=${encodeURIComponent(person.email ?? "")}`;
    const res = await fetch(`/api/sites/${slug}/shares/${shareId}/grants?${q}`, {
      method: "DELETE", headers: writeHeaders(),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(body, t("Failed to remove")));
    // The delete endpoint returns the list as it stands after deletion; use it as is — deriving it locally would diverge from the server's normalization (lowercased emails).
    const fresh = readGrants(body);
    setGrants((g) => ({
      ...g,
      [shareId]: fresh.length || Array.isArray((body as { grants?: unknown }).grants)
        ? fresh.map((x) => ({ userId: x.userId, email: x.email, displayName: x.displayName ?? null }))
        : removePerson(g[shareId] ?? [], person),
    }));
  }

  async function patchShare(share: ShareListItem, patch: Record<string, unknown>) {
    setError(null);
    // Persist first, then update local state: the other way round produces undiagnosable divergence like "the UI says 30 days, the server still says forever".
    const res = await fetch(`/api/sites/${slug}/shares/${share.id}`, {
      method: "PATCH", headers: writeHeaders(), body: JSON.stringify(patch),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(errorText(body, t("Failed to save")));
      return;
    }
    // Switching to the "Passcode" tier makes the server mint a code on the spot, and it appears in
    // this one response only. Fail to catch it and the user is left holding a link even they cannot
    // open.
    const code = readFreshPasscode(body);
    if (code) setHeld((h) => ({ ...h, [share.id]: { url: h[share.id]?.url ?? null, passcode: code } }));
    await load();
  }

  async function revoke(share: ShareListItem) {
    if (!window.confirm(t("Revoke this share link? Links already sent out stop working immediately, and this cannot be undone."))) return;
    setError(null);
    const res = await fetch(`/api/sites/${slug}/shares/${share.id}`, { method: "DELETE", headers: writeHeaders() });
    if (!res.ok) {
      setError(errorText(await res.json().catch(() => ({})), t("Failed to revoke")));
      return;
    }
    setHeld((h) => { const next = { ...h }; delete next[share.id]; return next; });
    if (minted?.shareId === share.id) setMinted(null);
    await load();
  }

  const now = asOf;
  const list = shares ?? [];
  const nudge = needsPrivateNudge(visibility, list, now);

  return (
    <section className="share-sec">
      <h3 className="share-sec-title">{t("Share links")}</h3>
      <p className="share-hint">
        {t("What you send out is the")} <code>/v/…</code> {t("address, which is separate from the site's own")} <code>/s/{slug}</code>.
        {" "}{t("A site can have several shares, each with its own policy and expiry, and each can be revoked on its own.")}
      </p>

      {nudge && (
        <div className="share-nudge" role="status">
          <ShieldAlert size={15} aria-hidden="true" />
          <div>
            <p>{privateNudgeText(slug, t)}</p>
            <button type="button" className="btn sm solid" onClick={onRequestPrivate}>{t("Make private")}</button>
          </div>
        </div>
      )}

      {minted && (
        <div className="share-minted" role="status">
          <p className="eyebrow">{t("Link created")}</p>
          <p className="share-minted-once">{t(TOKEN_ONCE_NOTICE)}</p>
          <div className="copy-field">
            <code className="copy-field-value" title={minted.url}>{minted.url}</code>
            <CopyButton value={minted.url} label={t("Copy share link")} />
          </div>
          {minted.passcode && (
            <div className="share-minted-code">
              <span className="micro">{t("Passcode")}</span>
              <code>{minted.passcode}</code>
              <button type="button" className="btn sm" onClick={() => { void navigator.clipboard?.writeText(minted.passcode ?? ""); }}>
                {t("Copy passcode")}
              </button>
            </div>
          )}
          <p className="share-warn">{t(NO_NOTIFY_NOTICE)}</p>
          <button type="button" className="btn sm ghost" onClick={() => setMinted(null)}>{t("Saved it, dismiss")}</button>
        </div>
      )}

      {error && <p className="share-error" role="alert">{error}</p>}

      {shares == null ? (
        <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="share-hint">{t("No share links yet.")}</p>
      ) : (
        <ul className="share-links">
          {list.map((s) => {
            const state = shareStateOf(s, now);
            const secret = held[s.id];
            return (
              <li key={s.id} className={`share-link is-${state}`}>
                <div className="share-link-head">
                  <span className="kind-chip">{t(POLICY_SHORT[s.policy])}</span>
                  <span className={`share-link-state is-${state}`}>{t(SHARE_STATE_LABEL[state])}</span>
                  <b>{s.label?.trim() || t("Untitled")}</b>
                </div>
                <div className="share-link-meta">
                  <span>{t("Created {when}", { when: relTime(s.createdAt, now, t, locale) })}</span>
                  <span className="dot" aria-hidden="true" />
                  <span>{expiryText(s.expiresAt, now, t)}</span>
                  {s.hasPasscode && <><span className="dot" aria-hidden="true" /><span>{t("With passcode")}</span></>}
                </div>

                {secret?.url ? (
                  <div className="copy-field">
                    <code className="copy-field-value" title={secret.url}>{secret.url}</code>
                    <CopyButton value={secret.url} label={t("Copy the link for {label}", { label: s.label || t("share") })} />
                  </div>
                ) : (
                  <p className="share-hint">{t("The link was shown only once, when it was created, and cannot be retrieved now — only its hash is stored. To send it again, revoke this one and create a new one.")}</p>
                )}
                {/* The passcode issued on a tier switch — likewise shown only this once. */}
                {secret?.passcode && (
                  <div className="share-minted-code">
                    <span className="micro">{t("Passcode")}</span>
                    <code>{secret.passcode}</code>
                    <button type="button" className="btn sm" onClick={() => { void navigator.clipboard?.writeText(secret.passcode ?? ""); }}>
                      {t("Copy passcode")}
                    </button>
                  </div>
                )}

                {state === "live" && (
                  <div className="share-link-controls">
                    <label>
                      <span className="micro">{t("Who can open")}</span>
                      <select value={s.policy} onChange={(e) => void patchShare(s, { policy: e.target.value as SharePolicy })}>
                        {SHARE_POLICY_MENU.map((p) => <option key={p} value={p}>{t(POLICY_LABEL[p])}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="micro">{t("Expiry")}</span>
                      <select
                        value={expiryChoiceOf(s.expiresAt, now)}
                        onChange={(e) => void patchShare(s, { expiresInDays: expiryDaysFor(e.target.value as ExpiryChoice) })}
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
                        checked={s.allowAi === true}
                        onChange={(e) => void patchShare(s, { allowAi: e.target.checked })}
                      />
                      <span className="micro">{t("Allow the AI assistant through this link (read-only Q&A)")}</span>
                    </label>
                  </div>
                )}

                {state === "live" && s.policy === "people" && (
                  <PeoplePicker
                    idPrefix={`share-${s.id}`}
                    people={grants[s.id] ?? []}
                    onAdd={async (p) => { await putGrant(s.id, p); }}
                    onRemove={async (p) => { await dropGrant(s.id, p); }}
                  />
                )}

                <div className="share-link-actions">
                  {state === "live" && (
                    <button type="button" className="btn sm danger" onClick={() => void revoke(s)}>
                      <Trash2 size={13} /> {t("Revoke")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <div className="share-new">
          <div className="field">
            <label htmlFor="share-new-policy">{t("Who can open this link")}</label>
            <select id="share-new-policy" value={policy} onChange={(e) => setPolicy(e.target.value as SharePolicy)}>
              {SHARE_POLICY_MENU.map((p) => <option key={p} value={p}>{t(POLICY_LABEL[p])}</option>)}
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
              {t("A 6-character passcode is generated on creation (without the easily confused 0/O/1/I). Like the link, it is")} <b>{t("shown only once")}</b>{t("; after that not even you can look it up — only its hash is stored.")}
            </p>
          )}

          <div className="field">
            <label htmlFor="share-new-label">{t("Note (visible only to you)")}</label>
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
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => { setCreating(false); setDraftPeople([]); }}>
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
