// POST /api/admin/reconcile — sweep orphaned version trees from storage. Administrators only (the
// API token, or a signed-in administrator), since it deletes files. `?dryRun=1` only reports.
import type { NextResponse } from "next/server";
import { requireAdminWrite } from "@/lib/admin";
import { reconcileOrphans } from "@/lib/reconcile";
import { errorResponse, json } from "../../_util";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await requireAdminWrite(request);
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const result = await reconcileOrphans({ dryRun });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
