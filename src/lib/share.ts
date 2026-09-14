// Read access control: who may SEE a site's content.
//
// Kept apart from lib/authz, which grades WRITE permission (none < content < manage < owner).
// Reading is a different question with a different input — a share link the reader was handed —
// and folding it into the capability ladder would mean every write path suddenly had to reason
// about share tokens. The two meet in exactly one place: manage-or-better always implies read.
//
// THE INVARIANT WORTH STATING: the gate has to sit on every route that can return bytes, not on the
// page. `/api/preview/*` is where the artifact actually comes out, and `POST /fork` copies the whole
// version tree into a site the forker owns — a gate on `/s/<slug>` alone stops nobody.
import { randomBytes } from "node:crypto";
import { safeEqual, sha256hex } from "@/lib/crypto";
import { isSecureRequest } from "@/lib/http";
import { getShareByTokenHash, getUser, hasRecentShareView, hasRecentSiteView, listLiveShares, recordShareView, recordSiteView, shareAdmits } from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { recordAdminRead, resolveAdmin } from "@/lib/admin";
import { resolveViewer, resolveCapability, atLeast, isAnonymousCreator } from "@/lib/authz";
import type { Session, Share, ShareRow, Site } from "@/lib/types";

/** Cookie carrying proof that a passcode was entered, scoped to one share. */
const PASSCODE_COOKIE_PREFIX = "ah_pass_";
const PASSCODE_TTL_MS = 12 * 60 * 60 * 1000;
/** Two openings by the same reader inside this window collapse to one view row. */
export const VIEW_COLLAPSE_MS = 30 * 60 * 1000;

export function createShareToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Codes are read aloud and retyped, so no 0/O/1/I/l. Case-insensitive on entry. */
const PASSCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function createPasscode(length = 6): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => PASSCODE_ALPHABET[b % PASSCODE_ALPHABET.length]).join("");
}

/** Tokens and passcodes are stored hashed: a read-only dump must not yield a working link. */
export function hashToken(token: string): string {
  return sha256hex(token);
}
export function hashPasscode(code: string): string {
  return sha256hex(code.trim().toUpperCase());
}

export function isLive(share: Pick<ShareRow, "revokedAt" | "expiresAt">, now = Date.now()): boolean {
  if (share.revokedAt != null) return false;
  return share.expiresAt == null || share.expiresAt > now;
}

/**
 * Why a reader was refused. `notFound` deliberately covers revoked, expired AND never-existed:
 * distinguishing them would let anyone probe whether a token was ever real.
 */
export type ShareDenial = "notFound" | "needsLogin" | "notInvited" | "needsPasscode" | "wrongPasscode";

export type ShareAccess =
  | { ok: true; share: ShareRow }
  | { ok: false; reason: ShareDenial; share?: ShareRow };

/**
 * Can this request open this share link?
 *
 * `passcodeAttempt` is the code just submitted from the entry page; when absent we fall back to the
 * cookie a previous successful entry left behind. Subresources only ever have the cookie, which is
 * the whole reason the grant is a cookie and not a URL parameter: an artifact fetching its own
 * `app.js` cannot carry a query string we invented.
 */
export async function resolveShareAccess(
  request: Request,
  token: string,
  opts: { passcodeAttempt?: string | null; session?: Session | null } = {},
): Promise<ShareAccess> {
  const share = await getShareByTokenHash(hashToken(token));
  if (!share || !isLive(share)) return { ok: false, reason: "notFound" };

  switch (share.policy) {
    case "public":
      return { ok: true, share };

    case "login":
    case "people": {
      const session = opts.session === undefined ? await resolveSession(request) : opts.session;
      if (!session) return { ok: false, reason: "needsLogin", share };
      if (share.policy === "login") return { ok: true, share };
      // `people`: the account may be named directly, or by an e-mail address that had not signed in
      // when the owner added it. Only a VERIFIED address may satisfy the latter — an unverified one
      // is attacker-controllable, so someone could claim their way onto any list.
      const user = await getUser(session.userId);
      const verified = user?.emailVerified ? user.email : null;
      return (await shareAdmits(share.id, session.userId, verified))
        ? { ok: true, share }
        : { ok: false, reason: "notInvited", share };
    }

    case "passcode": {
      if (!share.passcodeHash) return { ok: false, reason: "needsPasscode", share };
      if (opts.passcodeAttempt) {
        return safeEqual(hashPasscode(opts.passcodeAttempt), share.passcodeHash)
          ? { ok: true, share }
          : { ok: false, reason: "wrongPasscode", share };
      }
      return hasPasscodeCookie(request, share)
        ? { ok: true, share }
        : { ok: false, reason: "needsPasscode", share };
    }
  }
}

