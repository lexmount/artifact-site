import "server-only";
import { rbacQuery } from "@/lib/db";
import type { CommentScope } from "./contracts";
import type { Site } from "@/lib/types";
import { resolveCommentRecipientAccess } from "./access";
import { MENTION_CANDIDATE_LIMIT, type MentionCandidatePage } from "./mention-types";
import { describeCommentPermissions } from "./permissions";

export interface MentionAudienceContext {
  site: Site;
  scope: CommentScope;
  actorUserId: string;
}

export interface MentionCandidate {
  userId: string;
  label: string;
}
/** Providers discover candidates only. Final resource authorization is mandatory and shared by search
 * and commit validation, so future contacts/tenant policies cannot accidentally grant access. */
export interface MentionAudienceProvider {
  id: string;
  contains(context: MentionAudienceContext, userId: string): Promise<boolean>;
  search(
    context: MentionAudienceContext,
    query: string,
  ): Promise<MentionCandidate[]>;
}
const eligible = `(u.id=$4 OR EXISTS(SELECT 1 FROM authorization_site_members mem WHERE mem.site_id=$1 AND mem.user_id=u.id)
 OR EXISTS(SELECT 1 FROM comment_messages m JOIN comment_threads th ON th.id=m.thread_id JOIN comment_spaces sp ON sp.id=th.space_id
 WHERE m.author_user_id=u.id AND m.deleted_at IS NULL AND sp.site_id=$1 AND sp.version_id=$2 AND (sp.share_id=$3 OR (sp.share_id IS NULL AND $3 IS NULL))))`;
// Eliminate stale share participants before the bounded candidate page. This is only a
// discovery prefilter; canonical authorization below still checks current policy and grants.
const liveShareCandidate = `($3 IS NULL OR u.id=$4 OR EXISTS(
 SELECT 1 FROM authorization_site_members mem WHERE mem.site_id=$1 AND mem.user_id=u.id AND mem.role='admin')
 OR EXISTS(SELECT 1 FROM share_access_receipts r JOIN comment_spaces sp ON sp.id=r.space_id
 JOIN site_shares sh ON sh.id=sp.share_id JOIN sites s ON s.id=sp.site_id
 WHERE r.user_id=u.id AND sp.site_id=$1 AND sp.version_id=$2 AND sp.share_id=$3
 AND r.tenant_id=s.tenant_id AND r.revoked_at IS NULL AND r.expires_at>$7
 AND r.access_revision=sh.access_revision AND sh.revoked_at IS NULL
 AND (sh.expires_at IS NULL OR sh.expires_at>$7) AND sh.mode IN ('comment','edit')))`;
function params(c: MentionAudienceContext) {
  return [
    c.site.id,
    c.scope.versionId,
    c.scope.entry.kind === "share" ? c.scope.entry.shareId : null,
    c.site.ownerId,
  ];
}
const currentDiscussion: MentionAudienceProvider = {
  id: "discussion-participants-and-site-members",
  async contains(c, userId) {
    return Boolean(
      (
        await rbacQuery(
          `SELECT u.id FROM users u WHERE u.id=$5 AND u.disabled_at IS NULL AND ${eligible}`,
          [...params(c), userId],
        )
      ).length,
    );
  },
  async search(c, query) {
    return (
      await rbacQuery(
        `SELECT u.id,u.display_name FROM users u WHERE u.disabled_at IS NULL AND u.id<>$5 AND ${eligible} AND ${liveShareCandidate} AND LOWER(COALESCE(u.display_name,'')) LIKE $6 ESCAPE '!' ORDER BY u.display_name,u.id LIMIT ${MENTION_CANDIDATE_LIMIT}`,
        [
          ...params(c),
          c.actorUserId,
          "%" + query.toLowerCase().replace(/[!%_]/g, (s) => "!" + s) + "%",
          Date.now(),
        ],
      )
    ).flatMap((row) =>
      row.display_name
        ? [
            {
              userId: String(row.id),
              label: String(row.display_name).slice(0, 100),
            },
          ]
        : [],
    );
  },
};
/** Policy selection belongs here, never in the picker or notification delivery code. */
export function mentionAudiencePolicy(
  _context: MentionAudienceContext,
): readonly MentionAudienceProvider[] {
  void _context;
  return [currentDiscussion];
}
export async function mayMention(
  context: MentionAudienceContext,
  userId: string,
): Promise<boolean> {
  let inAudience = false;
  for (const provider of mentionAudiencePolicy(context))
    if (await provider.contains(context, userId)) {
      inAudience = true;
      break;
    }
  return (
    inAudience &&
    describeCommentPermissions(
      await resolveCommentRecipientAccess(context.site, context.scope, userId),
    ).canRead
  );
}
export async function mentionCandidatePage(
  context: MentionAudienceContext,
  query: string,
): Promise<MentionCandidatePage> {
  const candidates = new Map<string, MentionCandidate>();
  for (const provider of mentionAudiencePolicy(context)) {
    for (const candidate of await provider.search(context, query)) {
      if (
        candidate.userId !== context.actorUserId &&
        !candidates.has(candidate.userId)
      )
        candidates.set(candidate.userId, candidate);
      if (candidates.size >= MENTION_CANDIDATE_LIMIT) break;
    }
    if (candidates.size >= MENTION_CANDIDATE_LIMIT) break;
  }
  const items: MentionCandidate[] = [];
  // Search already establishes provider membership. Authorization remains mandatory, but its
  // work is capped before filtering rather than extending until 20 people happen to pass.
  for (const candidate of candidates.values()) {
    if (
      describeCommentPermissions(
        await resolveCommentRecipientAccess(
          context.site,
          context.scope,
          candidate.userId,
        ),
      ).canRead
    )
      items.push(candidate);
  }
  return { items, truncated: candidates.size >= MENTION_CANDIDATE_LIMIT };
}
export async function mentionCandidates(context: MentionAudienceContext, query: string) {
  return (await mentionCandidatePage(context, query)).items;
}
