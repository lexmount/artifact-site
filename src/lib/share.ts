import type { Authority } from "@/lib/authz";
import { sessionReceiptShare } from "@/lib/notifications/receipts";
import { databaseRoleAllows, everyoneRole } from "@/lib/role-bindings";
import { readerVersionAllowed } from "@/lib/version-access";
import { managementReason } from "@/lib/management-reason";

import { tenantActive, accountSiteRole, managementRole, recordRbacAudit } from "@/lib/rbac-access";
import { rbacQuery, getSite, getVersion } from "@/lib/db";
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
import { getShareByTokenHash, recordSiteOpen } from "@/lib/db";
import { resolveSession } from "@/lib/session";
import { recordAdminRead, resolveAdmin } from "@/lib/admin";
import { resolveAuthority, resolveViewer, isAnonymousCreator } from "@/lib/authz";
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

/** Reader lookup uses token hashes; passcodes remain hash-only. */
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
  const site = await getSite(share.siteId);
  if (!site || site.deletedAt || site.takenDownAt || !(await tenantActive(site.tenantId))) return { ok: false, reason: "notFound" };

  return sharePolicyAccess(request, share, opts);
}

/** Shared policy admission only; callers must separately verify token, resource and liveness.
 * RBAC query reads participate in a caller's authorization transaction. Unknown policies deny. */
