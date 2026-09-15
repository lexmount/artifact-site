import { managementReason } from "@/lib/management-reason";
// Resolve credentials into the shared role catalog; expose explicit action gates and UI permissions.
// Capability ranks remain a compatibility projection for existing internal callers. See docs/RBAC.md.
import { config } from "@/lib/config";
import { policy } from "@/lib/settings";
import { EditForbiddenError, editTokenFromRequest, isAdmin } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";
import { rbacQuery } from "@/lib/db";
import { accountSiteRole, managementRole, tenantActive, recordRbacAudit } from "@/lib/rbac-access";
import { PERMISSIONS, roleAllows, type ResourceRole, type Permission } from "@/lib/rbac";
import { forwardedProto } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import type { Actor, Capability, Session, Site } from "@/lib/types";

const RANK: Record<Capability, number> = { none: 0, content: 1, manage: 2, owner: 3 };

/** The browser that created this still-unclaimed site, by the cookie it was given at creation. */
export function isAnonymousCreator(viewer: Pick<Viewer, "anonId">, site: Pick<Site, "ownerId" | "anonOwnerId" | "tenantId">): boolean {
  return site.tenantId === "anonymous" && site.ownerId == null && Boolean(site.anonOwnerId) && Boolean(viewer.anonId) && safeEqual(viewer.anonId!, site.anonOwnerId!);
}

/** Capabilities are totally ordered — `owner` implies everything below it. */
export function atLeast(actual: Capability, required: Capability): boolean {
  return RANK[actual] >= RANK[required];
}

/** The three independent credentials a request may carry. All are optional and non-exclusive. */
export interface Viewer {
  request?: Request;
  /** Resolved browser login. Null for anonymous visitors. */
  session: Session | null;
  /** This browser's anonymous id, if it has one. */
  anonId: string | null;
  /** PUBLISH_API_TOKEN bearer — the machine/admin override. */
  isAdmin: boolean;
  /** LEGACY per-site token. Accepted only for reports in the anonymous tenant with no account owner. */
  editToken: string;
}

export function resolveViewer(request: Request, session: Session | null = null): Viewer {
  return { request, session, anonId: anonIdFromRequest(request), isAdmin: isAdmin(request), editToken: editTokenFromRequest(request) };
}

/** Just the accessor `next/headers` exposes — typed structurally so this module keeps out of next/*. */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}

/**
 * Rebuild a Request from a server component's `headers()`.
 *
 * Server components get no Request object, so a page that wants the same answer as the API routes
 * has to hand this module an equivalent one. Everything the authorization path actually reads is
 * carried across: the cookie header (session + anonymous id), the admin Bearer, and — load-bearing,
 * easy to miss — the SCHEME. `session.ts` and `anon.ts` only honour the `__Host-` cookie names over
 * HTTPS and fall back to unprefixed ones otherwise, so a hardcoded `https://` URL silently resolves
 * every visitor as anonymous on a plain-HTTP dev server. Absent `x-forwarded-proto` we assume https,
 * which is what production is; either way a mismatch fails CLOSED (the prefixed and unprefixed names
 * never collide, so the lookup just misses).
 *
 * `editToken` is threaded in as the `x-edit-token` header rather than by rewriting the URL, and the
 * URL's query is then dropped outright: `editTokenFromRequest` falls back to reading `?t=`, so a
 * caller that interpolates anything user-shaped into `path` (a slug, say) would otherwise be handing
 * that value a way to name a credential. Here every credential arrives as a header, full stop.
 */
export function requestFromHeaders(bag: HeaderBag, path: string, editToken?: string | null): Request {
  // Default https when the header is absent — the OPPOSITE of lib/http.isSecureRequest, for the
  // reason in the docblock above: this rebuilds what production (TLS) would have seen.
  const proto = forwardedProto(bag);
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "x-forwarded-proto", "x-artifact-share", "x-management-reason", "x-management-reason-encoding"]) {
    const value = bag.get(name);
    if (value) headers.set(name, value);
  }
  if (editToken) headers.set("x-edit-token", editToken);
  const origin = proto && proto !== "https" ? "http://server-component" : "https://server-component";
  const url = new URL(path, origin);
  url.search = "";
  url.hash = "";
  return new Request(url, { headers });
}

/**
 * requestFromHeaders plus what the VIEW LOG reads: the reader's address and agent (x-real-ip /
 * x-forwarded-for / user-agent) and the speculation markers (next-router-prefetch, sec-purpose,
 * purpose) that tell a real opening from a router prefetch. For the reader-facing pages —
 * /v/[token] and /s/[slug] — whose gates and logging must see one and the same request. The
 * authorization path reads none of these, so callers that only authorize lose nothing by
 * getting them too.
 */
