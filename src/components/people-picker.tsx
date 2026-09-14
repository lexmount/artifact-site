"use client";
// The list editor for the "Specific people" tier. Two ways in, and both are required:
//
//   1. Search users who have signed in to this site — a hit proves they REALLY have an account, so
//      adding them is guaranteed to take effect.
//   2. Type an email and press Enter — the only option when they have never signed in here. Also the
//      one most likely to go wrong: the add succeeds, the name shows on the list, yet they can never
//      get in, because matching is against the verified email they get after signing in. So whenever
//      the stored row has no userId, the UI pushes EMAIL_EXACT_NOTICE right under that row.
//
// The component itself does no persistence: the draft state (share not created yet, no shareId to
// hang off) and an existing share use the same UI; the only difference is whether the parent wires
// onAdd/onRemove to a local array or to the /grants endpoint.
import { useEffect, useRef, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import {
  EMAIL_EXACT_NOTICE, MIN_SEARCH_CHARS, SEARCH_DEBOUNCE_MS, type PickedPerson,
  isEmailLike, isPendingPerson, personKey, personLabel, searchShouldRun,
} from "@/components/share-model";

interface SearchHit { id: string; displayName: string | null; email: string | null }

export default function PeoplePicker({ people, onAdd, onRemove, disabled, idPrefix }: {
  people: PickedPerson[];
  /** Add a person. Thrown errors are turned into visible error copy by the parent — the only job
   *  here is to never display a failure as a success. */
  onAdd: (person: PickedPerson) => Promise<void> | void;
  onRemove: (person: PickedPerson) => Promise<void> | void;
  disabled?: boolean;
  /** One drawer may hold several lists (one draft, one per "people" share), so label `for`s must not collide. */
  idPrefix: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If the person just added has no account yet, hang the full warning under their row.
  const [warnKey, setWarnKey] = useState<string | null>(null);
  const seq = useRef(0);

  // Search: only fires at >= 2 characters, debounced 250ms, and every older request is aborted.
  // Every setState sits in an async continuation (react-hooks/set-state-in-effect), and a monotonic
  // sequence number discards stale responses — AbortController can only cancel in-flight requests,
  // not the one that "already resolved but arrived a beat late".
  useEffect(() => {
    if (!searchShouldRun(query)) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          const res = await fetch(`/api/users/search?q=${encodeURIComponent(query.trim())}`, {
            signal: ctrl.signal, cache: "no-store",
          });
          const body: unknown = await res.json().catch(() => ({}));
          if (mine !== seq.current) return;
          const list = Array.isArray(body) ? body : (body as { users?: unknown }).users;
          setHits(Array.isArray(list) ? (list as SearchHit[]) : []);
        } catch {
          if (mine === seq.current) setHits([]); // no hits is not an error; the "add by email" path below already covers it
        } finally {
          if (mine === seq.current) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [query]);

  // Below the character threshold the state is not cleared — we simply do not render. One setState
  // fewer, and therefore one "cleared-out frame" fewer.
  const visibleHits = searchShouldRun(query)
    ? hits.filter((h) => !people.some((p) => personKey(p) === `u:${h.id}`))
    : [];

  async function add(person: PickedPerson) {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(person);
      setQuery("");
      setHits([]);
      setWarnKey(isPendingPerson(person) ? personKey(person) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to add"));
    } finally {
      setBusy(false);
    }
  }

  /** Enter: when nobody in the search results is selected, treat the input as an email address and add it. */
  function addTyped() {
    const raw = query.trim();
    if (!raw) return;
    if (!isEmailLike(raw)) {
      setError(t("Enter a full email address, or pick someone from the search results above"));
      return;
    }
    void add({ userId: null, email: raw, displayName: null });
  }

  async function remove(person: PickedPerson) {
    if (disabled) return;
    setError(null);
    try {
      await onRemove(person);
      if (personKey(person) === warnKey) setWarnKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Failed to remove"));
    }
  }

  const inputId = `${idPrefix}-people-search`;

  return (
    <div className="share-pick">
      <label className="share-pick-label" htmlFor={inputId}>{t("People")}</label>
      <div className="share-pick-input">
        <Search size={13} aria-hidden="true" />
        <input
          id={inputId} type="text" autoComplete="off" disabled={disabled}
          placeholder={t("Search by name or email (at least {n} characters), or type an email and press Enter", { n: MIN_SEARCH_CHARS })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }}
        />
        {searching ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
        <button type="button" className="btn sm" disabled={disabled || busy || !query.trim()} onClick={addTyped}>
          <UserPlus size={13} /> {t("Add")}
        </button>
      </div>

      {visibleHits.length > 0 && (
        <ul className="share-pick-results">
          {visibleHits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => void add({ userId: h.id, email: h.email, displayName: h.displayName })}>
                <b>{h.displayName || h.email || h.id}</b>
                {h.displayName && h.email ? <span>{h.email}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchShouldRun(query) && !searching && visibleHits.length === 0 && (
        <p className="share-hint">{t("No one who has signed in here matches. Type a full email and press Enter to reserve a spot for them.")}</p>
      )}

      {error && <p className="share-error" role="alert">{error}</p>}

      {people.length === 0 ? (
        <p className="share-hint">{t("The list is still empty — nobody can open this link right now.")}</p>
      ) : (
        <ul className="share-pick-list">
          {people.map((p) => {
            const key = personKey(p);
            const pending = isPendingPerson(p);
            return (
              <li key={key}>
                <div className="share-pick-row">
                  <span className="share-pick-name">{personLabel(p, t)}</span>
                  {pending && <span className="share-pick-pending">{t("Not registered")}</span>}
                  <button type="button" className="btn sm ghost" aria-label={t("Remove {name}", { name: personLabel(p, t) })}
                    disabled={disabled} onClick={() => void remove(p)}>
                    <X size={13} />
                  </button>
                </div>
                {pending && key === warnKey && <p className="share-warn" role="status">{t(EMAIL_EXACT_NOTICE)}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {people.some(isPendingPerson) && warnKey == null && (
        <p className="share-warn">{t(EMAIL_EXACT_NOTICE)}</p>
      )}
    </div>
  );
}
