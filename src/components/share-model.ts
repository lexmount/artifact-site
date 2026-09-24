// The DECISIONS AND COPY for the share-links screen. The component keeps only DOM and requests; anything whose correctness can be stated on its own moves here.
//
// Why it deserves its own file: the repo's vitest environment is node (no jsdom, and none should be
// installed for this one screen), so components cannot be rendered and only pure functions can be
// asserted on for real — "when should the private warning appear", "exactly which instant do 7 days
// end at", "what should the UI say when the server reports this email is unregistered": get any one
// of these wrong and users will believe the link they sent out has a door on it.
//
// The other half of the reason is defense: this file's read* family does not assume the envelope
// shape the API returns (`{shares:[…]}` or a bare array, `url` or `token`). A share link is shown
// once; one parse failure loses it forever, so we would rather accept a few extra shapes.
import type { Share, ShareGrant, SharePolicy, SiteOpen, Visibility } from "@/lib/types";
import { type Locale, type Translator } from "@/lib/i18n";
import { relTime as baseRelTime } from "@/lib/rel-time";

// User-visible strings below are English source keys: components wrap them in `t(...)`, and
// helpers that build a sentence take the caller's `t` (hooks cannot run outside a component).

const DAY_MS = 86_400_000;

// ── Site visibility ──────────────────────────────────────────────────────────

/**
 * `private` is no longer a placeholder: lib/share.canReadSite now guards four exits (/s/<slug>,
 * GET /api/sites/<slug>, /api/preview/*, fork), so this tier finally does close the door — and that
 * is precisely what gives share links their meaning.
 */
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: "Public — listed on the home page",
  unlisted: "Unlisted — anyone with the link can view",
  private: "Private — authorized people and share links",
};

// ── Share policies ───────────────────────────────────────────────────────────

/** Dropdown order: the cautious choices first, "public" last. Same SET as the canonical
 *  `SHARE_POLICIES` in lib/types (asserted by test/share-ui.test.ts); only the order differs. */
export const SHARE_POLICY_MENU: readonly SharePolicy[] = ["login", "people", "passcode", "public"];

/** One row of the dropdown. The subject is always "who can open it", never the policy's internal name. */
export const POLICY_LABEL: Record<SharePolicy, string> = {
  public: "Anyone — opens for whoever has the link",
  login: "Signed-in users — needs an account on this site",
  people: "Specific people — only those on the list can open it",
  passcode: "Passcode — needs the link plus a passcode",
};

/** The short label in the list, squeezed into a chip. */
export const POLICY_SHORT: Record<SharePolicy, string> = {
  public: "Anyone",
  login: "Signed-in users",
  people: "Specific people",
  passcode: "Passcode",
};

/** The sentence under a selected tier. It states the COST, not a restatement of the label. */
export const POLICY_HINT: Record<SharePolicy, string> = {
  public: "No checks at all, same as today's public link: once it is forwarded, it cannot be taken back.",
  login: "Anyone who has ever signed in to this site can open it, including colleagues you do not know.",
  people: "Only people on the list can open it; everyone else sees \"no access\".",
  passcode: "The only option that also works for people without an account, and therefore the weakest — a passcode usually travels with the link.",
};

// ── Expiry ───────────────────────────────────────────────────────────────────

export type ExpiryChoice = "never" | "7d" | "30d" | "90d";

export const EXPIRY_CHOICES: ReadonlyArray<{ value: ExpiryChoice; label: string }> = [
  { value: "never", label: "Never expires" },
  { value: "7d", label: "Expires in 7 days" },
  { value: "30d", label: "Expires in 30 days" },
  { value: "90d", label: "Expires in 90 days" },
];

/**
 * Expiry → `expiresInDays` in the request body.
 *
 * THE API TAKES A NUMBER OF DAYS, NOT A TIMESTAMP, and only accepts 7/30/90; anything else is a 400,
 * and an unknown FIELD NAME is worse — POST treats the whole expiry as unset (forever), PATCH treats
 * it as "leave unchanged", and neither complains.
 * `null` = forever (the API expresses it as null / omitted).
 */