// --- passcode grant cookie ----------------------------------------------------
// Stateless: value = sha256(shareId + passcodeHash + expiry) + expiry. Revocation and policy
// changes invalidate it for free — the passcode hash is part of the input, and the share is
// re-read on every request anyway, so there is no second table to keep in step.

function passcodeCookieName(shareId: string): string {
  return `${PASSCODE_COOKIE_PREFIX}${shareId}`;
}

function passcodeCookieValue(share: ShareRow, expiry: number): string {
  return `${expiry}.${sha256hex(`${share.id}:${share.passcodeHash}:${expiry}`)}`;
}

export function buildPasscodeCookie(request: Request, share: ShareRow): string {
  const expiry = Date.now() + PASSCODE_TTL_MS;
  const secure = isSecureRequest(request);
  const parts = [
    `${passcodeCookieName(share.id)}=${passcodeCookieValue(share, expiry)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(PASSCODE_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Exported for tests: the cookie's whole invalidation story lives in how it is computed. */
export function hasPasscodeCookie(request: Request, share: ShareRow): boolean {
  const header = request.headers.get("cookie");
  if (!header || !share.passcodeHash) return false;
  const name = passcodeCookieName(share.id);
  // Deliberately NOT lib/http.readCookie: this grant is a self-authenticating digest, so a planted
  // duplicate cannot forge anything — the first match is verified below and a wrong one simply
  // fails. Switching to duplicate-rejection would change behaviour for no security gain.
  const hit = header.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name}=`));
  if (!hit) return false;
  const [expiryRaw, digest] = hit.slice(name.length + 1).split(".");
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || !digest) return false;
  return safeEqual(`${expiry}.${digest}`, passcodeCookieValue(share, expiry));
}

// --- the site-level read gate -------------------------------------------------

/**
 * May this request read this site's content at all?
 *
 * Ordered cheapest-first, and deliberately generous in the first two arms: a site nobody has
 * restricted must keep behaving exactly as it does today. Existing links do not break — that is a
 * hard requirement, not a nicety.
 *
 *   1. visibility public/unlisted  → open, as always
 *   2. manage capability           → the owner and collaborators always get in
 *   3. any live share admits them  → the reader arrived through a link that says yes
 */
/**
 * Forking is not reading, and must not ride on a read grant. A fork is a NEW site owned by whoever
 * pressed the button: they can flip it public, share it onward, and keep it long after the original
 * share is revoked. So a "Signed-in users" share — meant to say "anyone signed in may look" — would
 * otherwise hand every signed-in user a permanent copy of a private artifact's whole file tree.
 * A private site is therefore forkable only by someone who could manage it anyway. Public and
 * unlisted sites are untouched, which is every site that exists today.
 */
export async function canForkSite(request: Request, site: Site, session?: Session | null): Promise<boolean> {
  if (site.visibility !== "private") return true;
  const resolved = session === undefined ? await resolveSession(request) : session;
  const viewer = resolveViewer(request, resolved);
  return atLeast(await resolveCapability(viewer, site), "manage");
}

/**
 * WHY a reader may read: the page logs an administrator's opening of non-public content, and
 * that needs the reason, not just the verdict. `capability` covers the owner, collaborators and
 * the API-token administrator (who resolves as owner of everything); `admin` is an e-mail
 * administrator with no standing on the site — reading it is an act of administration.
 */
export type ReadAccess = "public" | "capability" | "share" | "admin";

export async function readAccess(request: Request, site: Site, session?: Session | null): Promise<ReadAccess | null> {
  // Taken down: served to its owner, collaborators and administrators only, whatever the
  // visibility and whatever share links exist — a takedown must beat a public link.
  if (site.takenDownAt) {
    const resolved = session === undefined ? await resolveSession(request) : session;
    if (atLeast(await resolveCapability(resolveViewer(request, resolved), site), "manage")) return "capability";
    return adminRead(request, resolved, site);
  }
  if (site.visibility !== "private") return "public";

  const resolved = session === undefined ? await resolveSession(request) : session;
  const viewer = resolveViewer(request, resolved);
  if (atLeast(await resolveCapability(viewer, site), "manage")) return "capability";
  // A read-only anonymous creator has no capability, but what they made is still theirs to look at.
  if (isAnonymousCreator(viewer, site)) return "capability";

  // A private site is reachable only through a share. Ask every live one: if the reader satisfies
  // any of them they are in, which is what makes "one artifact, several audiences" work.
  for (const share of await listLiveShares(site.id)) {
    if (await admitsViewer(request, share, resolved)) return "share";
  }
  // An administrator may open anything the console lists — judging a take-down needs the
  // content — but reading only: writes still go through the site's own capability chain.
  return adminRead(request, resolved, site);
}

