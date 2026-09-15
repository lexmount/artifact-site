import "server-only";

// Administration: who counts as an administrator, and the acts the console performs. Every act
// here writes an admin_log row — the console has no silent buttons.
//
// Two kinds of administrator, deliberately:
//   token  the PUBLISH_API_TOKEN bearer — scripts, cron, the reconciler. Predates the console.
//   user   a signed-in account whose VERIFIED e-mail is in ARTIFACT_ADMIN_EMAILS.
// A publish token minted through the device flow never carries admin rights, even for an
// administrator's account: it is an agent's credential and it is long-lived.
import { AuthError, isAdmin as isTokenAdmin } from "@/lib/auth";
import { config } from "@/lib/config";
import { policy } from "@/lib/settings";
import { BadRequestError } from "@/lib/errors";
import {
  rbacTransaction, createId, expireAnonymousSites, getSite, getSiteBySlug, getUser, hasRecentAdminLog, insertAdminLog, listDeletedSitesBefore, restoreDeletedSite,
  revokeOauthTokensForUser, revokePublishTokensForUser, revokeUserSessions, setSitePurged, setSiteTakenDown, setUserDisabled, softDeleteSite,
} from "@/lib/db";
import { auditRequestMeta } from "@/lib/audit";
import { isTokenSession } from "@/lib/publish-token";
import { csrfSafe, resolveSession } from "@/lib/session";
import { getStorage } from "@/lib/storage";
import type { AdminAction, AdminLogEntry, Session, Site, User } from "@/lib/types";

export type AdminActor = { kind: "token"; userId: null } | { kind: "user"; userId: string; email: string } | { kind: "system"; userId: null };

/** The maintenance tick acts on its own; its log rows say so. */
export const SYSTEM_ACTOR: AdminActor = { kind: "system", userId: null };

export async function resolveAdmin(request: Request, session?: Session | null): Promise<AdminActor | null> {
  if (isTokenAdmin(request)) return { kind: "token", userId: null };
  if (config.adminEmails.size === 0) return null;
  const resolved = session === undefined ? await resolveSession(request) : session;
  if (!resolved || isTokenSession(resolved)) return null;
  const user = await getUser(resolved.userId);
  if (!user || user.disabledAt || !user.email || !user.emailVerified) return null;
  return config.adminEmails.has(user.email.toLowerCase()) ? { kind: "user", userId: user.id, email: user.email } : null;
}

/** True when this account's verified e-mail is on the administrator list. */
export function isAdminUser(user: User): boolean {
  return Boolean(user.email && user.emailVerified && config.adminEmails.has(user.email.toLowerCase()));
}

/** Read gate of every /api/admin route. 401, not 404: the routes are documented, only the console page hides. */
export async function requireAdmin(request: Request): Promise<AdminActor> {
  const actor = await resolveAdmin(request);
  if (!actor) throw new AuthError("Administrator access required");
  return actor;
}

/** Write gate: the read gate plus the CSRF rule for cookie-authenticated administrators. */
export async function requireAdminWrite(request: Request): Promise<AdminActor> {
  const actor = await requireAdmin(request);
  if (actor.kind === "user" && !csrfSafe(request)) throw new AuthError("Cross-site request rejected");
  return actor;
}

export async function recordAdminAction(
  request: Request | null,
  actor: AdminActor,
  action: AdminAction,
  target: { kind: AdminLogEntry["targetKind"]; id: string },
  reason: string | null = null,
): Promise<void> {
  await insertAdminLog({
    id: createId("adm"), actorKind: actor.kind, actorUserId: actor.userId, action,
    targetKind: target.kind, targetId: target.id, reason, ip: request ? auditRequestMeta(request).ip : null, createdAt: Date.now(),
  });
}

function cleanReason(reason: unknown, required: boolean): string | null {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (required && !text) throw new BadRequestError("A reason is required");
  if (text.length > 500) throw new BadRequestError("The reason is too long (500 characters at most)");
  return text || null;
}

// --- users --------------------------------------------------------------------------

/**
 * Disable an account: sign-in is refused from now on, every live session and publish token is
 * revoked, so agents running on its behalf get 403 at their next call. The account's sites stay
 * where they are (take them down separately if the content is the problem).
 */
export async function disableUser(request: Request, actor: AdminActor, userId: string, reason: unknown): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new BadRequestError("No such user");
  if (actor.kind === "user" && actor.userId === userId) throw new BadRequestError("You cannot disable your own account");
  if (isAdminUser(user)) throw new BadRequestError("Remove the address from ARTIFACT_ADMIN_EMAILS before disabling an administrator");
  const why = cleanReason(reason, true);
  await rbacTransaction(async q => {
    const stranded = await q("SELECT m.tenant_id FROM tenant_members m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.role='admin' AND t.disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_members other JOIN users u ON u.id=other.user_id WHERE other.tenant_id=m.tenant_id AND other.role='admin' AND other.user_id<>$1 AND u.disabled_at IS NULL)", [userId]);
    if (stranded.length) throw new BadRequestError("Assign another active tenant administrator before disabling this account");
    const changed = await q("UPDATE users SET disabled_at=$1,disabled_reason=$2 WHERE id=$3 AND disabled_at IS NULL RETURNING id", [Date.now(),why,userId]);
    if (!changed.length) throw new BadRequestError("The account is already disabled");
  });
  await revokeUserSessions(userId);
  await revokePublishTokensForUser(userId);
  await revokeOauthTokensForUser(userId);
  await recordAdminAction(request, actor, "user.disable", { kind: "user", id: userId }, why);
  return (await getUser(userId))!;
}

