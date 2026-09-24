import { receiptShare, sessionReceiptShare } from "@/lib/notifications/receipts";
import { rolePermissions } from "@/lib/role-bindings";
import { readerVersionAllowed } from "@/lib/version-access";
import "server-only";
import { rbacQuery, toSite, toShareRow } from "@/lib/db";
import { accountSiteRole, managementRole, recordRbacAudit } from "@/lib/rbac-access";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { resolveSession } from "@/lib/session";
import { AuthError } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";
import { sharePolicyAccess, hashToken, shareTokenFromRequest } from "@/lib/share";
import { SCOPE_WRITE } from "@/lib/oauth-shared";
import { managementReason } from "@/lib/management-reason";
import { isAnonymousCreator, resolveViewer } from "@/lib/authz";
import type { Session, Site } from "@/lib/types";
import type { CommentScope } from "./contracts";
import { describeCommentPermissions, type CommentAccessFacts } from "./permissions";

export class CommentNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() { super("Comment resource not found"); }
}

/** Database reads use rbacQuery so a mutation recheck shares the caller's RBAC transaction.
 * Resolve network-backed sessions before entering that transaction and pass the result here. */
export async function resolveCommentAccess(
  request: Request, site: Site, scope: CommentScope, existingSession?: Session | null,
): Promise<CommentAccessFacts> {
  const session = existingSession === undefined ? await resolveSession(request) : existingSession;
  return resolveCommentFacts(request,site,scope,session);
}
/** Recipient checks have no session, anonymous cookie or administrative elevation. */
export async function resolveCommentRecipientAccess(site: Site, scope: CommentScope, userId: string) {
  return resolveCommentFacts(new Request("https://recipient.invalid"),site,scope,null,userId);
}
async function resolveCommentFacts(request:Request,site:Site,scope:CommentScope,session:Session|null,recipientUserId?:string):Promise<CommentAccessFacts> {
  const identity = recipientUserId ? {userId:recipientUserId} : session;
  const denied: CommentAccessFacts = {
    scope, userId: identity?.userId ?? null, canReadArtifact: false, canReadMainArtifact: false,
    canWriteArtifactDiscussion: false, accountRole: null, managementRole: null,
    mainPolicy: "off", shareMode: null, permissions: [],
  };
  if (site.id !== scope.siteId) return denied;
  // Do not trust a stale Site object from a page or the pre-transaction read.
  const [row] = await rbacQuery("SELECT s.* FROM sites s JOIN tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.deleted_at IS NULL AND t.disabled_at IS NULL", [site.id]);
  if (!row) return denied;
  const current = toSite(row);
  const [version] = await rbacQuery("SELECT id FROM versions WHERE id=$1 AND site_id=$2", [scope.versionId, current.id]);
  if (!version) return denied;
  if (session) await assertSessionCurrent(rbacQuery, session);
  if (recipientUserId && !(await rbacQuery("SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL",[recipientUserId])).length) return denied;
  const account = await accountSiteRole(current, identity);
  const management = await managementRole(request, current, session);
  const accountRole = account;
  const elevated = management === "platform-admin" || management === "tenant-admin" ? management : null;
  const manager = elevated !== null || accountRole === "owner" || accountRole === "site-admin";
  // Ordinary artifact readers may access latest and the currently designated official snapshot.
  // This predicate is evaluated from the fresh site row and never grants arbitrary history.
  const readablePublicVersion = readerVersionAllowed(current, scope.versionId);
  // A separate no-share path: neither token carrier nor passcode cookies are consulted here.
  const mainReadable = Boolean((accountRole && (readablePublicVersion || (await rolePermissions(accountRole)).includes("site.history.read"))) || elevated || isAnonymousCreator(resolveViewer(request, session), current)
    || (!current.takenDownAt && current.visibility !== "private" && readablePublicVersion));
  const [settings] = await rbacQuery("SELECT main_policy FROM site_comment_settings WHERE site_id=$1", [current.id]);
  const mainPolicy = settings ? (settings.main_policy === "login" || settings.main_policy === "members" ? settings.main_policy : "off") : "login";
  let shareMode: CommentAccessFacts["shareMode"] = null;
  let shareExists = false;
  let shareReadable = false;
  if (scope.entry.kind === "share") {
    const [shareRow] = await rbacQuery("SELECT * FROM site_shares WHERE id=$1 AND site_id=$2", [scope.entry.shareId, current.id]);
    shareExists = Boolean(shareRow);
    if (shareRow) {
      const share = toShareRow(shareRow);
      const live = share.revokedAt === null && (share.expiresAt === null || share.expiresAt > Date.now())
        && !current.takenDownAt && readerVersionAllowed(current, scope.versionId, share.versionId);
      const token = shareTokenFromRequest(request);
      let admitted = manager;
      if (!admitted && live && token && safeEqual(hashToken(token), share.tokenHash)) {
        admitted = (await sharePolicyAccess(request, share, { session })).ok;
      }
      if (!admitted && live && !token) admitted = Boolean(recipientUserId ? await receiptShare(current,scope.versionId,recipientUserId,share.id) : await sessionReceiptShare(current,scope.versionId,session,share.id));
      shareReadable = live && admitted;
      if (shareReadable) shareMode = share.mode;
    }
  }
  return {
    scope, userId: identity?.userId ?? null, accountRole, managementRole: elevated, mainPolicy, shareMode,
    permissions: await rolePermissions(elevated ?? accountRole),
    canReadMainArtifact: mainReadable,
    canReadArtifact: scope.entry.kind === "main" ? mainReadable : shareExists && ((manager && mainReadable) || shareReadable),
    canWriteArtifactDiscussion: !current.takenDownAt && Boolean(session) && (!session?.scopes || session.scopes.includes(SCOPE_WRITE)),
  };
}

export async function requireCommentAccess(
  request: Request, site: Site, scope: CommentScope, session?: Session | null,
): Promise<CommentAccessFacts> {
  const facts = await resolveCommentAccess(request, site, scope, session);
  if (!describeCommentPermissions(facts).canRead) throw new CommentNotFoundError();
  return facts;
}

/** Call once at the authorized route boundary, not again during its transactional recheck. */
export async function auditCommentAccess(request: Request, site: Site, facts: CommentAccessFacts): Promise<void> {
  if (facts.managementRole) await recordRbacAudit(rbacQuery, site.tenantId, facts.userId, "comment.management", site.id, managementReason(request)!);
}

export function requireCommentIdentity(facts: CommentAccessFacts): string {
  if (!facts.userId) throw new AuthError("Please sign in to comment");
  return facts.userId;
}
