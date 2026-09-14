// PATCH  /api/admin/sites/:slug  { takenDown: boolean, reason? }  take down / restore (files untouched)
//                                { deleted: false, reason? }      undo a delete within the retention window
// DELETE /api/admin/sites/:slug  { reason }                       soft-delete without the owner
import type { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSiteAsAdmin, requireAdminWrite, restoreTakenDownSite, takeDownSite, undeleteSite } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../../_util";
import { adminSite } from "../_shape";

const patch = z.union([
  z.object({ takenDown: z.boolean(), reason: z.string().max(500).optional() }),
  z.object({ deleted: z.literal(false), reason: z.string().max(500).optional() }),
]);
const del = z.object({ reason: z.string().max(500) });

export async function PATCH(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const { slug } = await context.params;
    const input = patch.parse(await request.json());
    const site = "takenDown" in input
      ? (input.takenDown ? await takeDownSite(request, actor, slug, input.reason) : await restoreTakenDownSite(request, actor, slug, input.reason))
      : await undeleteSite(request, actor, slug, input.reason);
    return json({ site: adminSite(site) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const actor = await requireAdminWrite(request);
    const { slug } = await context.params;
    const input = del.parse(await request.json().catch(() => ({})));
    const site = await deleteSiteAsAdmin(request, actor, slug, input.reason);
    return json({ site: adminSite(site) });
  } catch (error) {
    return errorResponse(error);
  }
}