export function viewerRequestFromHeaders(bag: HeaderBag, path: string): Request {
  const base = requestFromHeaders(bag, path);
  const merged = new Headers(base.headers);
  for (const name of ["x-real-ip", "x-forwarded-for", "user-agent", "next-router-prefetch", "sec-purpose", "purpose"]) {
    const value = bag.get(name);
    if (value) merged.set(name, value);
  }
  return new Request(base.url, { headers: merged });
}

export type CredentialSource = "account" | "operator" | "management" | "anonymous-cookie" | "anonymous-token" | "share" | "none";
export interface Authority { role: ResourceRole | null; source: CredentialSource }

/** Every credential enters the same role catalog. Presence alone never grants authority. */
export async function resolveAuthority(viewer: Viewer, site: Site): Promise<Authority> {
  const denied: Authority = { role: null, source: "none" };
  if (site.deletedAt || !(await tenantActive(site.tenantId))) return denied;
  if (viewer.isAdmin) return { role: "platform-admin", source: "operator" };
  const role = await accountSiteRole(site, viewer.session);
  if (role) return { role, source: "account" };
  if (viewer.request) {
    const manager = await managementRole(viewer.request, site, viewer.session);
    if (manager) return { role: manager, source: "management" };
  }
  // Anonymous management is never ownership evidence and never applies to account-tenant orphans.
  const anonymous = !site.ownerId && site.tenantId === "anonymous";
  if (anonymous && viewer.editToken && safeEqual(viewer.editToken, site.editToken)) {
    return { role: policy.anonymousSites === "read-only" ? "viewer" : "owner", source: "anonymous-token" };
  }
  if (anonymous && isAnonymousCreator(viewer, site)) {
    return { role: policy.anonymousSites === "read-only" ? "viewer" : "owner", source: "anonymous-cookie" };
  }
  if (viewer.request) {
    const { requestShareAccess } = await import("@/lib/share");
    const share = await requestShareAccess(viewer.request, site, viewer.session);
    if (share) return { role: share.mode === "edit" && !share.versionId && viewer.session ? "editor" : share.mode === "comment" ? "commenter" : "viewer", source: "share" };
  }
  return denied;
}

/** Compatibility projection for internal callers; the role catalog remains authoritative. */
export async function resolveCapability(viewer: Viewer, site: Site): Promise<Capability> {
  const { role } = await resolveAuthority(viewer, site);
  if (roleAllows(role, "site.delete")) return "owner";
  if (roleAllows(role, "site.rename")) return "manage";
  if (roleAllows(role, "site.content.edit")) return "content";
  return "none";
}

/** Human-readable 403 reason, so the UI can tell "sign in" apart from "you lack access". */
function reasonFor(viewer: Viewer, site: Site, required: Capability): string {
  if (!viewer.session) {
    if (isAnonymousCreator(viewer, site)) return "Sign in and explicitly claim this site in Workspaces";
    return "Please sign in first";
  }
  if (!site.ownerId) return "This site has no account owner; use the creating browser or ask an administrator to assign ownership";
  if (required === "owner") return "Only the site owner can do this";
  if (required === "manage") return "Only the owner or a site administrator can do this";
  return "You do not have edit access to this site";
}

/**
 * Gate a route. Returns the resolved capability so callers can branch further; the return value
 * being *used* is the point — an assertion that only threw on failure could be called without
 * `await` and would silently authorize everyone (the linter cannot see a floating void promise as
 * a bug, but it does flag an unused Promise<Capability>).
 */
export async function requireCapability(
  request: Request,
  site: Site,
  required: Capability,
  session?: Session | null,
): Promise<Capability> {
  return (await requireActor(request, site, required, session)).capability;
}

/**
 * The most we can honestly say about who is acting, for the audit trail. Priority reflects how
 * strong the evidence is: an admin token or a real login names a principal; an anonymous id names a
 * browser; a bare edit token (legacy regime) names nobody in particular, since several people can
 * hold a shared one. `userId`/`anonId` are recorded so a later claim can join them, not so the
 * historical row can be rewritten.
 */
export function resolveActor(viewer: Viewer): Actor {
  if (viewer.isAdmin) return { kind: "admin", userId: null, anonId: null };
  if (viewer.session) return { kind: "user", userId: viewer.session.userId, anonId: viewer.anonId };
  if (viewer.anonId) return { kind: "anon", userId: null, anonId: viewer.anonId };
  return { kind: "legacy-token", userId: null, anonId: null };
}