export async function enableUser(request: Request, actor: AdminActor, userId: string, reason: unknown): Promise<User> {
  const user = await getUser(userId);
  if (!user) throw new BadRequestError("No such user");
  const why = cleanReason(reason, false);
  if (!(await setUserDisabled(userId, null, null))) throw new BadRequestError("The account is not disabled");
  await recordAdminAction(request, actor, "user.enable", { kind: "user", id: userId }, why);
  return (await getUser(userId))!;
}

// --- sites --------------------------------------------------------------------------

async function liveSite(slug: string): Promise<Site> {
  const site = await getSiteBySlug(slug);
  if (!site || site.deletedAt) throw new BadRequestError("No such site");
  return site;
}

/** Stop serving the site to anyone but its owner, collaborators and administrators. Files untouched. */
export async function takeDownSite(request: Request, actor: AdminActor, slug: string, reason: unknown): Promise<Site> {
  const site = await liveSite(slug);
  const why = cleanReason(reason, true);
  if (!(await setSiteTakenDown(site.id, Date.now(), why))) throw new BadRequestError("The site is already taken down");
  await recordAdminAction(request, actor, "site.take_down", { kind: "site", id: site.id }, why);
  return (await getSite(site.id))!;
}

export async function restoreTakenDownSite(request: Request, actor: AdminActor, slug: string, reason: unknown): Promise<Site> {
  const site = await liveSite(slug);
  const why = cleanReason(reason, false);
  if (!(await setSiteTakenDown(site.id, null, null))) throw new BadRequestError("The site is not taken down");
  await recordAdminAction(request, actor, "site.restore", { kind: "site", id: site.id }, why);
  return (await getSite(site.id))!;
}

/** Administrative delete: the owner's delete without the owner. Soft, restorable for the retention window. */
export async function deleteSiteAsAdmin(request: Request, actor: AdminActor, slug: string, reason: unknown): Promise<Site> {
  const site = await liveSite(slug);
  const why = cleanReason(reason, true);
  await softDeleteSite(site.id);
  await recordAdminAction(request, actor, "site.delete", { kind: "site", id: site.id }, why);
  return (await getSite(site.id))!;
}

/** Undo a delete while the files are still there. */
export async function undeleteSite(request: Request, actor: AdminActor, slug: string, reason: unknown): Promise<Site> {
  const site = await getSiteBySlug(slug);
  if (!site || !site.deletedAt) throw new BadRequestError("The site is not deleted");
  if (site.purgedAt) throw new BadRequestError("The site's files were purged after the retention window; it cannot be restored");
  const why = cleanReason(reason, false);
  if (!(await restoreDeletedSite(site.id))) throw new BadRequestError("The site could not be restored");
  await recordAdminAction(request, actor, "site.undelete", { kind: "site", id: site.id }, why);
  return (await getSite(site.id))!;
}

// --- maintenance ----------------------------------------------------------------------

/**
 * Remove the files of sites deleted longer ago than the retention window and mark them purged.
 * Idempotent and safe to run from several replicas at once: removeSite tolerates a missing tree
 * and the purged_at update is conditional.
 */
export async function purgeDeletedSites(opts: { now?: number; retentionMs?: number; limit?: number } = {}): Promise<{ purged: number; errors: number }> {
  const now = opts.now ?? Date.now();
  const retention = opts.retentionMs ?? config.deletedRetentionMs;
  const result = { purged: 0, errors: 0 };
  for (const site of await listDeletedSitesBefore(now - retention, opts.limit ?? 100)) {
    try {
      await getStorage().removeSite(site.id);
      await setSitePurged(site.id, now);
      result.purged += 1;
    } catch (error) {
      result.errors += 1;
      console.error("[maintenance] purge failed for", site.id, error);
    }
  }
  return result;
}

/**
 * Soft-delete anonymous sites that nobody claimed and nobody touched for `config.anonSiteTtlMs`.
 * They then sit in the deleted view for the retention window like any other delete, so a mistaken
 * expiry is still an administrator's restore away. Off (a no-op) until the TTL is configured.
 * One log row per run that removed something, with the count as the reason.
 */
export async function expireAnonymousSitesJob(opts: { now?: number; ttlMs?: number; actor?: AdminActor; request?: Request | null } = {}): Promise<{ expired: number }> {
  const ttl = opts.ttlMs ?? policy.anonSiteTtlMs;
  if (!ttl) return { expired: 0 };
  const now = opts.now ?? Date.now();
  const gone = await expireAnonymousSites(now - ttl, now);
  if (gone.length) {
    await recordAdminAction(opts.request ?? null, opts.actor ?? SYSTEM_ACTOR, "maintenance.expire_anonymous", { kind: "system", id: "expire-anonymous" }, `${gone.length} site(s) past ${Math.round(ttl / 86_400_000)} days without changes`);
  }
  return { expired: gone.length };
}

const READ_COLLAPSE_MS = 60 * 60 * 1000;

/**
 * An administrator reading content they have no standing on. Written from the read gate itself,
 * so every door — page, item API, preview, versions, events, share page — is covered by the one
 * line; collapsed to one row per administrator, site and hour, because a page opening is one act
 * even though it arrives as the page plus every asset it references. The API-token administrator
 * is not recorded here: it resolves as owner of everything and is the operator's own credential.
 */
export async function recordAdminRead(request: Request, actor: AdminActor, site: Pick<Site, "id" | "visibility" | "takenDownAt">): Promise<void> {
  if (actor.kind !== "user") return;
  try {
    if (await hasRecentAdminLog(actor.userId, "site.view", site.id, Date.now() - READ_COLLAPSE_MS)) return;
    await recordAdminAction(request, actor, "site.view", { kind: "site", id: site.id }, site.takenDownAt ? "taken down" : site.visibility);
  } catch (error) {
    console.error("[admin] could not record a read:", error); // the read itself must not fail on bookkeeping
  }
}
