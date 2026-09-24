import "server-only";
import type { Row } from "@/lib/db";
export type RbacQuery = (
  sql: string,
  params?: readonly (string | number | null)[],
) => Promise<Row[]>;
export type RbacTransaction = <T>(
  work: (query: RbacQuery) => Promise<T>,
) => Promise<T>;
/** A removed member must not be re-added at the next login. NULL marks only new accounts. */
export async function initializeUserTenant(
  q: RbacQuery,
  userId: string,
): Promise<void> {
  const fresh = await q(
    "UPDATE users SET tenant_id='init' WHERE id=$1 AND tenant_id IS NULL RETURNING id",
    [userId],
  );
  if (fresh.length)
    await q(
      "INSERT INTO tenant_members (tenant_id,user_id) VALUES ('init',$1) ON CONFLICT DO NOTHING",
      [userId],
    );
}

/** Apply tenant scope before LIMIT, identically in both stores. */
export async function searchTenantUsers(query: RbacQuery, term: string, viewerId: string, limit: number): Promise<Row[]> {
  const pattern = `${term.replace(/[\\%_]/g, "\\$&")}%`;
  return query(`SELECT u.* FROM users u
      WHERE u.disabled_at IS NULL
        AND (lower(u.display_name) LIKE lower($1) ESCAPE '\\'
          OR (u.email_verified AND lower(u.email) LIKE lower($1) ESCAPE '\\'))
        AND EXISTS (SELECT 1 FROM tenant_members mine
          JOIN tenant_members other ON other.tenant_id=mine.tenant_id
          JOIN tenants t ON t.id=mine.tenant_id
          WHERE mine.user_id=$2 AND other.user_id=u.id AND t.disabled_at IS NULL)
      ORDER BY COALESCE(u.last_login_at,0) DESC,u.id LIMIT $3`, [pattern, viewerId, limit]);
}