/** The administrator's door, and the log row that comes with it (see recordAdminRead). */
async function adminRead(request: Request, session: Session | null, site: Site): Promise<ReadAccess | null> {
  const actor = await resolveAdmin(request, session);
  if (!actor) return null;
  await recordAdminRead(request, actor, site);
  return "admin";
}

export async function canReadSite(request: Request, site: Site, session?: Session | null): Promise<boolean> {
  return (await readAccess(request, site, session)) != null;
}

/** Does one share admit this request? Same rules as resolveShareAccess, minus the token lookup. */
async function admitsViewer(request: Request, share: ShareRow, session: Session | null): Promise<boolean> {
  switch (share.policy) {
    case "public":
      return true;
    case "login":
      return session != null;
    case "people": {
      if (!session) return false;
      const user = await getUser(session.userId);
      return shareAdmits(share.id, session.userId, user?.emailVerified ? user.email : null);
    }
    case "passcode":
      return hasPasscodeCookie(request, share);
  }
}

// --- view log -----------------------------------------------------------------

/**
 * Record one opening. Called ONLY from the share page — never from `/api/preview`, or a single
 * artifact with twenty assets would write twenty rows per visit.
 *
 * Best-effort: a failed insert must not stop someone reading. Repeat opens by the same reader
 * inside VIEW_COLLAPSE_MS collapse, so a refresh does not inflate the log.
 */
export async function logShareView(request: Request, share: Share, session: Session | null, anonId: string | null): Promise<void> {
  try {
    const ip = clientIp(request);
    const userId = session?.userId ?? null;
    if (await hasRecentShareView(share.id, userId, anonId, ip, Date.now() - VIEW_COLLAPSE_MS)) return;
    await recordShareView({
      shareId: share.id,
      siteId: share.siteId,
      userId,
      anonId: userId ? null : anonId,
      ip,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      viewedAt: Date.now(),
    });
  } catch {
    // Reading is the product; logging is bookkeeping. Never let the second break the first.
  }
}

/**
 * Link-preview crawlers (chat unfurlers, search bots) open /s/ pages too, and every one recorded
 * as a reader quietly inflates the numbers the owner sees. Matched against a deliberately SHORT
 * list: a false negative is one stray row, a false positive silently drops a real reader forever
 * — so no "headless", no "python", just the tokens crawlers actually self-declare.
 *
 * `bot` must also match as a suffix ("Googlebot/", "Slackbot-", "Lark-Bot/"), so it is anchored
 * on the delimiter AFTER it, not on a leading word boundary. Known cost: a phone model name like
 * "CUBOT NOTE" would match — accepted; chat unfurlers are everywhere and that handset is not.
 * Exported for tests.
 */
export const CRAWLER_UA_RE = /bot[/\-;) ]|\bbot\b|spider|crawler|facebookexternalhit|prerender/i;

/**
 * Record one direct opening of /s/<slug> — the site-level twin of logShareView, with the same
 * contract: called only from the page (never /api/preview, or every asset would count), repeat
 * opens by the same reader collapse for VIEW_COLLAPSE_MS, and a failed insert never stops the
 * read. Owners and collaborators ARE recorded — the row is cheap and keeps the log honest; the
 * stats queries exclude them instead, so the boundary lives in one place (the read side).
 *
 * Two openings that are not real readers are dropped at the door:
 *  - router prefetches (Next marks them; the user may never actually navigate), and
 *  - crawlers fetching a link preview.
 */
export async function logSiteOpen(request: Request, site: Site, session: Session | null, anonId: string | null): Promise<void> {
  try {
    if (request.headers.get("next-router-prefetch") != null) return;
    // Sec-Purpose / Purpose: browser-initiated speculative loads (prefetch/prerender).
    const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
    if (/prefetch|prerender|preview/i.test(purpose)) return;
    const ua = request.headers.get("user-agent") ?? "";
    if (CRAWLER_UA_RE.test(ua)) return;

    const ip = clientIp(request);
    const userId = session?.userId ?? null;
    if (await hasRecentSiteView(site.id, userId, anonId, ip, Date.now() - VIEW_COLLAPSE_MS)) return;
    await recordSiteView({
      siteId: site.id,
      userId,
      anonId: userId ? null : anonId,
      ip,
      userAgent: ua.slice(0, 300) || null,
      viewedAt: Date.now(),
    });
  } catch {
    // Reading is the product; logging is bookkeeping. Never let the second break the first.
  }
}

/** Gateway-set headers only — the same precedence lib/ratelimit uses, for the same reason. */
function clientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}