/**
 * Authorize AND identify in one pass — every mutation needs both, and resolving the session twice
 * (once to authorize, once to attribute) would be wasteful and could disagree. `requireCapability`
 * is the thin wrapper for callers that only need the gate.
 */
export async function requireActor(
  request: Request,
  site: Site,
  required: Capability,
  session?: Session | null,
): Promise<{ capability: Capability; actor: Actor; viewer: Viewer }> {
  const viewer = resolveViewer(request, session === undefined ? await resolveSession(request) : session);
  const cap = await resolveCapability(viewer, site);
  if (!atLeast(cap, required)) throw new EditForbiddenError(reasonFor(viewer, site, required));
  if (site.takenDownAt && !viewer.isAdmin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) throw new EditForbiddenError("This site has been taken down by an administrator");
  if (await managementRole(request, site, viewer.session)) {
    await recordRbacAudit(rbacQuery,site.tenantId,viewer.session?.userId ?? null,"site.management",site.id,(managementReason(request) ?? ""));
  }
  return { capability: cap, actor: resolveActor(viewer), viewer };
}

/**
 * What this viewer may do, as flags. The client renders affordances from THIS — never from a
 * locally-held token — because after identity landed only the server can know the answer, and a
 * button the user cannot actually use is worse than no button.
 */
export interface SitePermissions {
  canEditContent: boolean;
  canRename: boolean;
  canRollback: boolean;
  canManageSharing: boolean;
  canManageCollaborators: boolean;
  canDelete: boolean;
  canManageAdmins?: boolean;
  canReadSource?: boolean;
  // Open claiming is disabled; ownership transfer has its own authorization boundary.
  /** Why the write affordances are off, so the UI can say "sign in" vs "ask the owner". */
  reason: string | null;
  /** True when signing in is what would actually unlock this — lets the UI offer a login button
   *  instead of hiding the control, without the client having to infer it from `reason`. */
  needsLogin: boolean;
  /** @deprecated Always false; anonymous credentials never imply a claim. */
  legacyGrandfathered: boolean;
  /** @deprecated Always true; RBAC has no rollout switch. */
  enforced: boolean;
}

export async function describePermissions(
  request: Request,
  site: Site,
  session?: Session | null,
): Promise<SitePermissions> {
  const viewer = resolveViewer(request, session === undefined ? await resolveSession(request) : session);
  const { role } = await resolveAuthority(viewer, site);
  const writable = !site.takenDownAt || viewer.isAdmin;
  const allows = (permission: Permission) => roleAllows(role, permission);
  return {
    canEditContent: writable && allows("site.content.edit"),
    canRename: writable && allows("site.rename"),
    canRollback: writable && allows("site.version.rollback"),
    canManageSharing: writable && allows("site.sharing.manage"),
    canManageCollaborators: writable && allows("site.members.manage"),
    canManageAdmins: writable && allows("site.admins.manage"),
    canReadSource: allows("site.source.export"),
    canDelete: writable && allows("site.delete"),
    reason: site.takenDownAt && !viewer.isAdmin ? "This site has been taken down by an administrator" : allows("site.content.edit") ? null : reasonFor(viewer, site, "content"),
    needsLogin: config.oidcEnabled && !viewer.session && !allows("site.content.edit"),
    enforced: true,
    legacyGrandfathered: false,
  };
}

/** Explicit action gate; compatibility capabilities remain an implementation detail. */
export async function requirePermission(request: Request, site: Site, permission: Permission, session?: Session | null, audit = true) {
  if (!PERMISSIONS.includes(permission)) throw new EditForbiddenError(`Unsupported permission gate: ${permission}`);
  const viewer = resolveViewer(request, session === undefined ? await resolveSession(request) : session);
  const authority = await resolveAuthority(viewer, permission === "site.audit.read" ? {...site,deletedAt:null} : site);
  if (!roleAllows(authority.role, permission)) throw new EditForbiddenError(`Unsupported or denied permission: ${permission}`);
  const read = ["site.read", "site.history.read", "site.source.export", "site.audit.read"].includes(permission);
  if (!read && site.takenDownAt && !viewer.isAdmin) throw new EditForbiddenError("This site has been taken down by an administrator");
  if (audit && authority.source === "management") {
    await recordRbacAudit(rbacQuery, site.tenantId, viewer.session?.userId ?? null, "site.management", site.id, (managementReason(request) ?? ""));
  }
  return { capability: await resolveCapability(viewer, site), actor: resolveActor(viewer), viewer, ...authority };

}
