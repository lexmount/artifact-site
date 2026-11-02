// Account and tenant defaults apply to future documents; existing documents keep their snapshot.
import "server-only";
import { rbacQuery, rbacTransaction } from "@/lib/db";
import { sharingPolicySchema, type SharingPolicy } from "@/lib/sharing-policy";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { memberRole, requireTenantManager, recordRbacAudit } from "@/lib/rbac-access";
import { fail, sharingSession } from "@/lib/sharing-common";
import { effectiveSharingDefault } from "@/lib/sharing-read";
export async function getSharingPreference(
  request: Request,
  tenantId: string,
  tenant = false,
) {
  const session = await sharingSession(request);
  if (tenant) await requireTenantManager(request, tenantId);
  else if (!(await memberRole(tenantId, session.userId)))
    fail("Tenant not found", 404);
  return effectiveSharingDefault(
    rbacQuery,
    tenant ? "" : session.userId,
    tenantId,
  );
}
export async function setSharingPreference(
  request: Request,
  tenantId: string,
  input: SharingPolicy | null,
  tenant = false,
) {
  const session = await sharingSession(request, true);
  const parsed = input === null ? null : sharingPolicySchema.parse(input);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    if (tenant) await requireTenantManager(request, tenantId);
    else if (!(await memberRole(tenantId, session.userId)))
      fail("Tenant not found", 404);
    const userId = tenant ? "" : session.userId;
    if (!parsed)
      await q(
        "DELETE FROM sharing_defaults WHERE tenant_id=$1 AND user_id=$2",
        [tenantId, userId],
      );
    else
      await q(
        "INSERT INTO sharing_defaults(tenant_id,user_id,audience,comments,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,user_id) DO UPDATE SET audience=excluded.audience,comments=excluded.comments,updated_at=excluded.updated_at",
        [tenantId, userId, parsed.audience, +parsed.comments, Date.now()],
      );
    await recordRbacAudit(
      q,
      tenantId,
      session.userId,
      "sharing.defaults",
      userId || tenantId,
      JSON.stringify(parsed),
    );
    return effectiveSharingDefault(q, userId, tenantId);
  });
}
