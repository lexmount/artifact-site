import type { CommentScope } from "@/lib/comments/contracts";
import { sameCommentScope } from "@/lib/comments/permissions";

/** Aggregation is a manager-only view; every thread retains its original discussion scope. */
export function canShowCommentScope(candidate: CommentScope, current: CommentScope, aggregate: boolean) {
  return sameCommentScope(candidate, current) || (aggregate && current.entry.kind === "main" && candidate.siteId === current.siteId && candidate.versionId === current.versionId);
}
export function shouldAggregateComments(scope: CommentScope, canAggregate: boolean, source: "all" | "main", focused: boolean) {
  return canAggregate && scope.entry.kind === "main" && source === "all" && !focused;
}