export function expiryDaysFor(choice: ExpiryChoice): number | null {
  switch (choice) {
    case "never": return null;
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
  }
}

/** Days → expiry instant, the same formula as the server's parseExpiry (now + days × one day). */
export function expiresAtFor(choice: ExpiryChoice, now: number): number | null {
  const days = expiryDaysFor(choice);
  return days == null ? null : now + days * DAY_MS;
}

/** Expiry instant → which tier the dropdown should echo. Values off the scale (edited by hand, or already expired) snap to the nearest tier. */
export function expiryChoiceOf(expiresAt: number | null, now: number): ExpiryChoice {
  if (expiresAt == null) return "never";
  const days = (expiresAt - now) / DAY_MS;
  if (days <= 7) return "7d";
  if (days <= 30) return "30d";
  return "90d";
}

export function expiryText(expiresAt: number | null, now: number, t: Translator): string {
  if (expiresAt == null) return t("Never expires");
  const left = expiresAt - now;
  if (left <= 0) return t("Expired");
  const days = Math.ceil(left / DAY_MS);
  return days <= 1 ? t("Expires in less than 1 day") : t("Expires in {days} days", { days });
}

// ── Status of one share ──────────────────────────────────────────────────────

export type ShareState = "live" | "revoked" | "expired";

/** The same boundary as lib/share.isLive: only `expiresAt > now` counts as live; equal means expired. */
export function shareState(share: Pick<Share, "revokedAt" | "expiresAt">, now: number): ShareState {
  if (share.revokedAt != null) return "revoked";
  if (share.expiresAt != null && share.expiresAt <= now) return "expired";
  return "live";
}

/**
 * If the server has already judged the status, use its answer. Browser clocks can be minutes off
 * from the server, and recomputing locally produces undiagnosable divergence like "the panel says
 * expired, but opening it works" — only one place has the authority to declare expiry.
 * Fall back to a local computation only when the server did not provide it (older responses).
 */
export function shareStateOf(share: ShareListItem, now: number): ShareState {
  return share.status ?? shareState(share, now);
}

