import { assertSessionCurrent } from "@/lib/authorized-commit";
import { rbacQuery, rbacTransaction } from "@/lib/db";
import { anonIdFromRequest } from "@/lib/anon";
import { AuthError, EditForbiddenError } from "@/lib/auth";
import { csrfSafe, resolveSession } from "@/lib/session";
import { recordRbacAudit, tenantActive } from "@/lib/rbac-access";
import { errorResponse, json } from "../../_util";
export async function GET(request: Request) {
  try {
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    const anonId = anonIdFromRequest(request);
    const sites = anonId && await tenantActive("anonymous")
      ? await rbacQuery(
          "SELECT slug,title FROM sites WHERE anon_owner_id=$1 AND owner_id IS NULL AND tenant_id='anonymous' AND deleted_at IS NULL",
          [anonId],
        )
      : [];
    return json({ sites });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");
    const body = await request.json();
    if (typeof body.tenantId !== "string" || body.tenantId === "anonymous")
      return json({ error: "Choose a destination tenant" }, 400);
    const anonId = anonIdFromRequest(request);
    if (!anonId)
      throw new EditForbiddenError(
        "Use the browser that created these artifacts",
      );
    const slugs = await rbacTransaction(async (q) => {
      await assertSessionCurrent(q, session);
      if (!await tenantActive("anonymous")) throw new EditForbiddenError("The anonymous tenant is disabled");
      const [member] = await q(
        "SELECT m.user_id FROM tenant_members m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2 AND t.disabled_at IS NULL",
        [session.userId, body.tenantId],
      );
      if (!member)
        throw new EditForbiddenError(
          "Active membership in the destination tenant is required",
        );
      const rows = await q(
        "UPDATE sites SET owner_id=$1,tenant_id=$2,edit_token='',claim_token=NULL,anon_owner_id=NULL,updated_at=$3 WHERE tenant_id='anonymous' AND anon_owner_id=$4 AND owner_id IS NULL AND deleted_at IS NULL AND taken_down_at IS NULL RETURNING id,slug",
        [session.userId, body.tenantId, Date.now(), anonId],
      );
      for (const site of rows) {
        await q(
          "UPDATE versions SET created_by=$1 WHERE site_id=$2 AND created_by IS NULL",
          [session.userId, site.id as string],
        );
        await recordRbacAudit(
          q,
          body.tenantId,
          session.userId,
          "site.claim.move",
          site.id as string,
          "anonymous to " + body.tenantId,
        );
      }
      return rows.map((r) => r.slug);
    });
    return json({ adopted: slugs.length, slugs });
  } catch (e) {
    return errorResponse(e);
  }
}
