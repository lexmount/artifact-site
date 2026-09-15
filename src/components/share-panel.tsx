"use client";
// Sharing settings — a right-side drawer, same shape as Version history. Owner-only, and it only renders at all
// when the server said so: the client decides nothing about permissions here, it just reflects the
// flags from describePermissions. A button the viewer cannot actually use is worse than no button.
//
// The drawer has two halves, corresponding to two DIFFERENT objects:
//
//   Upper half, "the site itself" — who gets to open the /s/<slug> door, and who may change the
//                                    content. Edits the sites row.
//   Lower half, "share links" — independent objects; a site can have several, each with its own
//                                policy, expiry, people list and view log, each revocable on its own.
//                                Edits the shares table.
//
// The split is not a layout preference: the relationship between the two is exactly where things go
// wrong — while the site is still public, no share link however strict stops anyone, because
// /s/<slug> stands open right next to it. That warning is share-links' job to display.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Globe, Link2, Loader2, Lock, Pencil, Share2, Trash2, UserPlus, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { drawerHost } from "@/components/version-history";
import ShareLinks from "@/components/share-links";
import { EDIT_POLICY_LABEL, EDIT_POLICY_LOCK_NOTICE, VISIBILITY_LABEL, reconcileSharing } from "@/components/share-model";
import type { EditPolicy, Visibility } from "@/lib/types";

interface Collaborator { role?: "admin" | "editor"; userId: string; email: string | null; displayName: string | null }

/** Writes are cookie-authenticated, so the server checks Origin exactly on each one. */
const writeHeaders = () => ({ "content-type": "application/json", origin: window.location.origin });

