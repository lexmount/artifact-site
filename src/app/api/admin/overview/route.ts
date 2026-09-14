// GET /api/admin/overview — the console's first screen: counts, storage, backends, recent acts.
import type { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { checkRateLimit } from "@/lib/ratelimit";
import { adminOverview, listAdminLog } from "@/lib/db";
import { describeRuntime } from "@/lib/runtime";
import { errorResponse, json } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request); // the aggregates below are the priciest reads in the app
    await requireAdmin(request);
    const [overview, recent] = await Promise.all([adminOverview(), listAdminLog({ limit: 20 })]);
    return json({ overview, runtime: describeRuntime(), recent });
  } catch (error) {
    return errorResponse(error);
  }
}
