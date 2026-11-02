import "server-only";
import { rbacQuery } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";

/** Identity admission only: callers own session, resource, liveness and version checks.
 * Resolve the verified address from the database, never from caller-supplied profile data.
 * An explicit query keeps admission inside a caller's authorization transaction.
 */
export async function sharePeopleAdmit(shareId: string, userId: string, q: RbacQuery = rbacQuery): Promise<boolean> {
  const rows = await q(
    "SELECT g.share_id FROM share_grants g JOIN users u ON u.id=$2 WHERE g.share_id=$1 AND (g.user_id=$2 OR (u.email_verified=TRUE AND u.email IS NOT NULL AND u.email<>'' AND g.email IS NOT NULL AND LOWER(g.email)=LOWER(u.email))) LIMIT 1",
    [shareId, userId],
  );
  return rows.length > 0;
}