export async function sharePolicyAccess(
  request: Request,
  share: ShareRow,
  opts: { passcodeAttempt?: string | null; session?: Session | null } = {},
): Promise<ShareAccess> {
  switch (share.policy) {
    case "public":
      return { ok: true, share };

    case "login":
    case "people": {
      const session =
        opts.session === undefined
          ? await resolveSession(request)
          : opts.session;
      if (!session) return { ok: false, reason: "needsLogin", share };
      if (share.policy === "login") return { ok: true, share };
      // `people`: the account may be named directly, or by an e-mail address that had not signed in
      // when the owner added it. Only a VERIFIED address may satisfy the latter — an unverified one
      // is attacker-controllable, so someone could claim their way onto any list.
      const grants = await rbacQuery(
        "SELECT g.share_id FROM share_grants g JOIN users u ON u.id=$2 WHERE g.share_id=$1 AND (g.user_id=$2 OR (u.email_verified=TRUE AND u.email IS NOT NULL AND u.email<>'' AND g.email IS NOT NULL AND LOWER(g.email)=LOWER(u.email))) LIMIT 1",
        [share.id, session.userId],
      );
      return grants.length
        ? { ok: true, share }
        : { ok: false, reason: "notInvited", share };
    }

    case "passcode": {
      if (!share.passcodeHash)
        return { ok: false, reason: "needsPasscode", share };
      if (opts.passcodeAttempt) {
        return safeEqual(hashPasscode(opts.passcodeAttempt), share.passcodeHash)
          ? { ok: true, share }
          : { ok: false, reason: "wrongPasscode", share };
      }
      return hasPasscodeCookie(request, share)
        ? { ok: true, share }
        : { ok: false, reason: "needsPasscode", share };
    }
    default:
      return { ok: false, reason: "notFound" };
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

/** A fork permanently copies original files, so it requires source-export authority. */
export async function canForkSite(request: Request, site: Site, session?: Session | null): Promise<boolean> {
  if (site.deletedAt || site.takenDownAt || !(await tenantActive(site.tenantId))) return false;
  const resolved = session === undefined ? await resolveSession(request) : session;
  const { role } = await resolveAuthority(resolveViewer(request, resolved), site);
  return await databaseRoleAllows(role, "site.source.export") && await canReadVersion(request,site,site.currentVersionId,resolved);
}

/**
 * WHY a reader may read: the page logs an administrator's opening of non-public content, and
 * that needs the reason, not just the verdict. `capability` covers the owner, collaborators and
 * the API-token administrator (who resolves as owner of everything); `admin` is an e-mail
 * administrator with no standing on the site — reading it is an act of administration.
 */
export type ReadAccess = "public" | "capability" | "share" | "admin";

export async function readAccess(request: Request, site: Site, session?: Session | null, audit = true, knownAuthority?: Authority): Promise<ReadAccess | null> {
  if (!(await tenantActive(site.tenantId)) || site.deletedAt) return null;
  const resolved = session === undefined ? await resolveSession(request) : session;
  const authority = knownAuthority ?? await resolveAuthority(resolveViewer(request, resolved), site);
  if (authority.source === "management") {
    if (audit) await recordRbacAudit(rbacQuery,site.tenantId,resolved?.userId ?? null,"site.read",site.id,(managementReason(request) ?? ""));
    return "admin";
  }
  if (["account", "operator", "anonymous-cookie", "anonymous-token"].includes(authority.source)) return "capability";
  if (authority.source === "everyone" && !site.takenDownAt) return "public";
  if (site.takenDownAt) return adminRead(request,resolved,site,audit);
  if (site.visibility !== "private") return "public";
  if (authority.source === "share") return "share";
  return adminRead(request,resolved,site,audit);
}

/** The administrator's door, and the log row that comes with it (see recordAdminRead). */
async function adminRead(request: Request, session: Session | null, site: Site, audit = true): Promise<ReadAccess | null> {
  const actor = await resolveAdmin(request, session);
  if (!actor) return null;
  if (audit) await recordAdminRead(request, actor, site);
  return "admin";
}

export async function canReadSite(request: Request, site: Site, session?: Session | null, audit = true, knownAuthority?: Authority): Promise<boolean> {
  return (await readAccess(request, site, session, audit, knownAuthority)) != null;
}

/** The link is an explicit credential, never inferred from another share's guest list. */
export function shareTokenFromRequest(request: Request): string | null {
  return request.headers.get("x-artifact-share") || new URL(request.url).searchParams.get("share");
}
export async function requestShareAccess(request: Request, site: Site, session?: Session | null): Promise<ShareRow | null> {
  const token = shareTokenFromRequest(request);
  if (!token) return null;
  const access = await resolveShareAccess(request,token,{session});
  return access.ok && access.share.siteId === site.id ? access.share : null;
}
/** A share grants exactly its fixed snapshot or the current version, never all history. */
export async function canReadVersion(request: Request, site: Site, versionId: string, session?: Session | null): Promise<boolean> {
  const version = await getVersion(versionId);
  if (site.deletedAt || !version || version.siteId !== site.id || !(await tenantActive(site.tenantId))) return false;
  if ((await readableVersionFilter(request, site, session))(versionId)) return true;
  if (shareTokenFromRequest(request)) return false;
  const resolved = session === undefined ? await resolveSession(request) : session;
  return Boolean(await sessionReceiptShare(site,versionId,resolved));
}
/** Resolve one request's standing once, then filter this site's version rows in memory. */
export async function readableVersionFilter(request: Request, site: Site, session?: Session | null): Promise<(id: string) => boolean> {
  if (site.deletedAt || !(await tenantActive(site.tenantId))) return () => false;
  const resolved = session === undefined ? await resolveSession(request) : session;
  if (await databaseRoleAllows(await accountSiteRole(site,resolved),"site.history.read") || await managementRole(request,site,resolved) || isAnonymousCreator(resolveViewer(request,resolved),site)) return () => true;
  if (!shareTokenFromRequest(request) && await databaseRoleAllows((await resolveAuthority(resolveViewer(request,resolved),site)).role, "site.history.read")) return () => true;
  const share = await requestShareAccess(request,site,resolved);
  if (share) {
    const direct = await accountSiteRole(site,resolved) || await everyoneRole(site.id);
    return (id) => readerVersionAllowed(site,id,share.versionId) || Boolean(direct) && readerVersionAllowed(site,id);
  }
  const readable = await canReadSite(request,site,resolved,false);
  return (id) => readable && readerVersionAllowed(site, id);
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
    if (!isReaderOpen(request)) return;
    await recordSiteOpen({
      shareId: share.id,
      siteId: share.siteId,
      userId,
      anonId: userId ? null : anonId,
      ip,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      viewedAt: Date.now(),
    }, VIEW_COLLAPSE_MS);
  } catch (error) {
    console.error("[views] Failed to record share opening", { siteId: share.siteId, ...viewErrorDiagnostic(error) });
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
    if (!isReaderOpen(request)) return;
    const ua = request.headers.get("user-agent") ?? "";

    const ip = clientIp(request);
    const userId = session?.userId ?? null;
    await recordSiteOpen({
      shareId: null,
      siteId: site.id,
      userId,
      anonId: userId ? null : anonId,
      ip,
      userAgent: ua.slice(0, 300) || null,
      viewedAt: Date.now(),
    }, VIEW_COLLAPSE_MS);
  } catch (error) {
    console.error("[views] Failed to record direct opening", { siteId: site.id, ...viewErrorDiagnostic(error) });
    // Reading is the product; logging is bookkeeping. Never let the second break the first.
  }
}

/** Apply the same speculative-load and crawler policy to both entrances. */
function isReaderOpen(request: Request): boolean {
  if (request.headers.has("next-router-prefetch")) return false;
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  return !/prefetch|prerender|preview/i.test(purpose) && !CRAWLER_UA_RE.test(request.headers.get("user-agent") ?? "");
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

/** SQLSTATE/driver codes diagnose schema, authentication and lock failures without logging
 * SQL, parameters, detail or raw messages (which can contain reader identities/credentials).
 * Pool timeouts have no code, so classify their known message without echoing it.
 */
function viewErrorDiagnostic(error: unknown) {
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const errorName = typeof value.name === "string" && /^(?:Error|TypeError|RangeError|AggregateError|DatabaseError)$/.test(value.name) ? value.name : "UnknownError";
  const code = typeof value.code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30}|SQLITE_[A-Z_]{1,30})$/.test(value.code) ? value.code : undefined;
  const reason = typeof value.message === "string" && /timeout exceeded when trying to connect|connection timeout|timeout acquiring a client/i.test(value.message)
    ? "connection_timeout" : undefined;
  return { errorName, code, reason };
}
