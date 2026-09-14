// Graded write authorization. Every mutating route resolves a Capability and declares the level
// it needs. This exists because a boolean gate cannot express the one boundary the whole sharing
// model rests on: "may edit the content, must not delete the site". The previous design had four
// routes — rename, delete, edit, rollback — calling one identical assertCanEdit(request, site),
// so any tier allowed to edit was also allowed to delete.
//
// Background: ARCHITECTURE.md, "Authorization".
import { config } from "@/lib/config";
import { policy } from "@/lib/settings";
import { EditForbiddenError, editTokenFromRequest, isAdmin } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";
import { isCollaborator } from "@/lib/db";
import { forwardedProto } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import type { Actor, Capability, Session, Site } from "@/lib/types";

/**
 * A row that predates the identity migration. Every site created since carries a claim receipt at
 * birth, so a missing one is a durable marker — it stays true after the row is adopted, which is
 * what lets an adopted legacy site keep honouring the edit tokens its creator already handed out.
 * The owner ends that state deliberately, by rotating the link.
 */
function isPreIdentity(site: Site): boolean {
  return !site.claimToken && !site.anonOwnerId;
}

const RANK: Record<Capability, number> = { none: 0, content: 1, manage: 2, owner: 3 };

/** The browser that created this still-unclaimed site, by the cookie it was given at creation. */
export function isAnonymousCreator(viewer: Pick<Viewer, "anonId">, site: Pick<Site, "ownerId" | "anonOwnerId">): boolean {
  return site.ownerId == null && Boolean(site.anonOwnerId) && Boolean(viewer.anonId) && safeEqual(viewer.anonId!, site.anonOwnerId!);
}

/** Capabilities are totally ordered — `owner` implies everything below it. */
export function atLeast(actual: Capability, required: Capability): boolean {
  return RANK[actual] >= RANK[required];
}

/** The three independent credentials a request may carry. All are optional and non-exclusive. */
export interface Viewer {
  /** Resolved browser login. Null for anonymous visitors. */
  session: Session | null;
  /** This browser's anonymous id, if it has one. */
  anonId: string | null;
  /** PUBLISH_API_TOKEN bearer — the machine/admin override. */
  isAdmin: boolean;
  /** LEGACY per-site token. Only consulted while `enforceOwnership` is off (see below). */
  editToken: string;
}

