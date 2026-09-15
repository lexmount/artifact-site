// The audit trail's request-side helpers: what a mutation records about who did it and how, and
// the one place that turns that into a row. Split out of lib/sites so the verbs there stay about
// sites, and so a route that only needs to attribute an action (a share change, a claim) does
// not pull the whole upload/edit machinery along for the ride.
import { createId, insertAudit, type InsertAuditInput } from "@/lib/db";
import type { Actor, AuditAction, EditMethod } from "@/lib/types";

/** What a mutation needs to record about who did it and how — supplied by the route. */
export interface AuditContext {
  authorizationRequest?: Request;
  actor: Actor;
  method: EditMethod;
  ip: string | null;
  userAgent: string | null;
}

/** Client IP for the audit trail. Prefers `x-real-ip` (gateway-set to the peer address, not
 *  client-overridable), else the RIGHTMOST x-forwarded-for hop — the SAME resolution the rate
 *  limiter uses, so both share one documented trust model: these headers are only trustworthy
 *  because the deploy must keep the app port unreachable except through the gateway (see
 *  ratelimit.ts). A client with direct port access can forge them; that is a deploy invariant,
 *  not something this code can enforce. */
function clientIpForAudit(request: Request): string | null {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return null;
}

/** IP + a length-capped User-Agent for an audit row. UA is truncated so a client sending a
 *  megabyte header can't bloat every row it writes; 512 is far beyond any real UA. */
export function auditRequestMeta(request: Request): { ip: string | null; userAgent: string | null } {
  const ua = request.headers.get("user-agent");
  return { ip: clientIpForAudit(request), userAgent: ua ? ua.slice(0, 512) : null };
}

/** Build an AuditContext for a non-text action (create / fork / rollback / rename / delete / share)
 *  from a request and its resolved actor. `method: "api"` — none of these came through an editor. */
export function apiAuditContext(request: Request, actor: Actor): AuditContext {
  return { actor, method: "api", ...auditRequestMeta(request), authorizationRequest: request };
}

/**
 * Record an action that does NOT produce a version — rename, delete, a sharing change. Best-effort
 * and NON-atomic by nature: the change already happened in its own statement, and this appends a
 * trail row afterwards. A crash in the gap loses the trail row, not the action; that window is the
 * price of auditing actions with no transaction to ride along on. Never throws into the caller.
 */
export async function recordSiteAudit(siteId: string, action: AuditAction, ctx: AuditContext, versionId: string | null = null): Promise<void> {
  try {
    await insertAudit(auditRow(ctx, siteId, versionId, action));
  } catch (error) {
    console.error(`[audit] failed to record ${action} for ${siteId}:`, error);
  }
}

/** Build the audit row for a version-producing action. Kept here so every caller records the same
 *  shape and the actor's identity is copied verbatim (never re-derived, never mutable). */
export function auditRow(ctx: AuditContext, siteId: string, versionId: string | null, action: AuditAction): InsertAuditInput {
  return {
    id: createId("aud"),
    siteId,
    versionId,
    action,
    editorKind: ctx.actor.kind,
    actorUserId: ctx.actor.userId,
    actorAnonId: ctx.actor.anonId,
    ...(ctx.authorizationRequest ? { authorizationRequest: ctx.authorizationRequest } : {}),
    method: ctx.method,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}