export const SHARE_STATE_LABEL: Record<ShareState, string> = {
  live: "Active",
  revoked: "Revoked",
  expired: "Expired",
};

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/v/${token}`;
}

// ── Three sentences that must appear in the UI ───────────────────────────────

/** Nothing in this repo can send email. Without this sentence, users assume "added a person" means "notified a person" and then wait in vain for them to show up. */
export const NO_NOTIFY_NOTICE = "Nobody will be notified — you need to send the link yourself.";

/**
 * The unregistered-email path is the most insidious: the add succeeds, the name is on the list, yet
 * the person can never get in, and neither side gets any hint — because matching is against the
 * VERIFIED EMAIL they receive after signing in, and one character off means two different people.
 */
export const EMAIL_EXACT_NOTICE =
  "This email has never signed in here. The person's sign-in email must match it exactly, or they will never get in — and neither of you will be told.";

/** Newly created links remain available through the management listing. */
export const LINK_REUSE_NOTICE = "You can view and copy this link here at any time.";

/**
 * While the front door is still open, a restricted share is decoration: the single public address
 * `/s/<slug>` bypasses the whole policy. Warn only when A RESTRICTED LIVE SHARE ACTUALLY EXISTS — a
 * public site with public shares is a perfectly legitimate combination, and nagging about it would
 * only train users to ignore this warning.
 */
export function needsPrivateNudge(
  visibility: Visibility,
  shares: ReadonlyArray<Pick<Share, "policy" | "revokedAt" | "expiresAt">>,
  now: number,
): boolean {
  if (visibility === "private") return false;
  return shares.some((s) => s.policy !== "public" && shareState(s, now) === "live");
}

export function privateNudgeText(slug: string, t: Translator): string {
  return t("This site can still be opened directly at /s/{slug} — anyone with the site address bypasses the share policies below. Set visibility to \"Private\", otherwise these restricted shares are only decorative.", { slug });
}

// ── People ───────────────────────────────────────────────────────────────────

/** Searches shorter than this send no request: a single character matches half the address book, which would turn the user directory into a public lookup endpoint. */
export const MIN_SEARCH_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;

export function searchShouldRun(query: string): boolean {
  return query.trim().length >= MIN_SEARCH_CHARS;
}

/** One person on the list. At least one of userId and email is present — a userId means they have signed in to this site. */
export interface PickedPerson {
  userId: string | null;
  email: string | null;
  displayName?: string | null;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Only asks "does it look like an email". The real check is on the server; this catches "typed a name and hit Enter". */
export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Dedup key. The same person may be found by search (with a userId) and also added again by typing the email. */
export function personKey(p: PickedPerson): string {
  return p.userId ? `u:${p.userId}` : `e:${normalizeEmail(p.email ?? "")}`;
}

export function addPerson(list: ReadonlyArray<PickedPerson>, next: PickedPerson): PickedPerson[] {
  const key = personKey(next);
  if (list.some((p) => personKey(p) === key)) return [...list];
  return [...list, next];
}

export function removePerson(list: ReadonlyArray<PickedPerson>, target: PickedPerson): PickedPerson[] {
  const key = personKey(target);
  return list.filter((p) => personKey(p) !== key);
}

export function personLabel(p: PickedPerson, t: Translator): string {
  return p.displayName?.trim() || p.email?.trim() || p.userId || t("Unknown");
}

/** Email only, no account — i.e. the kind EMAIL_EXACT_NOTICE has to be attached to. */
export function isPendingPerson(p: PickedPerson): boolean {
  return p.userId == null;
}

// ── View log ─────────────────────────────────────────────────────────────────

/** Display fields the API adds on top of SiteOpen (one row of share_views ∪ site_views), joined on
 *  the server — the frontend does not look people up itself. A null shareId means this open came
 *  through the direct /s/ address, not through any share link. */
export interface ShareViewRow extends SiteOpen {
  displayName?: string | null;
  email?: string | null;
  shareLabel?: string | null;
  sharePolicy?: SharePolicy | null;
}

export function viewerLabel(v: ShareViewRow, t: Translator): string {
  const named = v.displayName?.trim() || v.email?.trim();
  if (named) return named;
  return v.userId ? v.userId : t("Not signed in");
}

/** "Which share it came from". The direct-access case comes first — it has no share to look up; for
 *  rows with a share the note takes precedence, falling back to the policy name, and only then to
 *  the id prefix. */
export function viaLabel(v: ShareViewRow, shares: ReadonlyArray<Pick<ShareListItem, "id" | "label" | "policy">>, t: Translator): string {
  if (v.shareId == null) return t("Opened directly");
  const hit = shares.find((s) => s.id === v.shareId);
  const label = v.shareLabel?.trim() || hit?.label?.trim();
  if (label) return label;
  const policy = v.sharePolicy ?? hit?.policy;
  return policy ? t(POLICY_SHORT[policy]) : v.shareId.slice(0, 8);
}

/** View summary — the aggregate block the API provides on top of the detail rows. See
 *  /api/sites/[slug]/views: the definition is "opens by anyone other than me and collaborators", the
 *  window is set by the server (windowMs), and the frontend only reads it out. */
export interface ViewsSummary {
  windowMs: number;
  opens: number;
  uniqueViewers: number;
  lastViewedAt: number | null;
}

export function readViewsSummary(body: unknown): ViewsSummary | null {
  const o = asObject(asObject(body).summary);
  if (typeof o.opens !== "number" || typeof o.uniqueViewers !== "number") return null;
  return {
    windowMs: typeof o.windowMs === "number" && o.windowMs > 0 ? o.windowMs : 7 * 86_400_000,
    opens: o.opens,
    uniqueViewers: o.uniqueViewers,
    lastViewedAt: typeof o.lastViewedAt === "number" ? o.lastViewedAt : null,
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function relTime(ts: number, now: number, t: Translator, locale: Locale = "en"): string {
  return baseRelTime(ts, t, locale, now);
}

// ── API envelopes: lenient on input ──────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickArray(body: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const o = asObject(body);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

/**
 * One share, IN THE SHAPE THE LIST ENDPOINT RETURNS (`ShareSummary`).
 *
 * Deliberately not reusing `Share`: that is the storage-layer row, carrying `siteId`/`createdBy`/
 * `createdAnonId`, none of which the list endpoint returns — the management response also includes a recoverable URL for new links. The list carries things the storage layer
 * lacks: the server-computed `status`, and the people list for the "people" tier (which is why there
 * is no `GET …/grants` route, nor any need for one).
 */
export interface ShareListItem {
  revision?: number;
  source?: "publish" | "manual" | null;
  url?: string | null;
  mode?: "view" | "comment" | "edit";
  versionId?: string | null;
  id: string;
  policy: SharePolicy;
  label: string | null;
  hasPasscode: boolean;
  /** Q&A mode switch (older responses lack this field — absent always means off). */
  allowAi?: boolean;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  status?: ShareState;
  live?: boolean;
  grants?: ReadonlyArray<{ userId: string | null; email: string | null; displayName?: string | null; pending?: boolean }>;
  grantCount?: number;
}

export function readShares(body: unknown): ShareListItem[] {
  return pickArray(body, "shares", "items", "data").filter((x): x is ShareListItem => str(asObject(x).id) != null);
}

const QUICK_SHARE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const QUICK_SHARE_LIFETIME_TOLERANCE_MS = 1000;

/** A quick-share click is idempotent: reuse the newest matching live, latest-version link. */
export function reusableQuickShare(
  shares: ReadonlyArray<ShareListItem>,
  policy: "public" | "login",
  now: number,
): ShareListItem | null {
  const mode = policy === "login" ? "comment" : "view";
  return [...shares]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((share) => share.policy === policy
      && share.mode === mode
      && share.versionId == null
      && share.label == null
      && !share.allowAi
      && !share.hasPasscode
      && share.expiresAt != null
      && Math.abs((share.expiresAt - share.createdAt) - QUICK_SHARE_LIFETIME_MS) <= QUICK_SHARE_LIFETIME_TOLERANCE_MS
      && Boolean(share.url)
      && shareStateOf(share, now) === "live") ?? null;
}

/** The people list is taken straight from the list row — there is no separate GET; every "people" share carries its grants. */
export function readListedGrants(share: ShareListItem): PickedPerson[] {
  return (share.grants ?? []).map((g) => ({
    userId: g.userId ?? null,
    email: g.email ?? null,
    displayName: g.displayName ?? null,
  }));
}

export function readGrants(body: unknown): ShareGrant[] {
  return pickArray(body, "grants", "people", "items").filter((x): x is ShareGrant => {
    const o = asObject(x);
    return str(o.userId) != null || str(o.email) != null;
  });
}

export function readViews(body: unknown): ShareViewRow[] {
  return pickArray(body, "views", "items", "data").filter((x): x is ShareViewRow => {
    return typeof asObject(x).viewedAt === "number";
  });
}

/** The one-time-only material from the create response. */
export interface MintedShare {
  share: Share | null;
  shareId: string | null;
  url: string;
  passcode: string | null;
}

/**
 * Parsing the plaintext link must be lenient: the API may return a full `url`, or only a `token` for
 * the frontend to assemble. Both forms are accepted for compatibility with older servers.
 */
export function readMinted(body: unknown, origin: string): MintedShare | null {
  const o = asObject(body);
  const shareObj = asObject(o.share);
  const url = str(o.url) ?? str(o.link) ?? str(shareObj.url);
  const token = str(o.token) ?? str(shareObj.token);
  const resolved = url ?? (token ? shareUrl(origin, token) : null);
  if (!resolved) return null;
  const share = str(shareObj.id) ? (o.share as Share) : null;
  return {
    share,
    shareId: share?.id ?? str(o.shareId) ?? str(o.id),
    url: resolved,
    passcode: str(o.passcode) ?? str(shareObj.passcode) ?? str(o.code),
  };
}

/**
 * The result of adding a person. THE PENDING BIT IS WHAT MATTERS: whether or how the server phrases
 * it is irrelevant — as long as the stored row has no userId, the person has never signed in here,
 * and the UI must show EMAIL_EXACT_NOTICE immediately. This is the only chance on this path to warn
 * the user that "if the email is mistyped, nobody will ever tell you".
 */
export function readGrantResult(body: unknown, fallback: PickedPerson): { person: PickedPerson; pending: boolean } {
  const o = asObject(body);
  const raw = asObject(o.grant ?? o.person ?? o.user ?? body);
  const person: PickedPerson = {
    // Only userId counts: the `id` in the response is quite likely the id of this grant or of the
    // share, and mistaking it would display an unregistered person as registered, swallowing the one
    // warning that should have appeared.
    userId: str(raw.userId) ?? fallback.userId,
    email: str(raw.email) ?? fallback.email,
    displayName: str(raw.displayName) ?? fallback.displayName ?? null,
  };
  const flagged = o.status === "pending" || o.pending === true || raw.pending === true
    || o.invited === true || o.matched === false || o.registered === false;
  return { person, pending: flagged || person.userId == null };
}

/**
 * PATCH may also emit a passcode: when a share is switched to the "Passcode" tier and does not have
 * one yet, the server mints one on the spot — and just like at creation it APPEARS IN THIS ONE
 * RESPONSE ONLY. Fail to catch it and the user ends up with a link nobody can open.
 */
export function readFreshPasscode(body: unknown): string | null {
  const o = asObject(body);
  return str(o.passcode) ?? str(asObject(o.share).passcode);
}

export function errorText(body: unknown, fallback: string): string {
  const o = asObject(body);
  return str(o.error) ?? str(o.message) ?? fallback;
}

/** Only edited values are sent: saving a different field must not restart expiry. */
export interface ShareSettingsDraft {
  label?: string;
  mode?: "view" | "comment" | "edit";
  policy?: SharePolicy;
  allowAi?: boolean;
  expiry?: ExpiryChoice;
  people?: PickedPerson[];
}

export function shareSettingsPatch(share: ShareListItem, draft: ShareSettingsDraft, now: number): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.label !== undefined && (draft.label.trim() || null) !== share.label) patch.label = draft.label.trim() || null;
  if (draft.mode !== undefined && draft.mode !== (share.mode ?? "view")) patch.mode = draft.mode;
  if (draft.policy !== undefined && draft.policy !== share.policy) patch.policy = draft.policy;
  if (draft.allowAi !== undefined && draft.allowAi !== (share.allowAi === true)) patch.allowAi = draft.allowAi;
  if (draft.expiry !== undefined && draft.expiry !== expiryChoiceOf(share.expiresAt, now)) patch.expiresInDays = expiryDaysFor(draft.expiry);
  if ((draft.policy ?? share.policy) === "people" && draft.people) {
    const keys = (people: PickedPerson[]) => people.map(personKey).sort().join("\n");
    if (keys(draft.people) !== keys(readListedGrants(share))) {
      patch.grants = draft.people.map(p => p.userId ? { userId: p.userId } : { email: p.email });
    }
  }
  return patch;
}

/** Distinguish a stale form from a permanently revoked link. */
export function shareConflictCode(body: unknown): "share_revision_conflict" | "share_revoked" | null {
  const code = asObject(body).code;
  return code === "share_revision_conflict" || code === "share_revoked" ? code : null;
}

/** Preserve existing query parameters and fragments when opening a discussion. */
export function shareDiscussionUrl(url: string): string {
  const target = new URL(url);
  target.searchParams.set("comments", "1");
  return target.href;
}