export function resolveViewer(request: Request, session: Session | null = null): Viewer {
  return { session, anonId: anonIdFromRequest(request), isAdmin: isAdmin(request), editToken: editTokenFromRequest(request) };
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
  for (const name of ["cookie", "authorization", "x-forwarded-proto"]) {
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

/**
 * Resolve what this viewer may do to this site.
 *
 * Two regimes, selected by ARTIFACT_ENFORCE_OWNERSHIP, because a rolling upgrade briefly runs old
 * and new images side by side. While OFF we reproduce today's behaviour exactly, so a half-upgraded
 * fleet is self-consistent; flipping it ON is the second deploy, once every replica understands
 * ownership.
 */
export async function resolveCapability(viewer: Viewer, site: Site): Promise<Capability> {
  if (viewer.isAdmin) return "owner";

  if (!config.enforceOwnership) {
    // Legacy: whoever holds the site's edit token has full rights, which is what the product does
    // today. Deliberately unchanged so Deploy 1 is a pure schema change.
    return viewer.editToken && site.editToken && safeEqual(viewer.editToken, site.editToken) ? "owner" : "none";
  }

  if (!viewer.session) {
    // An anonymous creator keeps full control of what they made, identified by the browser cookie
    // they were given at creation. Without this, dropping a file in and immediately fixing a typo
    // would demand a login — and the anonymous drop is the product's whole entry point.
    if (site.ownerId == null && site.anonOwnerId && viewer.anonId && safeEqual(viewer.anonId, site.anonOwnerId)) {
      // The console (or ARTIFACT_ANONYMOUS_SITES) may keep anonymous creators to reading: the site
      // is theirs to look at, and every change asks for a sign-in — after which it is the account's.
      return policy.anonymousSites === "read-only" ? "none" : "owner";
    }
    // Grandfather clause for rows that predate identity. Their edit token was, at the time, the
    // only thing that meant anything — and it was handed out. Freezing them is a dead end (no
    // receipt to claim, no anon id to adopt, no admin token on an open deployment), so the token
    // keeps working. But how much it grants depends on whether anyone has taken responsibility:
    //
    //   unowned → owner:   nobody to protect, and this is exactly today's behaviour
    //   owned   → content: the holders the creator already shared with keep editing, while
    //                      renaming, deleting and sharing settle with the owner
    //
    // That second line is what makes adoption safe. Without it, the first token holder to sign in
    // would lock out everyone the creator had deliberately shared with.
    if (isPreIdentity(site) && viewer.editToken && site.editToken && safeEqual(viewer.editToken, site.editToken)) {
      return site.ownerId == null ? "owner" : "content";
    }
    // Everyone else writing anonymously is refused: an edit nobody can attribute leaves
    // versions.created_by empty and makes ownership, audit and revocation meaningless.
    return "none";
  }

  if (site.ownerId && viewer.session.userId === site.ownerId) return "owner";
  if (site.ownerId && (await isCollaborator(site.id, viewer.session.userId))) return "manage";

  // The open tier grants content edits ONLY. Not rename, not rollback, and emphatically not
  // delete — deleting removes the object-storage tree and is effectively irreversible, whereas an
  // edit just appends another immutable version that can be rolled back.
  if (site.editPolicy === "login") return "content";

  return "none";
}

/** Human-readable 403 reason, so the UI can tell "sign in" apart from "you lack access". */
function reasonFor(viewer: Viewer, site: Site, required: Capability): string {
  if (!config.enforceOwnership) return "You do not have edit access to this site (an editable link is required)";
  if (!viewer.session) {
    if (isAnonymousCreator(viewer, site)) return "Sign in to edit and share this site; it becomes yours the moment you do";
    return "Please sign in first";
  }
  if (!site.ownerId) return "This site has no account owner; use the creating browser or ask an administrator to assign ownership";
  if (required === "owner") return "Only the site owner can do this";
  if (required === "manage") return "Only the owner or a collaborator can do this";
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
  // Taken down: the owner keeps reading (and may fork the content elsewhere) but nothing changes
  // under this address until an administrator restores it.
  if (site.takenDownAt && !viewer.isAdmin) throw new EditForbiddenError("This site has been taken down by an administrator");
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
  // Open claiming is disabled; ownership transfer has its own authorization boundary.
  /** Why the write affordances are off, so the UI can say "sign in" vs "ask the owner". */
  reason: string | null;
  /** True when signing in is what would actually unlock this — lets the UI offer a login button
   *  instead of hiding the control, without the client having to infer it from `reason`. */
  needsLogin: boolean;
  /** True for a pre-identity row still running on its legacy edit token — the UI can invite the
   *  holder to sign in and take proper ownership instead of silently staying in limbo. */
  legacyGrandfathered: boolean;
  /** Whether ownership is being enforced at all. While off, the legacy link-sharing affordances
   *  still make sense; once on they contradict the model and must not be offered. */
  enforced: boolean;
}

export async function describePermissions(
  request: Request,
  site: Site,
  session?: Session | null,
): Promise<SitePermissions> {
  const viewer = resolveViewer(request, session === undefined ? await resolveSession(request) : session);
  const cap = await resolveCapability(viewer, site);
  return {
    canEditContent: atLeast(cap, "content"),
    canRename: atLeast(cap, "manage"),
    canRollback: atLeast(cap, "manage"),
    canManageSharing: atLeast(cap, "owner"),
    canManageCollaborators: atLeast(cap, "owner"),
    canDelete: atLeast(cap, "owner"),
    reason: cap === "none" ? reasonFor(viewer, site, "content") : null,
    // Only offer a login when one can actually succeed — enforceOwnership already implies a
    // configured IdP, but stating it here keeps the flag honest if the two ever decouple.
    needsLogin: config.enforceOwnership && config.oidcEnabled && !viewer.session && cap === "none",
    enforced: config.enforceOwnership,
    legacyGrandfathered: config.enforceOwnership && isPreIdentity(site) && cap !== "none",
  };
}
