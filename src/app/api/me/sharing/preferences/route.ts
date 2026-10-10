import { rbacQuery } from "@/lib/db";
import { z } from "zod";
import {
  getSharingPreference,
  setSharingPreference,
  sharingSession,
} from "@/lib/sharing-defaults";
import { sharingPolicySchema } from "@/lib/sharing-policy";
import { errorResponse, privateJson as json } from "@/app/api/_util";
export async function GET(request: Request) {
  try {
    const tenantId = new URL(request.url).searchParams.get("tenantId");
    if (!tenantId) {
      const session = await sharingSession(request);
      const [defaultTenant] = await rbacQuery(
        "SELECT t.id,t.name,t.disabled_at FROM users u JOIN tenants t ON t.id=u.tenant_id JOIN tenant_members m ON m.tenant_id=t.id AND m.user_id=u.id WHERE u.id=$1 AND t.id<>'anonymous'",
        [session.userId],
      );
      return json({
        defaultTenant: defaultTenant ? { id: defaultTenant.id, name: defaultTenant.name, disabledAt: defaultTenant.disabled_at } : null,
        tenants: await rbacQuery(
          "SELECT t.id,t.name FROM tenants t JOIN tenant_members m ON m.tenant_id=t.id WHERE m.user_id=$1 AND t.disabled_at IS NULL ORDER BY t.name,t.id",
          [session.userId],
        ),
      });
    }
    return json(await getSharingPreference(request, tenantId));
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(request: Request) {
  try {
    const body = z
      .object({
        tenantId: z.string().min(1),
        policy: sharingPolicySchema.nullable(),
      })
      .strict()
      .parse(await request.json());
    return json(
      await setSharingPreference(request, body.tenantId, body.policy),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
