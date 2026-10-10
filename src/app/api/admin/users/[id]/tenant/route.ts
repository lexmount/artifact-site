import { z } from "zod";
import { requireAdminWrite } from "@/lib/admin";
import { changeDefaultTenant } from "@/lib/tenant-management";
import { errorResponse, json } from "@/app/api/_util";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdminWrite(request);
    const { tenantId } = z.object({ tenantId: z.string().min(1).max(200) }).strict().parse(await request.json());
    const { id } = await context.params;
    return json(await changeDefaultTenant(request, id, tenantId));
  } catch (error) { return errorResponse(error); }
}