export default function SharePanel({ slug, onOpenChange, canManageAdmins = false }: {
  slug: string;
  /** While the drawer is open the parent must stop auto-collapsing the action bar — see the drawerHost comment in version-history. */
  onOpenChange?: (open: boolean) => void;
  canManageAdmins?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Two tabs, as the design draws them: share links first (the thing people come here to make),
  // then the people and the site's own door.
  const [tab, setTab] = useState<"links" | "site">("links");
  // Starts true: the drawer only mounts its body when open, and the first thing it does is fetch.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [editPolicy, setEditPolicy] = useState<EditPolicy>("owner");
  const [people, setPeople] = useState<Collaborator[]>([]);
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"admin" | "editor">("editor");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Every setState happens in an async continuation, never synchronously in the effect body —
    // the latter is what react-hooks/set-state-in-effect flags, since it forces a second render
    // pass before paint. `alive` drops results from a drawer the user already closed.
    let alive = true;
    void (async () => {
      try {
        const [s, c] = await Promise.all([
          fetch(`/api/sites/${slug}/sharing`).then((r) => r.json()),
          fetch(`/api/sites/${slug}/collaborators`).then((r) => r.json()),
        ]);
        if (!alive) return;
        if (s.visibility) setVisibility(s.visibility);
        if (s.editPolicy) setEditPolicy(s.editPolicy);
        setPeople(c.collaborators ?? []);
      } catch {
        if (alive) setError(t("Failed to load sharing settings"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, slug, t]);

  // Tell the parent the drawer is open. Report a close on unmount too, so the parent never keeps the "a drawer is open" lock forever.
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  const save = useCallback(async (want: { visibility: Visibility; editPolicy: EditPolicy }) => {
    setError(null);
    // private × login is the "can change but cannot see" deadlock, and the server answers 400. Rather
    // than let the user eat an error, pull the edit tier back to owner and explain — whoever picks
    // private means "close the door", not "open up editing".
    const next = reconcileSharing(want);
    setNotice(next.adjusted ? t(EDIT_POLICY_LOCK_NOTICE) : null);
    const res = await fetch(`/api/sites/${slug}/sharing`, {
      method: "PUT",
      headers: writeHeaders(),
      body: JSON.stringify({ visibility: next.visibility, editPolicy: next.editPolicy }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? t("Failed to save"));
      return;
    }
    setVisibility(next.visibility);
    setEditPolicy(next.editPolicy);
  }, [slug, t]);

  /** This is what runs when the lower half's "consider switching to private" suggestion is pressed. */
  const goPrivate = useCallback(() => {
    void save({ visibility: "private", editPolicy });
  }, [save, editPolicy]);

  async function addPerson() {
    const value = email.trim();
    if (!value) return;
    setError(null);
    const res = await fetch(`/api/sites/${slug}/collaborators`, {
      method: "POST", headers: writeHeaders(), body: JSON.stringify({ email: value, role: memberRole }),
    });
    const body = await res.json();
    if (!res.ok) {
      // The common case is a colleague who has simply never signed in here yet.
      setError(body.code === "user_not_found" ? t("This email has not signed in here yet. Ask them to sign in once first.") : (body.error ?? t("Failed to add")));
      return;
    }
    setPeople((p) => [...p.filter(x => x.userId !== body.userId), body]);
    setEmail("");
  }

  async function removePerson(userId: string) {
    const res = await fetch(`/api/sites/${slug}/collaborators?userId=${encodeURIComponent(userId)}`, {
      method: "DELETE", headers: writeHeaders(),
    });
    if (!res.ok) { setError((await res.json()).error ?? t("Request failed")); return; }
    setPeople((p) => p.filter((x) => x.userId !== userId));
  }

  // Copy /s/<slug> — the canonical link, i.e. the one governed by the visibility scope directly above
  // this panel. Success or failure, the notice does the talking: the clipboard throws outright in an
  // insecure context, in which case the address is shown so people can take it themselves.
  async function copyCanonical(): Promise<void> {
    const url = `${window.location.origin}/s/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice(visibility === "private"
        ? t("Link copied · but the site is private, so only you can open it — use a share link below to give it to others")
        : t("Link copied · {scope}", { scope: t(VISIBILITY_LABEL[visibility]) }));
    } catch {
      setNotice(url);
    }
  }

  // Same as Version history: the drawer must escape `.fs-bar`, or it turns transparent and click-through the moment the action bar collapses.
  const host = drawerHost(typeof document === "undefined" ? null : document);

  return (
    <>
      <button className="btn primary" onClick={() => setOpen(true)}><Share2 size={14} /> {t("Sharing")}</button>
      {open && host && createPortal(
        <div className="drawer-scrim" role="presentation" onClick={() => setOpen(false)}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={t("Sharing")} onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head">
              <b>{t("Sharing")}</b>
              <button className="btn sm ghost" onClick={() => setOpen(false)} aria-label={t("Close")}><X size={14} /></button>
            </header>
            <div className="drawer-tabs" role="tablist" aria-label={t("Sharing")}>
              <button type="button" role="tab" aria-selected={tab === "links"} onClick={() => setTab("links")}>{t("Share links")}</button>
              <button type="button" role="tab" aria-selected={tab === "site"} onClick={() => setTab("site")}>{t("People and the site")}</button>
            </div>
            <div className="drawer-body share-body">
              {loading && <p className="drawer-note"><Loader2 size={14} className="spin" /> {t("Loading…")}</p>}
              {error && <p className="drawer-error" role="alert">{error}</p>}
              {notice && <p className="share-warn" role="status">{notice}</p>}

              {tab === "links" && <ShareLinks slug={slug} visibility={visibility} onRequestPrivate={goPrivate} />}

              {tab === "site" && (
                <>
                  {/* Invite collaborators — one input row + one row of people, no longer a three-tier stacked form block. */}
                  <section className="share-sec">
                    <h3 className="share-sec-title">{t("Invite collaborators")}</h3>
                    <div className="share-add">
                      <input
                        id="share-email" type="email" placeholder={t("A colleague's email")} value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void addPerson(); }}
                      />
                      {canManageAdmins && <select aria-label={t("Site role")} value={memberRole} onChange={e=>setMemberRole(e.target.value as "admin" | "editor")}><option value="editor">{t("Collaborator")}</option><option value="admin">{t("Site administrator")}</option></select>}
                      <button className="btn" onClick={() => void addPerson()} aria-label={t("Add collaborator")}><UserPlus size={14} /></button>
                    </div>
                    {people.length > 0 && (
                      <ul className="share-people">
                        {people.map((p) => (
                          <li key={p.userId}>
                            <span>{p.displayName || p.email || p.userId} · {t(p.role === "admin" ? "Site administrator" : "Collaborator")}</span>
                            <button className="btn" disabled={p.role === "admin" && !canManageAdmins} aria-label={t("Remove")} onClick={() => void removePerson(p.userId)}>
                              <Trash2 size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* The site itself — two switches compressed into "icon · title/description · dropdown on the right" rows, readable at a glance. */}
                  <section className="share-sec">
                    <h3 className="share-sec-title">{t("The site itself")}</h3>

                    <div className="share-row">
                      <span className="share-row-icon" aria-hidden="true">
                        {visibility === "private" ? <Lock size={16} /> : <Globe size={16} />}
                      </span>
                      <div className="share-row-text">
                        <label htmlFor="share-visibility">{t("Who can open /s/{slug}", { slug })}</label>
                        <p>
                          {visibility === "private"
                            ? t("The site address itself is closed; only the share links below get in.")
                            : t("Anyone with this address can open it right now.")}
                        </p>
                      </div>
                      <select
                        id="share-visibility" value={visibility}
                        onChange={(e) => void save({ visibility: e.target.value as Visibility, editPolicy })}
                      >
                        <option value="public">{t(VISIBILITY_LABEL.public)}</option>
                        <option value="unlisted">{t(VISIBILITY_LABEL.unlisted)}</option>
                        <option value="private">{t(VISIBILITY_LABEL.private)}</option>
                      </select>
                    </div>

                    <div className="share-row">
                      <span className="share-row-icon" aria-hidden="true"><Pencil size={16} /></span>
                      <div className="share-row-text">
                        <label htmlFor="share-policy">{t("Who can edit")}</label>
                        <p>{t("Members and editable share links grant editing. Signing in alone does not.")}</p>
                      </div>
                      <select
                        id="share-policy" value={editPolicy}
                        onChange={(e) => void save({ visibility, editPolicy: e.target.value as EditPolicy })}
                      >
                        <option value="owner">{t(EDIT_POLICY_LABEL.owner)}</option>

                      </select>
                    </div>
                  </section>
                </>
              )}
            </div>

            {/* Footer — the one and only copy control. It sits directly under the visibility scope, so
                the scope is in view while copying; that is precisely why it was taken off the action
                bar: copying there, you cannot see what you are sending out. */}
            <footer className="share-foot">
              <button className="btn" onClick={() => void copyCanonical()}>
                <Link2 size={14} /> {t("Copy link")}
              </button>
              <span className="share-foot-scope">{t(VISIBILITY_LABEL[visibility])}</span>
            </footer>
          </aside>
        </div>,
        host,
      )}
    </>
  );
}
